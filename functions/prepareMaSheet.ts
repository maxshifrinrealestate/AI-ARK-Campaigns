import { cleanText } from "./classifyMx.js";

export type MaSheetRow = Record<string, string>;

export type PreparedMaLead = {
  raw: MaSheetRow;
  first_name: string;
  last_name: string;
  title: string;
  email_business: string;
  domain_settings: string;
  company_name: string;
  company_name_normalized: string;
  company_description: string;
  company_products_services: string;
  company_industry: string;
  company_size: string;
  company_website: string;
  company_linkedin: string;
  city: string;
  state: string;
  country: string;
  linkedin: string;
  email_platform: string;
  esp_classification: string;
};

export type GateResult =
  | { ok: true; lead: PreparedMaLead }
  | { ok: false; reason: string; email: string; detail?: string };

const HEADER_MAP: Record<string, string> = {
  first_name: "first_name",
  last_name: "last_name",
  title: "title",
  email_business: "email_business",
  domain_settings: "domain_settings",
  country: "country",
  state: "state",
  city: "city",
  linkedin: "linkedin",
  organization: "organization",
  company_name: "company_name",
  company_size: "company_size",
  company_industry: "company_industry",
  company_products_services: "company_products_services",
  company_description: "company_description",
  company_website: "company_website",
  company_linkedin: "company_linkedin",
  normalized_company_name: "company_name_normalized",
  email_platform: "email_platform",
  mx_records: "mx_records"
};

export function normalizeSheetRow(row: MaSheetRow): MaSheetRow {
  const out: MaSheetRow = {};
  for (const [k, v] of Object.entries(row)) {
    const norm = k.trim().toLowerCase().replace(/\s+/g, "_");
    const mapped = HEADER_MAP[norm] ?? norm;
    out[mapped] = v;
  }
  if (row.company_product_and_services && !out.company_products_services) {
    out.company_products_services = row.company_product_and_services;
  }
  if (!out.company_name && out.organization) {
    out.company_name = out.organization;
  }
  return out;
}

/** Maps sheet values like SMTP_VALID / CATCH_ALL_VALID to canonical SMTP | CatchAll | "". */
export function normalizeDomainSetting(raw: unknown): "SMTP" | "CatchAll" | "" {
  const norm = cleanText(raw).toLowerCase().replace(/[^a-z]/g, "");
  if (!norm) return "";
  if (norm === "smtp" || norm.startsWith("smtpvalid")) return "SMTP";
  if (norm === "catchall" || norm.startsWith("catchallvalid")) return "CatchAll";
  return "";
}

export function mapEsp(platform: string): string {
  const p = platform.toLowerCase();
  if (p === "google") return "google";
  if (p === "outlook") return "outlook";
  if (p === "seg") return "seg";
  if (p === "others") return "others";
  return p || "empty";
}

export function gateMaLead(row: MaSheetRow): GateResult {
  const r = normalizeSheetRow(row);
  const email = cleanText(r.email_business).toLowerCase();
  const domainSettingsRaw = cleanText(r.domain_settings);
  const domainSetting = normalizeDomainSetting(domainSettingsRaw);
  const platform = cleanText(r.email_platform);

  if (!email) {
    return { ok: false, reason: "no_email", email: "", detail: "missing Email Business" };
  }

  if (platform.toUpperCase() === "SEG" || mapEsp(platform) === "seg") {
    return { ok: false, reason: "security_gateway", email, detail: platform || "SEG" };
  }

  if (!domainSetting) {
    return {
      ok: false,
      reason: "unknown_domain_setting",
      email,
      detail: domainSettingsRaw || "(blank)"
    };
  }

  const lead: PreparedMaLead = {
    raw: r,
    first_name: cleanText(r.first_name),
    last_name: cleanText(r.last_name),
    title: cleanText(r.title),
    email_business: email,
    domain_settings: domainSetting,
    company_name: cleanText(r.company_name),
    company_name_normalized: cleanText(r.company_name_normalized) || cleanText(r.company_name),
    company_description: cleanText(r.company_description),
    company_products_services: cleanText(r.company_products_services),
    company_industry: cleanText(r.company_industry),
    company_size: cleanText(r.company_size),
    company_website: cleanText(r.company_website),
    company_linkedin: cleanText(r.company_linkedin),
    city: cleanText(r.city),
    state: cleanText(r.state),
    country: cleanText(r.country),
    linkedin: cleanText(r.linkedin),
    email_platform: platform,
    esp_classification: mapEsp(platform)
  };

  return { ok: true, lead };
}
