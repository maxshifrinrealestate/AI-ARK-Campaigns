import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { findEmailsBatch } from "../functions/findEmail.js";
import { mapPool } from "../functions/mapPool.js";
import {
  leadNeedsTryKitt,
  processMaLeadRow,
  type MaProcessedLead,
  type MaRemovedLead
} from "../functions/processMaLeadRow.js";
import { resolveEspCampaign, type EspBucket } from "../functions/routeMaEspCampaign.js";
import {
  resolveWorkspaceId,
  uploadLeadsBatch,
  type PlusVibeLeadPayload
} from "../integrations/plusvibe.js";

type MaConfig = {
  product: { description: string };
  campaigns?: {
    esp?: {
      googleOthersCampaignId?: string;
      outlookCampaignId?: string;
      workspaceId?: string;
    };
  };
};

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function readConfig(p: string): MaConfig {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as MaConfig;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toUploadPayload(result: MaProcessedLead): PlusVibeLeadPayload {
  return {
    email: result.lead.email_business,
    custom_variables: {
      custom_cold_email: result.enriched.cold_email_html
    }
  };
}

async function uploadByCampaign(
  items: Array<{ payload: PlusVibeLeadPayload; campaignId: string; workspaceId: string }>,
  batchSize: number,
  uploadConcurrency: number
): Promise<{ ok: number; failed: number; errors: string[] }> {
  const byCampaign = new Map<string, PlusVibeLeadPayload[]>();
  let workspaceId = "";
  for (const item of items) {
    workspaceId = item.workspaceId;
    const list = byCampaign.get(item.campaignId) ?? [];
    list.push(item.payload);
    byCampaign.set(item.campaignId, list);
  }

  let ok = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const [campaignId, payloads] of byCampaign) {
    const batches: PlusVibeLeadPayload[][] = [];
    for (let i = 0; i < payloads.length; i += batchSize) {
      batches.push(payloads.slice(i, i + batchSize));
    }

    let campaignOk = 0;
    let campaignFailed = 0;
    await mapPool(batches, uploadConcurrency, async (batch, idx) => {
      const result = await uploadLeadsBatch(batch, { workspaceId, campaignId });
      if (result.ok) {
        campaignOk += batch.length;
      } else {
        campaignFailed += batch.length;
        if (errors.length < 30) errors.push(`campaign=${campaignId} batch=${idx + 1}: ${result.error}`);
      }
      await sleep(220);
    });
    ok += campaignOk;
    failed += campaignFailed;
    console.log(`[ma-full] uploaded campaign=${campaignId}: ok=${campaignOk} failed=${campaignFailed}`);
  }

  return { ok, failed, errors };
}

async function run(): Promise<void> {
  const input = argValue("--input") ?? "data/ma_leads_full.csv";
  const pilot = argValue("--count") ? Number(argValue("--count")) : 0;
  const outDir = path.resolve(argValue("--out-dir") ?? `ma_full_run_${Date.now()}`);
  const configPath = argValue("--config") ?? "configs/ma_advisory.json";
  const enrichConcurrency = Math.max(1, Number(argValue("--concurrency") ?? "5"));
  const uploadBatchSize = Math.max(1, Number(argValue("--upload-batch") ?? "10"));
  const uploadConcurrency = Math.max(1, Number(argValue("--upload-concurrency") ?? "4"));
  const skipUpload = hasFlag("--skip-upload");

  const googleCampaign =
    argValue("--google-campaign") ??
    process.env.MA_GOOGLE_CAMPAIGN_ID ??
    "6a3d1a4dc4b660db08122094";
  const outlookCampaign =
    argValue("--outlook-campaign") ??
    process.env.MA_OUTLOOK_CAMPAIGN_ID ??
    "6a3d1a5c000972b86ec4f15a";

  const missing: string[] = [];
  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!process.env.TRYKITT_API_KEY) missing.push("TRYKITT_API_KEY");
  if (!process.env.MILLIONVERIFIER_API_KEY) missing.push("MILLIONVERIFIER_API_KEY");
  if (!skipUpload && !process.env.PLUSVIBE_KEY) missing.push("PLUSVIBE_KEY");
  if (missing.length) {
    throw new Error(`Startup gate failed — missing: ${missing.join(", ")}`);
  }

  const config = readConfig(configPath);
  fs.mkdirSync(outDir, { recursive: true });

  const rows = parse(fs.readFileSync(input, "utf-8"), {
    columns: (h: string[]) => h.map((x) => x.trim()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as Record<string, string>[];

  const batch = pilot > 0 ? rows.slice(0, pilot) : rows;
  console.log(`[ma-full] loaded ${rows.length} rows, processing ${batch.length} from ${input}`);

  const trykittCache = new Map();
  const trykittItems = batch
    .map((raw, i) => ({ raw, i }))
    .filter(({ raw }) => leadNeedsTryKitt(raw))
    .map(({ raw, i }) => ({
      key: i,
      firstName: raw["First Name"] ?? raw.first_name,
      lastName: raw["Last Name"] ?? raw.last_name,
      companyName: raw["Company Name"] ?? raw.company_name ?? raw.Organization,
      companyWebsite: raw["Company Website"] ?? raw.company_website,
      personLinkedin: raw.LinkedIn ?? raw.linkedin
    }));

  if (trykittItems.length > 0) {
    console.log(`[ma-full] trykitt prefetch: ${trykittItems.length} leads`);
    const found = await findEmailsBatch(trykittItems);
    for (const [key, result] of found) trykittCache.set(Number(key), result);
    const hits = [...found.values()].filter((r) => r.email).length;
    console.log(`[ma-full] trykitt done: ${hits}/${trykittItems.length} emails found`);
  }

  let done = 0;
  const t0 = Date.now();
  const outcomes = await mapPool(batch, enrichConcurrency, async (raw, i) => {
    const outcome = await processMaLeadRow(raw, {
      productDescription: config.product.description,
      trykittCache,
      rowIndex: i
    });
    done++;
    if (done % 25 === 0 || done === batch.length) {
      const elapsed = (Date.now() - t0) / 1000;
      console.log(`[ma-full] enriched ${done}/${batch.length} (${(done / elapsed).toFixed(2)}/s)`);
    }
    return outcome;
  });

  const removed: MaRemovedLead[] = [];
  const enrichedResults: MaProcessedLead[] = [];

  for (const outcome of outcomes) {
    if (outcome.ok) enrichedResults.push(outcome.result);
    else removed.push(outcome.removed);
  }

  const enrichedCsv = enrichedResults.map((e) => ({
    email: e.lead.email_business,
    first_name: e.lead.first_name,
    last_name: e.lead.last_name,
    title: e.lead.title,
    company_name: e.lead.company_name,
    company_name_normalized: e.enriched.company_name_normalized,
    ma_service_type: e.enriched.ma_service_type,
    domain_settings: e.lead.domain_settings,
    esp_classification: e.lead.esp_classification,
    email_source: e.email_source,
    email_verification_status: e.email_verification_status ?? "",
    narrative_angle: e.enriched.narrative_angle,
    opening_line: e.enriched.opening_line,
    teaser: e.enriched.teaser,
    cta: e.enriched.cta,
    cold_email_html: e.enriched.cold_email_html,
    icp_summary: e.enriched.icp.portfolio_imagination,
    city: e.lead.city,
    state: e.lead.state,
    company_website: e.lead.company_website
  }));

  fs.writeFileSync(path.join(outDir, "enriched_leads.csv"), stringify(enrichedCsv, { header: true }));
  fs.writeFileSync(path.join(outDir, "removed_leads.csv"), stringify(removed, { header: true }));

  const dropsByReason = removed.reduce<Record<string, number>>((acc, r) => {
    acc[r.reason] = (acc[r.reason] ?? 0) + 1;
    return acc;
  }, {});

  const smtp = enrichedResults.filter((e) => e.lead.domain_settings === "SMTP").length;
  const catchAll = enrichedResults.filter((e) => e.lead.domain_settings === "CatchAll").length;
  const trykit = enrichedResults.filter((e) => e.email_source === "trykit").length;
  const espCounts: Record<EspBucket, number> = { outlook: 0, google_others: 0 };

  const workspaceId =
    config.campaigns?.esp?.workspaceId?.trim() ||
    process.env.PLUSVIBE_WORKSPACE_ID?.trim() ||
    (await resolveWorkspaceId("zs").catch(() => ""));

  if (!skipUpload && !workspaceId) {
    throw new Error("Could not resolve PlusVibe workspace ID");
  }

  const uploadItems: Array<{
    payload: PlusVibeLeadPayload;
    campaignId: string;
    workspaceId: string;
    bucket: EspBucket;
  }> = [];

  for (const result of enrichedResults) {
    const route = resolveEspCampaign(result.lead.esp_classification, {
      googleOthersCampaignId: googleCampaign,
      outlookCampaignId: outlookCampaign,
      workspaceId
    });
    espCounts[route.bucket]++;
    if (!skipUpload) {
      uploadItems.push({
        payload: toUploadPayload(result),
        campaignId: route.campaignId,
        workspaceId: route.workspaceId,
        bucket: route.bucket
      });
    }
  }

  let uploadReport = { ok: 0, failed: 0, errors: [] as string[] };
  const uploadErrors: Array<{ email: string; campaign_id: string; error_message: string }> = [];

  if (!skipUpload) {
    console.log(
      `[ma-full] uploading script-only: google/others=${espCounts.google_others} → ${googleCampaign}, outlook=${espCounts.outlook} → ${outlookCampaign}`
    );
    uploadReport = await uploadByCampaign(uploadItems, uploadBatchSize, uploadConcurrency);
    if (uploadReport.errors.length) {
      for (const err of uploadReport.errors) {
        uploadErrors.push({ email: "", campaign_id: "", error_message: err });
      }
    }
    fs.writeFileSync(path.join(outDir, "upload_errors.csv"), stringify(uploadErrors, { header: true }));
  }

  const summary = {
    input_rows: batch.length,
    enriched: enrichedResults.length,
    removed: removed.length,
    routing: {
      smtp,
      catchAll,
      trykit,
      esp: espCounts,
      campaigns: {
        google_others: googleCampaign,
        outlook: outlookCampaign
      }
    },
    drops_by_reason: dropsByReason,
    upload: skipUpload ? "skipped" : uploadReport,
    workspace_id: workspaceId || null,
    elapsed_seconds: ((Date.now() - t0) / 1000).toFixed(1),
    out_dir: outDir
  };

  fs.writeFileSync(path.join(outDir, "run_summary.json"), JSON.stringify(summary, null, 2));

  console.log(`[ma-full] complete: enriched=${enrichedResults.length} removed=${removed.length}`);
  console.log(
    `[ma-full] ESP routing: google/others=${espCounts.google_others} outlook=${espCounts.outlook}`
  );
  if (!skipUpload) {
    console.log(`[ma-full] upload: ok=${uploadReport.ok} failed=${uploadReport.failed}`);
  }
  console.log(`[ma-full] artifacts → ${outDir}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
