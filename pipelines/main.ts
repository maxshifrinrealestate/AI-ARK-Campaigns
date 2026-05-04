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
import { findEmail } from "../functions/findEmail.js";
import { verifyEmail } from "../functions/verifyEmail.js";
import { routeCampaign, type CampaignsConfig } from "../functions/routeCampaign.js";
import { uploadLead, type PlusVibeLeadPayload } from "../integrations/plusvibe.js";
import { upsertLeads, type SupabaseLeadRow } from "../integrations/supabase.js";

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
};

type LeadRow = Record<string, string>;

type RemovedLead = {
  reason: "security_gateway" | "no_email_found" | "email_unverified" | "unknown_domain_setting";
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
  plusvibe_workspace_id: string;
  plusvibe_campaign_id: string;
  upload_ok: boolean;
  upload_error?: string;
};

type StageCounts = {
  input: number;
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

export async function runPipeline(opts: PipelineOptions): Promise<void> {
  fs.mkdirSync(opts.outDir, { recursive: true });

  const config = readConfig(opts.configPath);
  validateConfig(config);

  const leadsAll = readLeadsCsv(opts.leadsPath);
  const leads = opts.pilot && opts.pilot > 0 ? leadsAll.slice(0, opts.pilot) : leadsAll;

  console.log(`[pipeline] loaded ${leadsAll.length} leads from ${opts.leadsPath}`);
  if (opts.pilot) console.log(`[pipeline] pilot mode: processing first ${leads.length}`);

  console.log(`[pipeline] generating ICP for vertical=${config.vertical}`);
  const icp: ICP = await findICP({
    companyName: config.company.name,
    companyDescription: config.company.description,
    productName: config.product.name,
    productDescription: config.product.description
  });
  console.log(`[pipeline] ICP: ${icp.summary || "(empty)"}`);

  console.log(`[pipeline] finding competitors via web_search`);
  const competitors: Competitor[] = await findCompetitors({
    icp,
    productName: config.product.name,
    productDescription: config.product.description,
    vendorCompanyName: config.company.name
  });
  console.log(`[pipeline] competitors: ${competitors.map((c) => c.name).join(", ") || "(none)"}`);

  const counts: StageCounts = {
    input: leads.length,
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
      unknown_domain_setting: 0
    }
  };

  const removed: RemovedLead[] = [];
  const enriched: EnrichedLead[] = [];
  const uploadErrors: Array<{ email: string; campaign_id: string; error_message: string }> = [];

  for (let i = 0; i < leads.length; i++) {
    const raw = leads[i]!;
    const tag = `[${i + 1}/${leads.length}]`;

    const emailBusiness = cleanText(raw.email_business);
    const companyWebsite = cleanText(raw.company_website);
    const domain = resolveLeadDomain(emailBusiness, companyWebsite);

    let mx;
    try {
      mx = await classifyMx(domain);
    } catch (err) {
      console.warn(`${tag} stage1 mx error: ${(err as Error).message}`);
      mx = { domain, mxData: "", esp: "empty" as const, isSeg: false };
    }

    if (mx.isSeg) {
      removed.push({
        reason: "security_gateway",
        email: emailBusiness,
        domain,
        raw,
        detail: mx.mxData
      });
      counts.drops_by_reason.security_gateway++;
      continue;
    }
    counts.after_stage1_mx++;

    const companyNameNormalized = await normalizeCompany(raw.company_name);
    counts.after_stage2_normalize++;

    const companyType = await classifyCompanyType({
      companyNameNormalized,
      companyDescription: raw.company_description,
      companyProductsServices: raw.company_products_services
    });
    counts.after_stage3_classify++;

    let activeEmail = "";
    let emailSource: "csv" | "trykit" = "csv";
    let verificationStatus: string | null = null;

    if (emailBusiness) {
      activeEmail = emailBusiness.toLowerCase();
      emailSource = "csv";
      verificationStatus = null;
    } else {
      const found = await findEmail({
        firstName: raw.first_name,
        lastName: raw.last_name,
        companyWebsite: raw.company_website,
        companyLinkedin: raw.company_linkedin
      });
      if (!found.email) {
        removed.push({ reason: "no_email_found", email: "", domain: found.domainUsed || domain, raw });
        counts.drops_by_reason.no_email_found++;
        continue;
      }
      const verify = await verifyEmail(found.email);
      verificationStatus = verify.status;
      if (!verify.accepted) {
        removed.push({
          reason: "email_unverified",
          email: found.email,
          domain: domainFromEmail(found.email),
          raw,
          detail: verify.status
        });
        counts.drops_by_reason.email_unverified++;
        continue;
      }
      activeEmail = found.email;
      emailSource = "trykit";
    }
    counts.after_stage4_email++;

    const route = routeCampaign(raw.domain_settings, config.campaigns);
    if (!route.ok) {
      removed.push({
        reason: "unknown_domain_setting",
        email: activeEmail,
        domain: domainFromEmail(activeEmail),
        raw,
        detail: route.rawValue
      });
      counts.drops_by_reason.unknown_domain_setting++;
      continue;
    }
    counts.after_stage5_route++;

    const payload: PlusVibeLeadPayload = {
      email: activeEmail,
      first_name: cleanText(raw.first_name) || undefined,
      last_name: cleanText(raw.last_name) || undefined,
      company_name: companyNameNormalized || cleanText(raw.company_name) || undefined,
      title: cleanText(raw.title) || undefined,
      linkedin: cleanText(raw.linkedin) || undefined,
      company_website: cleanText(raw.company_website) || undefined,
      company_linkedin: cleanText(raw.company_linkedin) || undefined,
      company_size: cleanText(raw.company_size) || undefined,
      company_industry: cleanText(raw.company_industry) || undefined,
      company_type: companyType || undefined,
      esp: mx.esp,
      city: cleanText(raw.city) || undefined,
      state: cleanText(raw.state) || undefined,
      country: cleanText(raw.country) || undefined
    };

    const upload = await uploadLead(payload, route.target);
    if (upload.ok) {
      counts.uploaded_ok++;
    } else {
      counts.uploaded_failed++;
      uploadErrors.push({
        email: activeEmail,
        campaign_id: route.target.campaignId,
        error_message: upload.error
      });
    }

    enriched.push({
      raw,
      active_email: activeEmail,
      email_source: emailSource,
      email_verification_status: verificationStatus,
      esp_classification: mx.esp,
      domain_settings: route.setting,
      company_name_normalized: companyNameNormalized,
      company_type: companyType,
      plusvibe_workspace_id: route.target.workspaceId,
      plusvibe_campaign_id: route.target.campaignId,
      upload_ok: upload.ok,
      upload_error: upload.ok ? undefined : upload.error
    });

    if ((i + 1) % 25 === 0) {
      console.log(
        `${tag} progress: enriched=${enriched.length} removed=${removed.length} upload_ok=${counts.uploaded_ok}`
      );
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
    supReport
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
  return records;
}

function toSupabaseRow(e: EnrichedLead, icp: ICP, competitors: Competitor[]): SupabaseLeadRow {
  const r = e.raw;
  return {
    email: e.active_email,
    first_name: cleanText(r.first_name) || null,
    last_name: cleanText(r.last_name) || null,
    title: cleanText(r.title) || null,
    linkedin: cleanText(r.linkedin) || null,
    city: cleanText(r.city) || null,
    state: cleanText(r.state) || null,
    country: cleanText(r.country) || null,
    company_name: cleanText(r.company_name) || null,
    company_name_normalized: e.company_name_normalized || null,
    company_type: e.company_type || null,
    company_size: cleanText(r.company_size) || null,
    company_industry: cleanText(r.company_industry) || null,
    company_website: cleanText(r.company_website) || null,
    company_linkedin: cleanText(r.company_linkedin) || null,
    esp_classification: e.esp_classification,
    domain_settings: e.domain_settings,
    email_source: e.email_source,
    email_verification_status: e.email_verification_status,
    plusvibe_workspace_id: e.plusvibe_workspace_id,
    plusvibe_campaign_id: e.plusvibe_campaign_id,
    icp_summary: icp.summary || null,
    competitors: competitors.length > 0 ? JSON.stringify(competitors) : null
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
}): void {
  const { outDir, enriched, removed, uploadErrors, counts, icp, competitors, config, supReport } = args;

  const enrichedRows = enriched.map((e) => ({
    email: e.active_email,
    first_name: cleanText(e.raw.first_name),
    last_name: cleanText(e.raw.last_name),
    title: cleanText(e.raw.title),
    company_name: cleanText(e.raw.company_name),
    company_name_normalized: e.company_name_normalized,
    company_type: e.company_type,
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
    counts,
    supabase: supReport,
    icp,
    competitors,
    campaigns_used: {
      smtp: config.campaigns.smtp,
      catchAll: config.campaigns.catchAll
    }
  };
  fs.writeFileSync(path.join(outDir, "run_summary.json"), JSON.stringify(summary, null, 2));
}
