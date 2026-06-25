import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { findEmailsBatch } from "../functions/findEmail.js";
import { mapPool } from "../functions/mapPool.js";
import {
  leadNeedsTryKitt,
  processMaLeadRow
} from "../functions/processMaLeadRow.js";

type MaConfig = {
  product: { description: string };
};

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function readConfig(p: string): MaConfig {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as MaConfig;
}

async function run(): Promise<void> {
  const input = argValue("--input") ?? "data/ma_test_25.csv";
  const count = Math.max(1, Number(argValue("--count") ?? "25"));
  const outDir = path.resolve(argValue("--out-dir") ?? `ma_test_run_${Date.now()}`);
  const configPath = argValue("--config") ?? "configs/ma_advisory.json";
  const enrichConcurrency = Math.max(1, Number(argValue("--concurrency") ?? "3"));

  const missing: string[] = [];
  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!process.env.TRYKITT_API_KEY) missing.push("TRYKITT_API_KEY");
  if (!process.env.MILLIONVERIFIER_API_KEY) missing.push("MILLIONVERIFIER_API_KEY");
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

  const batch = rows.slice(0, count);
  console.log(`[ma-test] loaded ${rows.length} rows, processing first ${batch.length} from ${input}`);

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
    console.log(`[ma-test] trykitt prefetch: ${trykittItems.length} leads`);
    const found = await findEmailsBatch(trykittItems);
    for (const [key, result] of found) trykittCache.set(Number(key), result);
    const hits = [...found.values()].filter((r) => r.email).length;
    console.log(`[ma-test] trykitt done: ${hits}/${trykittItems.length} emails found`);
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
    console.log(
      `[ma-test] ${done}/${batch.length} ${outcome.ok ? "enriched" : `removed:${outcome.removed.reason}`} — ${raw["First Name"] ?? raw.first_name} ${raw["Last Name"] ?? raw.last_name}`
    );
    return outcome;
  });

  const removed: import("../functions/processMaLeadRow.js").MaRemovedLead[] = [];
  const enrichedResults: import("../functions/processMaLeadRow.js").MaProcessedLead[] = [];

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

  const summary = {
    input_rows: batch.length,
    enriched: enrichedResults.length,
    removed: removed.length,
    routing: { smtp, catchAll, trykit },
    drops_by_reason: dropsByReason,
    upload: "skipped",
    elapsed_seconds: ((Date.now() - t0) / 1000).toFixed(1),
    out_dir: outDir
  };

  fs.writeFileSync(path.join(outDir, "run_summary.json"), JSON.stringify(summary, null, 2));

  console.log(`[ma-test] complete: enriched=${enrichedResults.length} removed=${removed.length}`);
  console.log(`[ma-test] routing SMTP=${smtp} CatchAll=${catchAll} trykit=${trykit}`);
  console.log(`[ma-test] artifacts → ${outDir}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
