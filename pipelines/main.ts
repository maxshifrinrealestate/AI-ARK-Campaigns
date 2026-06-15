import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { findICP, type ICP } from "../functions/findICP.js";
import { findCompetitors, type Competitor } from "../functions/findCompetitors.js";
import {
  classifyMx,
  cleanText,
  domainFromEmail,
  resolveLeadDomain
} from "../functions/classifyMx.js";
import { normalizeCompany } from "../functions/normalizeCompany.js";
import { classifyCompanyType } from "../functions/classifyCompanyType.js";
import { enrichFacilityAndTalent } from "../functions/enrichFacilityAndTalent.js";
import { findEmail, findEmailsBatch, type FindEmailResult } from "../functions/findEmail.js";
import { verifyEmail } from "../functions/verifyEmail.js";
import {
  normalizeDomainSettingRaw,
  routeCampaign,
  type CampaignsConfig
} from "../functions/routeCampaign.js";
import { uploadLead, type PlusVibeLeadPayload } from "../integrations/plusvibe.js";
import { upsertLeads, type SupabaseLeadRow } from "../integrations/supabase.js";
import { mapPool } from "../functions/mapPool.js";

export type FinanceConfig = {
  vertical: string;
  company: { name?: string; description: string };
  product: { name?: string; description: string };
  campaigns: CampaignsConfig;
  limits?: { openaiConcurrency?: number; uploadConcurrency?: number };
};

export type PipelineOptions = {
  configPath: string;
  leadsPath: string;
  outDir: string;
  pilot?: number;
  /** 0-based row index to resume from (for interrupted runs). */
  startRow?: number;
  /** Skip ICP/competitor OpenAI calls when resuming. */
  skipIcp?: boolean;
  /** Only rows with no email_business; TryKitt + MV, treat blank domain_settings as SMTP. */
  emptyEmailOnly?: boolean;
  continuationNote?: string;
};

type LeadRow = Record<string, string>;

type RemovedLead = {
  reason:
    | "security_gateway"
    | "no_email_found"
    | "email_unverified"
    | "unknown_domain_setting"
    | "catchall_skipped";
  email: string;
  domain: string;
  raw: LeadRow;
  detail?: string;
};

type EnrichedLead = {
  raw: LeadRow;
  active_email: string;
  email_source: "csv" | "trykit";
  email_verification_status: string | null;
  esp_classification: string;
  domain_settings: string;
  company_name_normalized: string;
  company_type: string;
  facility_type: string;
  talent_type: string;
  plusvibe_workspace_id: string;
  plusvibe_campaign_id: string;
  upload_ok: boolean;
  upload_error?: string;
};

type StageCounts = {
  input: number;
  smtp_eligible: number;
  catchall_skipped: number;
  after_stage1_mx: number;
  after_stage2_normalize: number;
  after_stage3_classify: number;
  after_stage4_email: number;
  after_stage5_route: number;
  uploaded_ok: number;
  uploaded_failed: number;
  supabase_succeeded: number;
  supabase_failed: number;
  drops_by_reason: Record<string, number>;
};

type RowOutcome =
  | { kind: "removed"; removed: RemovedLead; counts: Partial<StageCounts> }
  | {
      kind: "enriched";
      enriched: EnrichedLead;
      counts: Partial<StageCounts>;
      uploadError?: { email: string; campaign_id: string; error_message: string };
    };

type NumericCountKey = Exclude<keyof StageCounts, "drops_by_reason" | "input">;

const COUNT_KEYS: NumericCountKey[] = [
  "smtp_eligible",
  "catchall_skipped",
  "after_stage1_mx",
  "after_stage2_normalize",
  "after_stage3_classify",
  "after_stage4_email",
  "after_stage5_route",
  "uploaded_ok",
  "uploaded_failed",
  "supabase_succeeded",
  "supabase_failed"
];

function mergeCounts(target: StageCounts, delta: Partial<StageCounts>): void {
  if (delta.drops_by_reason) {
    for (const [reason, n] of Object.entries(delta.drops_by_reason)) {
      target.drops_by_reason[reason] = (target.drops_by_reason[reason] ?? 0) + n;
    }
  }
  for (const k of COUNT_KEYS) {
    const v = delta[k];
    if (typeof v === "number") target[k] += v;
  }
}

function leadNeedsTryKitt(raw: LeadRow, emptyEmailOnly?: boolean): boolean {
  if (cleanText(raw.email_business)) return false;
  const domainSettingRaw = normalizeDomainSettingRaw(raw.domain_settings);
  if (domainSettingRaw === "catchall") return false;
  if (emptyEmailOnly && cleanText(raw.email_business)) return false;
  const trykittEligible = domainSettingRaw === "";
  return domainSettingRaw === "smtp" || trykittEligible;
}

async function processLeadRow(
  raw: LeadRow,
  config: FinanceConfig,
  globalIndex: number,
  batchTotal: number,
  rowOpts: {
    emptyEmailOnly?: boolean;
    leadIndex?: number;
    trykittCache?: Map<number, FindEmailResult>;
  } = {}
): Promise<RowOutcome> {
  const tag = `[${globalIndex + 1}/${batchTotal}]`;
  const drop = (reason: RemovedLead["reason"], partial: Partial<StageCounts>, removed: RemovedLead): RowOutcome => ({
    kind: "removed",
    removed,
    counts: { ...partial, drops_by_reason: { [reason]: 1 } }
  });

  const emailBusiness = cleanText(raw.email_business);
  const companyWebsite = cleanText(raw.company_website);
  const domain = resolveLeadDomain(emailBusiness, companyWebsite);
  const domainSettingRaw = normalizeDomainSettingRaw(raw.domain_settings);

  const emptyEmailMode = rowOpts.emptyEmailOnly === true;

  if (domainSettingRaw === "catchall") {
    return drop("catchall_skipped", { catchall_skipped: 1 }, {
      reason: "catchall_skipped",
      email: emailBusiness,
      domain,
      raw,
      detail: cleanText(raw.domain_settings)
    });
  }

  if (emptyEmailMode && emailBusiness) {
    return drop("unknown_domain_setting", {}, {
      reason: "unknown_domain_setting",
      email: emailBusiness,
      domain,
      raw,
      detail: "empty-email-only run: row has Email Business"
    });
  }

  // Blank domain_settings + missing Email Business → TryKitt path (treat as SMTP at route).
  const trykittEligible = !emailBusiness && domainSettingRaw === "";
  const domainEligible =
    domainSettingRaw === "smtp" || trykittEligible || (emailBusiness && domainSettingRaw === "");
  if (!domainEligible) {
    return drop("unknown_domain_setting", {}, {
      reason: "unknown_domain_setting",
      email: emailBusiness,
      domain,
      raw,
      detail: cleanText(raw.domain_settings)
    });
  }

  const base: Partial<StageCounts> = { smtp_eligible: 1 };

  let mx;
  try {
    mx = await classifyMx(domain);
  } catch (err) {
    console.warn(`${tag} stage1 mx error: ${(err as Error).message}`);
    mx = { domain, mxData: "", esp: "empty" as const, isSeg: false };
  }

  if (mx.isSeg) {
    return drop("security_gateway", base, {
      reason: "security_gateway",
      email: emailBusiness,
      domain,
      raw,
      detail: mx.mxData
    });
  }

  let activeEmail = "";
  let emailSource: "csv" | "trykit" = "csv";
  let verificationStatus: string | null = null;

  if (emailBusiness) {
    activeEmail = emailBusiness.toLowerCase();
    emailSource = "csv";
  } else {
    const cached =
      rowOpts.leadIndex !== undefined ? rowOpts.trykittCache?.get(rowOpts.leadIndex) : undefined;
    const found =
      cached ??
      (await findEmail({
        firstName: raw.first_name,
        lastName: raw.last_name,
        companyName: raw.company_name,
        companyWebsite: raw.company_website,
        companyLinkedin: raw.company_linkedin,
        personLinkedin: raw.linkedin
      }));
    if (!found.email) {
      return drop("no_email_found", base, {
        reason: "no_email_found",
        email: "",
        domain: found.domainUsed || domain,
        raw
      });
    }
    const verify = await verifyEmail(found.email);
    verificationStatus = verify.status;
    if (!verify.accepted) {
      return drop("email_unverified", base, {
        reason: "email_unverified",
        email: found.email,
        domain: domainFromEmail(found.email),
        raw,
        detail: verify.status
      });
    }
    activeEmail = found.email;
    emailSource = "trykit";
  }

  const companyNameNormalized = await normalizeCompany(raw.company_name);
  const companyType = await classifyCompanyType({
    companyNameNormalized,
    companyDescription: raw.company_description,
    companyProductsServices: raw.company_products_services
  });
  const facilityTalent = await enrichFacilityAndTalent({
    companyNameNormalized,
    companyDescription: raw.company_description,
    companyProductsServices: raw.company_products_services,
    title: raw.title
  });

  const route = routeCampaign(raw.domain_settings, config.campaigns, {
    treatEmptyAsSmtp: trykittEligible || emptyEmailMode || domainSettingRaw === ""
  });
  if (!route.ok) {
    return drop("unknown_domain_setting", base, {
      reason: "unknown_domain_setting",
      email: activeEmail,
      domain: domainFromEmail(activeEmail),
      raw,
      detail: route.rawValue
    });
  }

  const payload: PlusVibeLeadPayload = {
    email: activeEmail,
    first_name: cleanText(raw.first_name) || undefined,
    last_name: cleanText(raw.last_name) || undefined,
    company_name: companyNameNormalized || cleanText(raw.company_name) || undefined,
    company_website: cleanText(raw.company_website) || undefined,
    linkedin_person_url: cleanText(raw.linkedin) || undefined,
    linkedin_company_url: cleanText(raw.company_linkedin) || undefined,
    city: cleanText(raw.city) || undefined,
    country: cleanText(raw.country) || undefined,
    custom_variables: {
      custom_talent_type: facilityTalent.talentType || "",
      custom_facility_type: facilityTalent.facilityType || ""
    }
  };

  const upload = await uploadLead(payload, route.target);
  const uploadError = upload.ok
    ? undefined
    : {
        email: activeEmail,
        campaign_id: route.target.campaignId,
        error_message: upload.error
      };

  return {
    kind: "enriched",
    enriched: {
      raw,
      active_email: activeEmail,
      email_source: emailSource,
      email_verification_status: verificationStatus,
      esp_classification: mx.esp,
      domain_settings: route.setting,
      company_name_normalized: companyNameNormalized,
      company_type: companyType,
      facility_type: facilityTalent.facilityType,
      talent_type: facilityTalent.talentType,
      plusvibe_workspace_id: route.target.workspaceId,
      plusvibe_campaign_id: route.target.campaignId,
      upload_ok: upload.ok,
      upload_error: upload.ok ? undefined : upload.error
    },
    counts: {
      ...base,
      after_stage1_mx: 1,
      after_stage2_normalize: 1,
      after_stage3_classify: 1,
      after_stage4_email: 1,
      after_stage5_route: 1,
      uploaded_ok: upload.ok ? 1 : 0,
      uploaded_failed: upload.ok ? 0 : 1
    },
    uploadError
  };
}

export async function runPipeline(opts: PipelineOptions): Promise<void> {
  fs.mkdirSync(opts.outDir, { recursive: true });

  const config = readConfig(opts.configPath);
  validateConfig(config);

  const leadsAll = readLeadsCsv(opts.leadsPath);
  const startRow = opts.startRow ?? 0;
  let pool = leadsAll;
  if (opts.emptyEmailOnly) {
    const before = pool.length;
    pool = pool.filter((r) => !cleanText(r.email_business));
    console.log(
      `[pipeline] empty-email-only: ${pool.length}/${before} rows (no Email Business)`
    );
  }
  let leads = startRow > 0 ? pool.slice(startRow) : pool;
  if (opts.pilot && opts.pilot > 0) {
    leads = leads.slice(0, opts.pilot);
  }

  console.log(`[pipeline] loaded ${leadsAll.length} leads from ${opts.leadsPath}`);
  if (opts.emptyEmailOnly) {
    console.log(`[pipeline] mode=trykitt+millionverifier for missing Email Business`);
  }
  if (startRow > 0) {
    console.log(
      `[pipeline] resume: starting at row ${startRow} (${leads.length} rows in this batch)`
    );
  }
  if (opts.pilot) {
    console.log(`[pipeline] pilot/shard limit: processing ${leads.length} rows in this batch`);
  }
  if (opts.continuationNote) console.log(`[pipeline] ${opts.continuationNote}`);

  let icp: ICP;
  let competitors: Competitor[];
  if (opts.skipIcp) {
    icp = { industries: [], titles: [], company_size_ranges: [], pains: [], geographies: [], summary: "" };
    competitors = [];
    console.log(`[pipeline] skip-icp: skipping ICP and competitor generation`);
  } else {
    console.log(`[pipeline] generating ICP for vertical=${config.vertical}`);
    icp = await findICP({
      companyName: config.company.name,
      companyDescription: config.company.description,
      productName: config.product.name,
      productDescription: config.product.description
    });
    console.log(`[pipeline] ICP: ${icp.summary || "(empty)"}`);

    console.log(`[pipeline] finding competitors via web_search`);
    competitors = await findCompetitors({
      icp,
      productName: config.product.name,
      productDescription: config.product.description,
      vendorCompanyName: config.company.name
    });
    console.log(`[pipeline] competitors: ${competitors.map((c) => c.name).join(", ") || "(none)"}`);
  }

  const counts: StageCounts = {
    input: leads.length,
    smtp_eligible: 0,
    catchall_skipped: 0,
    after_stage1_mx: 0,
    after_stage2_normalize: 0,
    after_stage3_classify: 0,
    after_stage4_email: 0,
    after_stage5_route: 0,
    uploaded_ok: 0,
    uploaded_failed: 0,
    supabase_succeeded: 0,
    supabase_failed: 0,
    drops_by_reason: {
      security_gateway: 0,
      no_email_found: 0,
      email_unverified: 0,
        unknown_domain_setting: 0,
        catchall_skipped: 0
    }
  };

  const removed: RemovedLead[] = [];
  const enriched: EnrichedLead[] = [];
  const uploadErrors: Array<{ email: string; campaign_id: string; error_message: string }> = [];

  const trykittCache = new Map<number, FindEmailResult>();
  const trykittBatchItems = leads
    .map((raw, i) => ({ raw, i }))
    .filter(({ raw }) => leadNeedsTryKitt(raw, opts.emptyEmailOnly))
    .map(({ raw, i }) => ({
      key: i,
      firstName: raw.first_name,
      lastName: raw.last_name,
      companyName: raw.company_name,
      companyWebsite: raw.company_website,
      personLinkedin: raw.linkedin
    }));

  if (trykittBatchItems.length > 0) {
    console.log(
      `[pipeline] trykitt batch prefetch: ${trykittBatchItems.length} jobs (parallel submit + GET /job poll)`
    );
    const batchResults = await findEmailsBatch(trykittBatchItems);
    for (const [key, result] of batchResults) {
      trykittCache.set(Number(key), result);
    }
    const found = [...batchResults.values()].filter((r) => r.email).length;
    console.log(`[pipeline] trykitt batch done: ${found}/${trykittBatchItems.length} emails found`);
  }

  const rowConcurrency = Math.max(
    1,
    Number(process.env.ROW_CONCURRENCY) || config.limits?.openaiConcurrency || 8
  );
  console.log(`[pipeline] parallel row processing: concurrency=${rowConcurrency}`);

  let completed = 0;
  const outcomes = await mapPool(leads, rowConcurrency, async (raw, i) => {
    const outcome = await processLeadRow(raw, config, startRow + i, leadsAll.length, {
      emptyEmailOnly: opts.emptyEmailOnly,
      leadIndex: i,
      trykittCache
    });
    completed++;
    if (completed % 25 === 0) {
      console.log(
        `[${completed}/${leads.length}] batch progress (global ~${startRow + completed}/${leadsAll.length})`
      );
    }
    return outcome;
  });

  for (const outcome of outcomes) {
    mergeCounts(counts, outcome.counts);
    if (outcome.kind === "removed") {
      removed.push(outcome.removed);
    } else {
      enriched.push(outcome.enriched);
      if (outcome.uploadError) uploadErrors.push(outcome.uploadError);
    }
  }

  console.log(`[pipeline] stage 6: supabase upsert (${enriched.length} rows)`);
  const supabaseRows = enriched.map((e) => toSupabaseRow(e, icp, competitors));
  const supReport = await upsertLeads(supabaseRows);
  counts.supabase_succeeded = supReport.succeeded;
  counts.supabase_failed = supReport.failed;

  writeArtifacts({
    outDir: opts.outDir,
    enriched,
    removed,
    uploadErrors,
    counts,
    icp,
    competitors,
    config,
    supReport,
    totalRowsInFile: leadsAll.length,
    startRow,
    continuationNote: opts.continuationNote
  });

  console.log(`[pipeline] done. artifacts in ${opts.outDir}`);
}

function readConfig(p: string): FinanceConfig {
  const text = fs.readFileSync(p, "utf-8");
  return JSON.parse(text) as FinanceConfig;
}

function validateConfig(c: FinanceConfig): void {
  const missing: string[] = [];
  if (!c.company?.description) missing.push("company.description");
  if (!c.product?.description) missing.push("product.description");
  if (!c.campaigns?.smtp?.workspaceId) missing.push("campaigns.smtp.workspaceId");
  if (!c.campaigns?.smtp?.campaignId) missing.push("campaigns.smtp.campaignId");
  if (!c.campaigns?.catchAll?.workspaceId) missing.push("campaigns.catchAll.workspaceId");
  if (!c.campaigns?.catchAll?.campaignId) missing.push("campaigns.catchAll.campaignId");
  if (missing.length > 0) {
    throw new Error(
      `Config is missing required fields: ${missing.join(", ")}. See configs/finance.json.`
    );
  }
}

function readLeadsCsv(p: string): LeadRow[] {
  const text = fs.readFileSync(p, "utf-8");
  const records = parse(text, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as LeadRow[];
  for (const row of records) {
    if (!row.company_products_services && row.company_product_and_services) {
      row.company_products_services = row.company_product_and_services;
    }
  }
  return records;
}

function toSupabaseRow(e: EnrichedLead, _icp: ICP, _competitors: Competitor[]): SupabaseLeadRow {
  const r = e.raw;
  return {
    Email: e.active_email,
    "First Name": cleanText(r.first_name) || null,
    "Last Name": cleanText(r.last_name) || null,
    Linkedin: cleanText(r.linkedin) || null,
    "Company Name": cleanText(r.company_name) || null,
    Website: cleanText(r.company_website) || null
  };
}

function writeArtifacts(args: {
  outDir: string;
  enriched: EnrichedLead[];
  removed: RemovedLead[];
  uploadErrors: Array<{ email: string; campaign_id: string; error_message: string }>;
  counts: StageCounts;
  icp: ICP;
  competitors: Competitor[];
  config: FinanceConfig;
  supReport: { attempted: number; succeeded: number; failed: number; errors: Array<{ chunk: number; message: string }> };
  totalRowsInFile: number;
  startRow: number;
  continuationNote?: string;
}): void {
  const {
    outDir,
    enriched,
    removed,
    uploadErrors,
    counts,
    icp,
    competitors,
    config,
    supReport,
    totalRowsInFile,
    startRow,
    continuationNote
  } = args;

  const enrichedRows = enriched.map((e) => ({
    email: e.active_email,
    first_name: cleanText(e.raw.first_name),
    last_name: cleanText(e.raw.last_name),
    title: cleanText(e.raw.title),
    company_name: cleanText(e.raw.company_name),
    company_name_normalized: e.company_name_normalized,
    company_type: e.company_type,
    facility_type: e.facility_type,
    talent_type: e.talent_type,
    esp_classification: e.esp_classification,
    domain_settings: e.domain_settings,
    email_source: e.email_source,
    email_verification_status: e.email_verification_status ?? "",
    plusvibe_workspace_id: e.plusvibe_workspace_id,
    plusvibe_campaign_id: e.plusvibe_campaign_id,
    upload_ok: e.upload_ok ? "true" : "false",
    upload_error: e.upload_error ?? "",
    company_website: cleanText(e.raw.company_website),
    company_linkedin: cleanText(e.raw.company_linkedin),
    company_size: cleanText(e.raw.company_size),
    company_industry: cleanText(e.raw.company_industry),
    linkedin: cleanText(e.raw.linkedin),
    city: cleanText(e.raw.city),
    state: cleanText(e.raw.state),
    country: cleanText(e.raw.country)
  }));

  fs.writeFileSync(
    path.join(outDir, "enriched_leads.csv"),
    stringify(enrichedRows, { header: true })
  );

  const removedRows = removed.map((r) => ({
    email: r.email,
    domain: r.domain,
    reason: r.reason,
    detail: r.detail ?? "",
    first_name: cleanText(r.raw.first_name),
    last_name: cleanText(r.raw.last_name),
    company_name: cleanText(r.raw.company_name),
    company_website: cleanText(r.raw.company_website)
  }));
  fs.writeFileSync(
    path.join(outDir, "removed_leads.csv"),
    stringify(removedRows, { header: true })
  );

  fs.writeFileSync(
    path.join(outDir, "upload_errors.csv"),
    stringify(uploadErrors, { header: true })
  );

  const summary = {
    timestamp: new Date().toISOString(),
    vertical: config.vertical,
    total_rows_in_file: totalRowsInFile,
    start_row: startRow,
    continuation_note: continuationNote ?? null,
    counts,
    supabase: supReport,
    icp,
    competitors,
    campaigns_used: {
      smtp: config.campaigns.smtp,
      catchAll: config.campaigns.catchAll
    },
    operator_report: {
      processed_this_batch: counts.input,
      smtp_eligible: counts.smtp_eligible,
      catchall_skipped: counts.catchall_skipped,
      enriched: enriched.length,
      uploaded: counts.uploaded_ok,
      failed_by_reason: counts.drops_by_reason
    }
  };
  fs.writeFileSync(path.join(outDir, "run_summary.json"), JSON.stringify(summary, null, 2));
}
