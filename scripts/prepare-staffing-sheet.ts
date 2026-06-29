import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function salutationFromFirst(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  return t.split(/\s+/)[0]!;
}

function run(): void {
  const input = argValue("--input");
  const output = argValue("--output") ?? "data/staffing_leads_full.csv";
  if (!input) throw new Error("Usage: npx tsx scripts/prepare-staffing-sheet.ts --input <sheet.csv> [--output <path>]");

  const rows = parse(fs.readFileSync(input, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as Record<string, string>[];

  const out = rows.map((r) => ({
    salutation_first_name: salutationFromFirst(r["First Name"] ?? ""),
    first_name: (r["First Name"] ?? "").trim(),
    last_name: (r["Last Name"] ?? "").trim(),
    title: (r["Title"] ?? "").trim(),
    email_business: (r["Email Business"] ?? "").trim().toLowerCase(),
    domain_settings: (r["Domain Settings"] ?? r["Domain Type"] ?? "").trim(),
    mx_records: (r["MX Records"] ?? "").trim(),
    country: (r["Country"] ?? "").trim(),
    state: (r["State"] ?? "").trim(),
    city: (r["City"] ?? "").trim(),
    linkedin: (r["LinkedIn"] ?? "").trim(),
    company_name: (r["Company Name"] ?? r["Organization"] ?? "").trim(),
    company_size: (r["Company Size"] ?? r["Company Employee Count"] ?? "").trim(),
    company_industry: (r["Company Industry"] ?? "").trim(),
    company_products_services: (r["Company Product and Services"] ?? "").trim(),
    company_description: (r["Company Description"] ?? "").trim(),
    company_website: (r["Company Website"] ?? r["Domain"] ?? "").trim(),
    company_linkedin: (r["Company LinkedIn"] ?? "").trim(),
    company_number_of_locations: (r["Company Number Of Locations"] ?? "").trim(),
    email_body: ""
  }));

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, stringify(out, { header: true }));
  console.log(`[prepare] wrote ${out.length} rows to ${output}`);
}

run();
