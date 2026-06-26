import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { enrichMaLeadFast } from "../functions/enrichMaLeadFast.js";
import { mapPool } from "../functions/mapPool.js";

type LeadRow = Record<string, string>;

type MaConfig = {
  product: { description: string };
  limits?: { openaiConcurrency?: number };
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

function normalizeHeaders(header: string[]): string[] {
  return header.map((h) =>
    h.trim().toLowerCase().replace(/\s+/g, "_").replace(/_+/g, "_")
  );
}

function mapLeadRow(row: LeadRow): LeadRow {
  const mapped = { ...row };
  if (row.company_product_and_services && !row.company_products_services) {
    mapped.company_products_services = row.company_product_and_services;
  }
  return mapped;
}

async function run(): Promise<void> {
  const input = argValue("--input") ?? "data/ma_leads.csv";
  const output = argValue("--output") ?? "data/ma_leads_enriched.csv";
  const configPath = argValue("--config") ?? "configs/ma_advisory.json";
  const start = Number(argValue("--start") ?? "0");
  const pilotRaw = argValue("--pilot");
  const pilot = pilotRaw ? Number(pilotRaw) : undefined;
  const quiet = hasFlag("--quiet");
  const review = hasFlag("--review");

  const concurrency = Math.max(
    1,
    Number(argValue("--concurrency") ?? process.env.MA_CONCURRENCY ?? process.env.ROW_CONCURRENCY ?? "80")
  );

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const config = readConfig(configPath);
  const raw = fs.readFileSync(input, "utf-8");
  const leadsAll = (parse(raw, {
    columns: normalizeHeaders,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as LeadRow[]).map(mapLeadRow);

  let leads = start > 0 ? leadsAll.slice(start) : leadsAll;
  if (pilot && pilot > 0) leads = leads.slice(0, pilot);

  const t0 = Date.now();
  console.log(
    `[enrich-ma-fast] ${leads.length} leads | concurrency=${concurrency} | 1 API call/lead | start=${start}`
  );

  let done = 0;
  const results = await mapPool(leads, concurrency, async (lead, i) => {
    const enriched = await enrichMaLeadFast(
      {
        first_name: lead.first_name,
        last_name: lead.last_name,
        title: lead.title,
        company_name: lead.company_name,
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
    if (!quiet && (done % 50 === 0 || done === leads.length)) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(1);
      console.log(`[enrich-ma-fast] ${done}/${leads.length} (${elapsed}s, ${rate}/s)`);
    } else if (!quiet && leads.length <= 25) {
      console.log(
        `[${i + 1}] ${lead.first_name} @ ${lead.company_name} | ${enriched.ma_service_type} | ${enriched.teaser}`
      );
    }

    return {
      first_name: lead.first_name ?? "",
      last_name: lead.last_name ?? "",
      title: lead.title ?? "",
      company_name: lead.company_name ?? "",
      company_name_normalized: enriched.company_name_normalized,
      ma_service_type: enriched.ma_service_type,
      icp_portfolio_imagination: enriched.icp_portfolio_imagination,
      icp_target_industries: enriched.icp_target_industries,
      icp_deal_sizes: enriched.icp_deal_sizes,
      icp_company_types: enriched.icp_company_types,
      icp_deal_types: enriched.icp_deal_types,
      opening_line: enriched.opening_line,
      teaser: enriched.teaser,
      cta: enriched.cta,
      cold_email_html: enriched.cold_email_html,
      email_business: lead.email_business ?? "",
      company_website: lead.company_website ?? "",
      city: lead.city ?? "",
      state: lead.state ?? "",
      company_size: lead.company_size ?? "",
      company_industry: lead.company_industry ?? ""
    };
  });

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, stringify(results, { header: true }));

  if (review && results.length <= 100) {
    const htmlOut = output.replace(/\.csv$/i, "_review.html");
    const htmlBody = results
      .map(
        (r, idx) => `
    <section style="margin-bottom:1.5rem;padding:1rem;border:1px solid #ddd;">
      <h3>${idx + 1}. ${r.first_name} ${r.last_name} — ${r.company_name}</h3>
      <p><strong>ICP:</strong> ${r.icp_portfolio_imagination}</p>
      <p><strong>Teaser:</strong> ${r.teaser}</p>
      <div style="background:#f7f7f7;padding:0.75rem;">${r.cold_email_html}</div>
    </section>`
      )
      .join("\n");
    fs.writeFileSync(
      htmlOut,
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>M&A Preview</title></head><body style="font-family:sans-serif;max-width:800px;margin:2rem auto;">${htmlBody}</body></html>`
    );
    console.log(`[enrich-ma-fast] review: ${htmlOut}`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const rate = (results.length / ((Date.now() - t0) / 1000)).toFixed(2);
  console.log(`[enrich-ma-fast] done: ${results.length} rows → ${output} (${elapsed}s, ${rate} leads/s)`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
