import {
  classifyMx,
  cleanText,
  espFromMxData,
  isSegMxData,
  resolveLeadDomain
} from "./classifyMx.js";
import { findEmail, type FindEmailResult } from "./findEmail.js";
import { verifyEmail } from "./verifyEmail.js";
import {
  normalizeDomainSetting,
  normalizeSheetRow,
  type MaSheetRow,
  type PreparedMaLead
} from "./prepareMaSheet.js";
import {
  enrichMaOutreachSequential,
  type MaSequentialResult
} from "./enrichMaOutreachSequential.js";

export type MaRemovedLead = {
  reason:
    | "security_gateway"
    | "no_email_found"
    | "email_unverified"
    | "unknown_domain_setting"
    | "no_email";
  email: string;
  first_name: string;
  last_name: string;
  company_name: string;
  detail?: string;
};

export type MaProcessedLead = {
  lead: PreparedMaLead;
  enriched: MaSequentialResult;
  email_source: "csv" | "trykit";
  email_verification_status: string | null;
  mx_data: string;
};

export type MaRowOutcome =
  | { ok: true; result: MaProcessedLead }
  | { ok: false; removed: MaRemovedLead };

export type ProcessMaLeadOptions = {
  productDescription: string;
  trykittCache?: Map<number, FindEmailResult>;
  rowIndex?: number;
};

function toPreparedLead(
  r: MaSheetRow,
  activeEmail: string,
  domainSetting: "SMTP" | "CatchAll",
  esp: string,
  mxData: string
): PreparedMaLead {
  return {
    raw: r,
    first_name: cleanText(r.first_name),
    last_name: cleanText(r.last_name),
    title: cleanText(r.title),
    email_business: activeEmail.toLowerCase(),
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
    email_platform: esp,
    esp_classification: esp
  };
}

function removed(
  reason: MaRemovedLead["reason"],
  r: MaSheetRow,
  email: string,
  detail?: string
): MaRowOutcome {
  return {
    ok: false,
    removed: {
      reason,
      email,
      first_name: cleanText(r.first_name),
      last_name: cleanText(r.last_name),
      company_name: cleanText(r.company_name),
      detail
    }
  };
}

export function leadNeedsTryKitt(row: MaSheetRow): boolean {
  const r = normalizeSheetRow(row);
  if (cleanText(r.email_business)) return false;
  const setting = normalizeDomainSetting(r.domain_settings);
  if (setting === "CatchAll") return false;
  return setting === "SMTP" || setting === "";
}

export async function processMaLeadRow(
  rawRow: MaSheetRow,
  opts: ProcessMaLeadOptions
): Promise<MaRowOutcome> {
  const r = normalizeSheetRow(rawRow);
  const csvEmail = cleanText(r.email_business).toLowerCase();
  const domainSettingRaw = cleanText(r.domain_settings);
  let domainSetting = normalizeDomainSetting(domainSettingRaw);

  const companyWebsite = cleanText(r.company_website);
  const domain = resolveLeadDomain(csvEmail, companyWebsite);
  const sheetMx = cleanText(r.mx_records);

  let mxData = sheetMx;
  let esp = espFromMxData(sheetMx);
  let isSeg = isSegMxData(sheetMx);

  if (!sheetMx && domain) {
    const mx = await classifyMx(domain);
    mxData = mx.mxData;
    esp = mx.esp;
    isSeg = mx.isSeg;
  }

  if (isSeg) {
    return removed("security_gateway", r, csvEmail, mxData || domain);
  }

  let activeEmail = "";
  let emailSource: "csv" | "trykit" = "csv";
  let verificationStatus: string | null = null;

  if (csvEmail) {
    activeEmail = csvEmail;
    emailSource = "csv";
  } else {
    if (domainSetting === "CatchAll") {
      return removed("no_email", r, "", "CatchAll row without Email Business");
    }

    const cached =
      opts.rowIndex !== undefined ? opts.trykittCache?.get(opts.rowIndex) : undefined;
    const found =
      cached ??
      (await findEmail({
        firstName: r.first_name,
        lastName: r.last_name,
        companyName: r.company_name,
        companyWebsite: r.company_website,
        companyLinkedin: r.company_linkedin,
        personLinkedin: r.linkedin
      }));

    if (!found.email) {
      return removed("no_email_found", r, "", found.domainUsed || domain);
    }

    const verify = await verifyEmail(found.email);
    verificationStatus = verify.status;
    if (!verify.accepted) {
      return removed("email_unverified", r, found.email, verify.status);
    }

    activeEmail = found.email.toLowerCase();
    emailSource = "trykit";
    if (!domainSetting) domainSetting = "SMTP";
  }

  if (!activeEmail) {
    return removed("no_email", r, "", "no active email after resolution");
  }

  if (!domainSetting) {
    return removed("unknown_domain_setting", r, activeEmail, domainSettingRaw || "(blank)");
  }

  const lead = toPreparedLead(r, activeEmail, domainSetting, esp, mxData);
  const enriched = await enrichMaOutreachSequential(
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
    opts.productDescription
  );

  return {
    ok: true,
    result: {
      lead,
      enriched,
      email_source: emailSource,
      email_verification_status: verificationStatus,
      mx_data: mxData
    }
  };
}
