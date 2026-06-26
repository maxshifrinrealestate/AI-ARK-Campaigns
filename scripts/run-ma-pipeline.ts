import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { enrichMaLeadFast } from "../functions/enrichMaLeadFast.js";
import { gateMaLead, type PreparedMaLead } from "../functions/prepareMaSheet.js";
import { mapPool } from "../functions/mapPool.js";
import { resolveWorkspaceId, uploadLeadsBatch, type PlusVibeLeadPayload } from "../integrations/plusvibe.js";

type MaConfig = {
  product: { description: string };
  campaigns: { smtp: { workspaceId?: string; campaignId: string }; catchAll?: { campaignId?: string } };
  limits?: { openaiConcurrency?: number; uploadConcurrency?: number };
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

function toPlusVibePayload(lead: PreparedMaLead, enriched: Awaited<ReturnType<typeof enrichMaLeadFast>>): PlusVibeLeadPayload {
  return {
    email: lead.email_business,
    first_name: lead.first_name || undefined,
    last_name: lead.last_name || undefined,
    company_name: enriched.company_name_normalized || lead.company_name || undefined,
    company_website: lead.company_website || undefined,
    linkedin_person_url: lead.linkedin || undefined,
    linkedin_company_url: lead.company_linkedin || undefined,
    city: lead.city || undefined,
    country: lead.country || undefined,
    custom_variables: {
      custom_ma_service_type: enriched.ma_service_type,
      custom_teaser: enriched.teaser,
      custom_cta: enriched.cta,
      custom_cold_email: enriched.cold_email_html,
      custom_esp: lead.esp_classification,
      custom_domain_settings: lead.domain_settings,
      custom_icp_summary: enriched.icp_portfolio_imagination
    }
  };
}

async function uploadBatches(
  payloads: PlusVibeLeadPayload[],
  workspaceId: string,
  campaignId: string,
  batchSize: number,
  uploadConcurrency: number
): Promise<{ ok: number; failed: number; errors: string[] }> {
  const batches: PlusVibeLeadPayload[][] = [];
  for (let i = 0; i < payloads.length; i += batchSize) {
    batches.push(payloads.slice(i, i + batchSize));
  }

  let ok = 0;
  let failed = 0;
  const errors: string[] = [];

  await mapPool(batches, uploadConcurrency, async (batch, idx) => {
    const result = await uploadLeadsBatch(batch, { workspaceId, campaignId });
    if (result.ok) {
      ok += batch.length;
    } else {
      failed += batch.length;
      if (errors.length < 20) errors.push(`batch ${idx + 1}: ${result.error}`);
    }
    await sleep(220);
  });

  return { ok, failed, errors };
}

async function run(): Promise<void> {
  const input = argValue("--input") ?? "data/ma_leads.csv";
  const outDir = path.resolve(argValue("--out-dir") ?? `ma_run_${Date.now()}`);
  const configPath = argValue("--config") ?? "configs/ma_advisory.json";
  const campaignId = argValue("--campaign") ?? "6a3a8367b0baf820fe011afb";
  const workspaceName = argValue("--workspace") ?? "zs";
  const enrichOnly = hasFlag("--enrich-only");
  const uploadOnly = hasFlag("--upload-only");
  const skipUpload = hasFlag("--skip-upload");
  const enrichedInput = argValue("--enriched");

  const enrichConcurrency = Math.max(
    1,
    Number(argValue("--concurrency") ?? process.env.MA_CONCURRENCY ?? "80")
  );
  const uploadBatchSize = Math.max(1, Number(argValue("--upload-batch") ?? "10"));
  const uploadConcurrency = Math.max(1, Number(argValue("--upload-concurrency") ?? "4"));

  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");

  const config = readConfig(configPath);
  fs.mkdirSync(outDir, { recursive: true });

  const raw = fs.readFileSync(input, "utf-8");
  const rows = parse(raw, {
    columns: (h: string[]) => h.map((x) => x.trim()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as Record<string, string>[];

  console.log(`[ma-pipeline] loaded ${rows.length} rows from ${input}`);

  const removed: Array<Record<string, string>> = [];
  const eligible: PreparedMaLead[] = [];

  for (const row of rows) {
    const gate = gateMaLead(row);
    if (!gate.ok) {
      removed.push({
        email: gate.email,
        reason: gate.reason,
        detail: gate.detail ?? "",
        company_name: clean(row.company_name ?? row["Company Name"])
      });
      continue;
    }
    eligible.push(gate.lead);
  }

  const smtp = eligible.filter((l) => l.domain_settings === "SMTP").length;
  const catchAll = eligible.filter((l) => l.domain_settings === "CatchAll").length;
  const google = eligible.filter((l) => l.esp_classification === "google").length;
  const outlook = eligible.filter((l) => l.esp_classification === "outlook").length;
  const others = eligible.filter((l) => l.esp_classification === "others").length;

  console.log(
    `[ma-pipeline] gated: eligible=${eligible.length} (SMTP=${smtp}, CatchAll=${catchAll}) | google=${google} outlook=${outlook} others=${others} | removed=${removed.length}`
  );

  fs.writeFileSync(path.join(outDir, "removed_leads.csv"), stringify(removed, { header: true }));

  let enrichedRows: Array<{ lead: PreparedMaLead; enriched: Awaited<ReturnType<typeof enrichMaLeadFast>> }> =
    [];

  if (uploadOnly && enrichedInput) {
    const prev = parse(fs.readFileSync(enrichedInput, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
      bom: true
    }) as Record<string, string>[];
    for (const row of prev) {
      const email = clean(row.email ?? row.email_business).toLowerCase();
      if (!email) continue;
      const lead: PreparedMaLead = {
        raw: row,
        first_name: clean(row.first_name),
        last_name: clean(row.last_name),
        title: clean(row.title),
        email_business: email,
        domain_settings: clean(row.domain_settings) || "SMTP",
        company_name: clean(row.company_name),
        company_name_normalized: clean(row.company_name_normalized) || clean(row.company_name),
        company_description: clean(row.company_description),
        company_products_services: clean(row.company_products_services),
        company_industry: clean(row.company_industry),
        company_size: clean(row.company_size),
        company_website: clean(row.company_website),
        company_linkedin: clean(row.company_linkedin),
        city: clean(row.city),
        state: clean(row.state),
        country: clean(row.country),
        linkedin: clean(row.linkedin),
        email_platform: clean(row.email_platform),
        esp_classification: clean(row.esp_classification) || "others"
      };
      enrichedRows.push({
        lead,
        enriched: {
          company_name_normalized: clean(row.company_name_normalized) || lead.company_name,
          ma_service_type: clean(row.ma_service_type),
          icp_portfolio_imagination: clean(row.icp_portfolio_imagination),
          icp_target_industries: clean(row.icp_target_industries),
          icp_deal_sizes: clean(row.icp_deal_sizes),
          icp_company_types: clean(row.icp_company_types),
          icp_deal_types: clean(row.icp_deal_types),
          opening_line: clean(row.opening_line),
          teaser: clean(row.teaser),
          cta: clean(row.cta),
          cold_email_html: clean(row.cold_email_html)
        }
      });
    }
    console.log(`[ma-pipeline] upload-only: loaded ${enrichedRows.length} rows from ${enrichedInput}`);
  } else {
    const t0 = Date.now();
    let done = 0;
    enrichedRows = await mapPool(eligible, enrichConcurrency, async (lead) => {
      const enriched = await enrichMaLeadFast(
        {
          first_name: lead.first_name,
          last_name: lead.last_name,
          title: lead.title,
          company_name: lead.company_name,
          company_name_normalized: lead.company_name_normalized,
          company_description: lead.company_description,
          company_products_services: lead.company_products_services,
          company_industry: lead.company_industry,
          company_size: lead.company_size,
          city: lead.city,
          state: lead.state,
          country: lead.country,
          company_website: lead.company_website,
          company_linkedin: lead.company_linkedin
        },
        config.product.description
      );

      done++;
      if (done % 100 === 0 || done === eligible.length) {
        const elapsed = (Date.now() - t0) / 1000;
        console.log(`[ma-pipeline] enriched ${done}/${eligible.length} (${(done / elapsed).toFixed(1)}/s)`);
      }

      return { lead, enriched };
    });

    const enrichedCsv = enrichedRows.map(({ lead, enriched }) => ({
      email: lead.email_business,
      first_name: lead.first_name,
      last_name: lead.last_name,
      title: lead.title,
      company_name: lead.company_name,
      company_name_normalized: enriched.company_name_normalized,
      ma_service_type: enriched.ma_service_type,
      domain_settings: lead.domain_settings,
      esp_classification: lead.esp_classification,
      email_platform: lead.email_platform,
      icp_portfolio_imagination: enriched.icp_portfolio_imagination,
      icp_target_industries: enriched.icp_target_industries,
      opening_line: enriched.opening_line,
      teaser: enriched.teaser,
      cta: enriched.cta,
      cold_email_html: enriched.cold_email_html,
      city: lead.city,
      state: lead.state,
      company_website: lead.company_website
    }));

    fs.writeFileSync(path.join(outDir, "enriched_leads.csv"), stringify(enrichedCsv, { header: true }));
    console.log(`[ma-pipeline] wrote enriched_leads.csv (${enrichedRows.length} rows)`);
  }

  const t0 = Date.now();

  if (enrichOnly || skipUpload) {
    console.log(`[ma-pipeline] enrich-only complete → ${outDir}`);
    return;
  }

  if (!process.env.PLUSVIBE_KEY) {
    throw new Error("PLUSVIBE_KEY required for upload. Re-run with key set or use --enrich-only.");
  }

  const workspaceId =
    (await resolveWorkspaceId(workspaceName).catch(() => "")) ||
    process.env.PLUSVIBE_WORKSPACE_ID?.trim() ||
    "";
  if (!workspaceId) {
    throw new Error(
      `Could not resolve PlusVibe workspace "${workspaceName}". Set PLUSVIBE_WORKSPACE_ID in .env or fix PLUSVIBE_KEY.`
    );
  }
  console.log(`[ma-pipeline] uploading to workspace=${workspaceId} campaign=${campaignId}`);

  const payloads = enrichedRows.map(({ lead, enriched }) => toPlusVibePayload(lead, enriched));

  const uploadReport = await uploadBatches(
    payloads,
    workspaceId,
    campaignId,
    uploadBatchSize,
    uploadConcurrency
  );

  const summary = {
    input_rows: rows.length,
    eligible: eligible.length,
    enriched: enrichedRows.length,
    removed: removed.length,
    routing: { smtp, catchAll, google, outlook, others },
    upload: uploadReport,
    workspace_id: workspaceId,
    campaign_id: campaignId,
    elapsed_seconds: ((Date.now() - t0) / 1000).toFixed(1)
  };

  fs.writeFileSync(path.join(outDir, "run_summary.json"), JSON.stringify(summary, null, 2));
  console.log(`[ma-pipeline] upload done: ok=${uploadReport.ok} failed=${uploadReport.failed}`);
  console.log(`[ma-pipeline] artifacts → ${outDir}`);
}

function clean(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
