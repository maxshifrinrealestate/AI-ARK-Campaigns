import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { classifyMaServiceType } from "../functions/classifyMaServiceType.js";
import { enrichMaIcp } from "../functions/enrichMaIcp.js";
import {
  enrichMaOutreach,
  pushToBatchContext,
  type MaOutreachBatchContext
} from "../functions/enrichMaOutreach.js";
import { normalizeCompany } from "../functions/normalizeCompany.js";

type LeadRow = Record<string, string>;

type MaConfig = {
  vertical: string;
  company: { name?: string; description: string };
  product: { name?: string; description: string };
  limits?: { openaiConcurrency?: number };
};

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function readConfig(p: string): MaConfig {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as MaConfig;
}

function normalizeHeaders(header: string[]): string[] {
  return header.map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
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
  const pilot = Number(argValue("--pilot") ?? "25");

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required. Set it in .env or environment.");
  }

  const config = readConfig(configPath);
  const raw = fs.readFileSync(input, "utf-8");
  const leads = (parse(raw, {
    columns: normalizeHeaders,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as LeadRow[]).map(mapLeadRow);

  const slice = leads.slice(0, pilot);
  const batchCtx: MaOutreachBatchContext = { recentOpenings: [], recentCtas: [] };
  const results: Record<string, string>[] = [];

  console.log(`[enrich-ma] processing ${slice.length} leads sequentially for uniqueness`);

  for (let i = 0; i < slice.length; i++) {
    const lead = slice[i]!;
    const companyNameNormalized = await normalizeCompany(lead.company_name);
    const maServiceType = await classifyMaServiceType({
      companyNameNormalized,
      companyDescription: lead.company_description,
      companyProductsServices: lead.company_products_services,
      title: lead.title,
      companyWebsite: lead.company_website
    });

    const maIcp = await enrichMaIcp({
      company_name_normalized: companyNameNormalized,
      company_description: lead.company_description,
      company_products_services: lead.company_products_services,
      company_industry: lead.company_industry,
      title: lead.title,
      city: lead.city,
      state: lead.state,
      ma_service_type: maServiceType
    });

    const outreach = await enrichMaOutreach(
      {
        first_name: lead.first_name,
        last_name: lead.last_name,
        title: lead.title,
        company_name: lead.company_name,
        company_name_normalized: companyNameNormalized,
        company_description: lead.company_description,
        company_products_services: lead.company_products_services,
        company_industry: lead.company_industry,
        company_size: lead.company_size,
        city: lead.city,
        state: lead.state,
        country: lead.country,
        company_website: lead.company_website,
        company_linkedin: lead.company_linkedin,
        ma_service_type: maServiceType,
        ma_icp: maIcp
      },
      {
        companyDescription: config.company.description,
        productDescription: config.product.description
      },
      batchCtx
    );

    pushToBatchContext(batchCtx, outreach);

    const row = {
      first_name: lead.first_name ?? "",
      last_name: lead.last_name ?? "",
      title: lead.title ?? "",
      company_name: lead.company_name ?? "",
      company_name_normalized: companyNameNormalized,
      ma_service_type: maServiceType,
      icp_portfolio_imagination: maIcp.portfolio_imagination,
      icp_target_industries: maIcp.target_industries.join("; "),
      icp_deal_sizes: maIcp.deal_size_bands.join("; "),
      icp_company_types: maIcp.target_company_types.join("; "),
      icp_deal_types: maIcp.deal_types.join("; "),
      opening_line: outreach.opening_line,
      teaser: outreach.teaser,
      cta: outreach.cta,
      cold_email_html: outreach.cold_email_html,
      email_business: lead.email_business ?? "",
      company_website: lead.company_website ?? "",
      city: lead.city ?? "",
      state: lead.state ?? "",
      company_size: lead.company_size ?? "",
      company_industry: lead.company_industry ?? ""
    };

    results.push(row);

    console.log(`\n--- Lead ${i + 1}/${slice.length}: ${lead.first_name} ${lead.last_name} @ ${lead.company_name} ---`);
    console.log(`Service: ${maServiceType}`);
    console.log(`ICP: ${maIcp.portfolio_imagination}`);
    console.log(`Email preview:\n${outreach.cold_email_html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?div>/gi, "")}`);
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, stringify(results, { header: true }));

  const htmlOut = output.replace(/\.csv$/i, "_review.html");
  const htmlBody = results
    .map(
      (r, i) => `
    <section style="margin-bottom:2rem;padding:1rem;border:1px solid #ddd;border-radius:8px;">
      <h3>${i + 1}. ${r.first_name} ${r.last_name} — ${r.company_name}</h3>
      <p><strong>Service:</strong> ${r.ma_service_type} &nbsp;|&nbsp; <strong>Title:</strong> ${r.title}</p>
      <p><strong>ICP:</strong> ${r.icp_portfolio_imagination}</p>
      <p><strong>Target industries:</strong> ${r.icp_target_industries}</p>
      <p><strong>Opening:</strong> ${r.opening_line}</p>
      <p><strong>Teaser:</strong> ${r.teaser}</p>
      <p><strong>CTA:</strong> ${r.cta}</p>
      <div style="background:#f7f7f7;padding:1rem;margin-top:0.5rem;">${r.cold_email_html}</div>
    </section>`
    )
    .join("\n");
  fs.writeFileSync(
    htmlOut,
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>M&A Outreach Preview</title></head><body style="font-family:sans-serif;max-width:800px;margin:2rem auto;">${htmlBody}</body></html>`
  );

  console.log(`\n[enrich-ma] wrote ${results.length} rows to ${output}`);
  console.log(`[enrich-ma] HTML review: ${htmlOut}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
