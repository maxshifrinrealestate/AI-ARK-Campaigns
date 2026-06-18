import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import {
  classifyMx,
  cleanText,
  resolveLeadDomain
} from "../functions/classifyMx.js";
import { normalizeCompany } from "../functions/normalizeCompany.js";
import { classifyCompanyType } from "../functions/classifyCompanyType.js";
import { enrichFacilityAndTalent } from "../functions/enrichFacilityAndTalent.js";
import { findEmailsBatch, type FindEmailResult } from "../functions/findEmail.js";
import { verifyEmail } from "../functions/verifyEmail.js";
import { routeCampaign, type CampaignsConfig } from "../functions/routeCampaign.js";
import { mapPool } from "../functions/mapPool.js";
import { countWords, personalizeEmail, personalizeEmailLocal } from "../functions/personalizeEmail.js";
import { uploadLead, type PlusVibeLeadPayload } from "../integrations/plusvibe.js";

type LeadRow = Record<string, string>;
type ScriptRow = Record<string, string>;
type FinanceConfig = {
  vertical: string;
  company: { name?: string; description: string };
  product: { name?: string; description: string };
  campaigns: CampaignsConfig;
  limits?: { openaiConcurrency?: number };
};

type RemovedLead = {
  first_name: string;
  last_name: string;
  company_name: string;
  email: string;
  reason: string;
  detail?: string;
};

type UploadedLead = {
  first_name: string;
  last_name: string;
  title: string;
  company_name: string;
  company_name_normalized: string;
  company_type: string;
  facility_type: string;
  talent_type: string;
  email: string;
  email_source: "csv" | "trykit";
  domain_settings: string;
  email_body: string;
  word_count: number;
  plusvibe_workspace_id: string;
  plusvibe_campaign_id: string;
  upload_ok: string;
  upload_error: string;
};

type RowOpts = {
  emailsOnly: boolean;
  skipEnrich: boolean;
  fallbackOnly: boolean;
  dryRun: boolean;
  scriptMap: Map<string, string>;
  trykittCache: Map<number, FindEmailResult>;
};

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function readLeadsCsv(p: string): LeadRow[] {
  const text = fs.readFileSync(p, "utf-8");
  return parse(text, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as LeadRow[];
}

function readConfig(p: string): FinanceConfig {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as FinanceConfig;
}

function productsField(lead: LeadRow): string {
  return cleanText(lead.company_product_and_services ?? lead.company_products_services);
}

function scriptKey(first?: string, last?: string, company?: string): string {
  return `${cleanText(first).toLowerCase()}|${cleanText(last).toLowerCase()}|${cleanText(company).toLowerCase()}`;
}

function loadScriptMap(scriptsPath?: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!scriptsPath || !fs.existsSync(scriptsPath)) return map;
  const rows = parse(fs.readFileSync(scriptsPath, "utf-8"), {
    columns: (h: string[]) => h.map((x) => x.trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_quotes: true
  }) as ScriptRow[];
  for (const r of rows) {
    const body = cleanText(r.email_body);
    if (!body) continue;
    map.set(scriptKey(r.first_name, r.last_name, r.company_name), body);
  }
  return map;
}

function domainNorm(raw: unknown): string {
  return cleanText(raw).toLowerCase().replace(/[^a-z]/g, "");
}

function leadNeedsTryKitt(raw: LeadRow): boolean {
  if (cleanText(raw.email_business)) return false;
  const norm = domainNorm(raw.domain_settings);
  return norm === "";
}

async function processRow(
  raw: LeadRow,
  config: FinanceConfig,
  index: number,
  total: number,
  opts: RowOpts
): Promise<{ kind: "removed"; removed: RemovedLead } | { kind: "uploaded"; uploaded: UploadedLead }> {
  const firstName = cleanText(raw.first_name);
  const lastName = cleanText(raw.last_name);
  const companyName = cleanText(raw.company_name);

  const drop = (reason: string, email = "", detail?: string) => ({
    kind: "removed" as const,
    removed: { first_name: firstName, last_name: lastName, company_name: companyName, email, reason, detail }
  });

  const emailBusiness = cleanText(raw.email_business);
  const companyWebsite = cleanText(raw.company_website);
  const domain = resolveLeadDomain(emailBusiness, companyWebsite);
  const norm = domainNorm(raw.domain_settings);
  const trykittEligible = !emailBusiness && norm === "";

  if (opts.emailsOnly && !emailBusiness) {
    return drop("no_email_in_sheet", "", "emails-only mode");
  }

  const domainEligible =
    norm === "smtp" ||
    norm === "smtpvalid" ||
    norm === "catchall" ||
    norm === "catchallvalid" ||
    trykittEligible;
  if (!domainEligible) {
    return drop("unknown_domain_setting", emailBusiness, cleanText(raw.domain_settings));
  }

  let mx;
  try {
    mx = await classifyMx(domain);
  } catch {
    mx = { domain, mxData: "", esp: "empty" as const, isSeg: false };
  }
  if (mx.isSeg) {
    return drop("security_gateway", emailBusiness, mx.mxData);
  }

  let activeEmail = "";
  let emailSource: "csv" | "trykit" = "csv";

  if (emailBusiness) {
    activeEmail = emailBusiness.toLowerCase();
  } else {
    const cached = opts.trykittCache.get(index);
    if (!cached?.email) return drop("no_email_found", "", cached?.domainUsed);
    const verify = await verifyEmail(cached.email);
    if (!verify.accepted) return drop("email_unverified", cached.email, verify.status);
    activeEmail = cached.email;
    emailSource = "trykit";
  }

  let companyNameNormalized = companyName;
  let companyType = "";
  let facilityType = "";
  let talentType = "";

  if (!opts.skipEnrich) {
    companyNameNormalized = await normalizeCompany(raw.company_name);
    companyType = await classifyCompanyType({
      companyNameNormalized,
      companyDescription: raw.company_description,
      companyProductsServices: productsField(raw)
    });
    const facilityTalent = await enrichFacilityAndTalent({
      companyNameNormalized,
      companyDescription: raw.company_description,
      companyProductsServices: productsField(raw),
      title: raw.title
    });
    facilityType = facilityTalent.facilityType;
    talentType = facilityTalent.talentType;
  }

  const route = routeCampaign(raw.domain_settings, config.campaigns, {
    treatEmptyAsSmtp: trykittEligible || norm === ""
  });
  if (!route.ok) return drop("unknown_domain_setting", activeEmail, route.rawValue);

  const prefilled = opts.scriptMap.get(scriptKey(firstName, lastName, companyName));
  let emailBody = prefilled ?? "";
  let wordCount = prefilled ? countWords(prefilled) : 0;

  if (!emailBody) {
    const input = {
      firstName: raw.first_name,
      lastName: raw.last_name,
      title: raw.title,
      headline: raw.headline,
      companyName: companyNameNormalized || raw.company_name,
      companyDescription: raw.company_description,
      companyProductsServices: productsField(raw),
      companyIndustry: raw.company_industry,
      city: raw.city,
      state: raw.state,
      country: raw.country,
      facilityType,
      talentType,
      rowIndex: index
    };
    const personalized = opts.fallbackOnly
      ? personalizeEmailLocal(input)
      : await personalizeEmail(input, { fallbackOnly: false });
    emailBody = personalized.body;
    wordCount = personalized.wordCount;
  }

  const payload: PlusVibeLeadPayload = {
    email: activeEmail,
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    company_name: companyNameNormalized || companyName || undefined,
    company_website: companyWebsite || undefined,
    linkedin_person_url: cleanText(raw.linkedin) || undefined,
    linkedin_company_url: cleanText(raw.company_linkedin) || undefined,
    city: cleanText(raw.city) || undefined,
    country: cleanText(raw.country) || undefined,
    custom_variables: {
      custom_talent_type: talentType,
      custom_facility_type: facilityType,
      custom_email_body: emailBody
    }
  };

  if (!opts.dryRun) {
    const upload = await uploadLead(payload, route.target);
    if (!upload.ok) {
      return drop("upload_failed", activeEmail, upload.error);
    }
  }

  return {
    kind: "uploaded",
    uploaded: {
      first_name: firstName,
      last_name: lastName,
      title: cleanText(raw.title),
      company_name: companyName,
      company_name_normalized: companyNameNormalized,
      company_type: companyType,
      facility_type: facilityType,
      talent_type: talentType,
      email: activeEmail,
      email_source: emailSource,
      domain_settings: route.setting,
      email_body: emailBody,
      word_count: wordCount,
      plusvibe_workspace_id: route.target.workspaceId,
      plusvibe_campaign_id: route.target.campaignId,
      upload_ok: opts.dryRun ? "dry_run" : "true",
      upload_error: ""
    }
  };
}

async function run(): Promise<void> {
  const input = argValue("--input") ?? "data/tech_ai_24.csv";
  const scriptsCsv = argValue("--scripts");
  const configPath = argValue("--config") ?? "configs/tech_ai_upload.json";
  const outDir = argValue("--out") ?? `run_outputs_tech_upload_${Date.now()}`;
  const limitRaw = argValue("--limit");
  const emailsOnly = hasFlag("--emails-only");
  const skipEnrich = hasFlag("--skip-enrich");
  const fallbackOnly = hasFlag("--fallback-only");
  const dryRun = hasFlag("--dry-run");

  if (!dryRun) {
    const required = ["TRYKITT_API_KEY", "MILLIONVERIFIER_API_KEY", "PLUSVIBE_KEY"];
    if (!skipEnrich && !fallbackOnly) required.push("OPENAI_API_KEY");
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`Missing env vars: ${missing.join(", ")}`);
    }
  }

  const config = readConfig(configPath);
  let leads = readLeadsCsv(input);
  if (limitRaw) {
    const limit = Math.max(1, Number(limitRaw));
    leads = leads.slice(0, limit);
  }

  const scriptMap = loadScriptMap(scriptsCsv);
  const concurrency = Math.max(1, Number(process.env.ROW_CONCURRENCY) || config.limits?.openaiConcurrency || 8);

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[upload] ${leads.length} leads from ${input}`);
  console.log(
    `[upload] workspace=${config.campaigns.smtp.workspaceId} campaign=${config.campaigns.smtp.campaignId}`
  );
  console.log(
    `[upload] skipEnrich=${skipEnrich} fallbackOnly=${fallbackOnly} openaiCalls=${skipEnrich && fallbackOnly ? 0 : "yes"}`
  );
  console.log(
    `[upload] emailsOnly=${emailsOnly} dryRun=${dryRun} concurrency=${concurrency}`
  );

  const trykittCache = new Map<number, FindEmailResult>();
  const trykittItems = leads
    .map((raw, i) => ({ raw, i }))
    .filter(({ raw }) => leadNeedsTryKitt(raw) && !emailsOnly)
    .map(({ raw, i }) => ({
      key: i,
      firstName: raw.first_name,
      lastName: raw.last_name,
      companyName: raw.company_name,
      companyWebsite: raw.company_website,
      personLinkedin: raw.linkedin
    }));

  if (trykittItems.length > 0) {
    console.log(`[upload] trykitt batch prefetch: ${trykittItems.length} jobs`);
    const batch = await findEmailsBatch(trykittItems);
    for (const [key, result] of batch) {
      trykittCache.set(Number(key), result);
    }
    const found = [...batch.values()].filter((r) => r.email).length;
    console.log(`[upload] trykitt batch done: ${found}/${trykittItems.length} found`);
  }

  let completed = 0;
  let uploadedCount = 0;
  let removedCount = 0;
  const uploaded: UploadedLead[] = [];
  const removed: RemovedLead[] = [];

  const outcomes = await mapPool(leads, concurrency, async (raw, i) => {
    const outcome = await processRow(raw, config, i, leads.length, {
      emailsOnly,
      skipEnrich,
      fallbackOnly,
      dryRun,
      scriptMap,
      trykittCache
    });
    completed++;
    if (outcome.kind === "uploaded") uploadedCount++;
    else removedCount++;

    if (completed % 100 === 0 || completed === leads.length) {
      console.log(`[upload] progress ${completed}/${leads.length} uploaded=${uploadedCount} removed=${removedCount}`);
    }
    return outcome;
  });

  for (const o of outcomes) {
    if (o.kind === "uploaded") uploaded.push(o.uploaded);
    else removed.push(o.removed);
  }

  fs.writeFileSync(path.join(outDir, "uploaded_leads.csv"), stringify(uploaded, { header: true }));
  fs.writeFileSync(path.join(outDir, "removed_leads.csv"), stringify(removed, { header: true }));
  fs.writeFileSync(
    path.join(outDir, "run_summary.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        input,
        limit: limitRaw ? Number(limitRaw) : leads.length,
        skip_enrich: skipEnrich,
        fallback_only: fallbackOnly,
        dry_run: dryRun,
        total: leads.length,
        uploaded: uploaded.length,
        removed: removed.length,
        removed_by_reason: removed.reduce<Record<string, number>>((acc, r) => {
          acc[r.reason] = (acc[r.reason] ?? 0) + 1;
          return acc;
        }, {}),
        campaign: config.campaigns.smtp
      },
      null,
      2
    )
  );

  console.log(`[upload] done: ${uploaded.length} uploaded, ${removed.length} removed`);
  console.log(`[upload] artifacts in ${outDir}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
