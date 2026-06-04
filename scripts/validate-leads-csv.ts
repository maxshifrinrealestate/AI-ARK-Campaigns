import fs from "node:fs";
import { parse } from "csv-parse/sync";

const EXPECTED_COLUMNS = [
  "first_name",
  "last_name",
  "title",
  "email_business",
  "domain_settings",
  "country",
  "state",
  "city",
  "linkedin",
  "company_name",
  "company_size",
  "company_industry",
  "company_products_services",
  "company_description",
  "company_website",
  "company_linkedin",
  "company_number_of_locations"
] as const;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeDomainSetting(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z]/g, "");
}

function main(): void {
  const leadsPath = argValue("--leads") ?? "data/csuite_healthcare_jun04.csv";
  if (!fs.existsSync(leadsPath)) {
    console.error(`CSV not found: ${leadsPath}`);
    console.error("Copy your file to data/csuite_healthcare_jun04.csv or pass --leads <path>");
    process.exit(1);
  }

  const text = fs.readFileSync(leadsPath, "utf-8");
  const records = parse(text, {
    columns: (header: string[]) => header.map(normalizeHeader),
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as Record<string, string>[];

  const headers = records.length > 0 ? Object.keys(records[0]!) : [];
  const missing = EXPECTED_COLUMNS.filter((col) => !headers.includes(col));
  const extra = headers.filter((col) => !EXPECTED_COLUMNS.includes(col as (typeof EXPECTED_COLUMNS)[number]));

  const domainCounts = { smtp: 0, catchall: 0, blank: 0, other: 0 };
  for (const row of records) {
    const norm = normalizeDomainSetting(row.domain_settings ?? "");
    if (norm === "smtp") domainCounts.smtp++;
    else if (norm === "catchall") domainCounts.catchall++;
    else if (norm === "") domainCounts.blank++;
    else domainCounts.other++;
  }

  const withEmail = records.filter((r) => (r.email_business ?? "").trim()).length;
  const withoutEmail = records.length - withEmail;

  const summary = {
    path: leadsPath,
    rowCount: records.length,
    headers,
    missingColumns: missing,
    extraColumns: extra,
    emailBusiness: { withEmail, withoutEmail },
    domainSettings: domainCounts,
    catchallWillBeSkipped: domainCounts.catchall,
    uploadEligibleByDomainSetting: domainCounts.smtp + domainCounts.blank
  };

  console.log(JSON.stringify(summary, null, 2));

  if (missing.length > 0) {
    console.error(`Missing expected columns: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (records.length === 0) {
    console.error("CSV has headers but no data rows.");
    process.exit(1);
  }
}

main();
