import "dotenv/config";
import fs from "node:fs";
import { parse } from "csv-parse/sync";

import { enrichMaOutreachSequential } from "../functions/enrichMaOutreachSequential.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function mapRow(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.trim().toLowerCase().replace(/\s+/g, "_")] = v;
  }
  if (row.company_product_and_services && !out.company_products_services) {
    out.company_products_services = row.company_product_and_services;
  }
  return out;
}

async function run(): Promise<void> {
  const input = argValue("--input") ?? "data/ma_leads.csv";
  const count = Number(argValue("--count") ?? "10");

  const rows = parse(fs.readFileSync(input, "utf-8"), {
    columns: (h: string[]) => h.map((x) => x.trim()),
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true
  }) as Record<string, string>[];

  const productDescription =
    "We connect advisory firms with companies that match their ideal client profile — vague intros only, no live deals held.";

  for (let i = 0; i < Math.min(count, rows.length); i++) {
    const r = mapRow(rows[i]!);
    const result = await enrichMaOutreachSequential(
      {
        first_name: r.first_name,
        last_name: r.last_name,
        title: r.title,
        company_name: r.company_name,
        company_description: r.company_description,
        company_products_services: r.company_products_services,
        company_industry: r.company_industry,
        company_size: r.company_size,
        city: r.city,
        state: r.state,
        country: r.country,
        company_website: r.company_website,
        company_linkedin: r.company_linkedin
      },
      productDescription
    );

    const plain = result.cold_email_html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?div>/gi, "")
      .trim();

    console.log(
      JSON.stringify(
        {
          index: i + 1,
          name: `${r.first_name} ${r.last_name}`,
          firm: r.company_name,
          service: result.ma_service_type,
          icp: result.icp.portfolio_imagination,
          narrative_angle: result.narrative_angle,
          opening: result.opening_line,
          teaser: result.teaser,
          cta: result.cta,
          email_plain: plain,
          email_html: result.cold_email_html
        },
        null,
        2
      )
    );
    console.log("---");
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
