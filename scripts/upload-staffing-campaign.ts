import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { classifyMx, cleanText, resolveLeadDomain } from "../functions/classifyMx.js";
import { normalizeCompany } from "../functions/normalizeCompany.js";
import { classifyCompanyType } from "../functions/classifyCompanyType.js";
import { enrichStaffingTalent } from "../functions/enrichStaffingTalent.js";
import { routeCampaign, type CampaignsConfig } from "../functions/routeCampaign.js";
import { mapPool } from "../functions/mapPool.js";
import {
  resolveWorkspaceId,
  uploadLeadsBatch,
  type PlusVibeLeadPayload
} from "../integrations/plusvibe.js";

type LeadRow = Record<string, string>;
type StaffingConfig = {
  vertical: string;
  company: { name?: string; description: string };
  product: { name?: string; description: string };
  campaigns: CampaignsConfig;
  limits?: { openaiConcurrency?: number; uploadConcurrency?: number };
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
  email: string;
  company_name: string;
  client_type: string;
  talent_type: string;
  city: string;
  state: string;
  linkedin: string;
  company_website: string;
  email_body: string;
  domain_settings: string;
  email_source: string;
  plusvibe_workspace_id: string;
  plusvibe_campaign_id: string;
  upload_ok: string;
  upload_error: string;
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
  return parse(fs.readFileSync(p, "utf-8"), {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as LeadRow[];
}

function readConfig(p: string): StaffingConfig {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as StaffingConfig;
}

function productsField(lead: LeadRow): string {
  return cleanText(lead.company_product_and_services ?? lead.company_products_services);
}

function salutationFirstName(raw: LeadRow): string {
  const scripted = cleanText(raw.salutation_first_name);
  if (scripted) return scripted;
  const first = cleanText(raw.first_name);
  return first.split(/\s+/)[0] || first;
}

function wrapEmailBody(raw: LeadRow): string {
  const body = cleanText(raw.email_body);
  if (!body) return "";
  if (body.startsWith("<div>")) return body;
  const first = salutationFirstName(raw);
  const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  const htmlLines = lines.map((line, i) => {
    const text = i === 0 && first && !line.startsWith(first) ? `${first}, ${line}` : line;
    return text;
  });
  return `<div>${htmlLines.join("<br>")}</div>`;
}


async function processRow(
  raw: LeadRow,
  config: StaffingConfig,
  workspaceId: string,
  _index: number,
  dryRun: boolean
): Promise<{ kind: "removed"; removed: RemovedLead } | { kind: "uploaded"; uploaded: UploadedLead; payload: PlusVibeLeadPayload }> {
  const firstName = salutationFirstName(raw);
  const lastName = cleanText(raw.last_name);
  const companyName = cleanText(raw.company_name);

  const drop = (reason: string, email = "", detail?: string) => ({
    kind: "removed" as const,
    removed: { first_name: firstName, last_name: lastName, company_name: companyName, email, reason, detail }
  });

  const emailBusiness = cleanText(raw.email_business);
  if (!emailBusiness) return drop("no_email_found");

  const companyWebsite = cleanText(raw.company_website);
  const domain = resolveLeadDomain(emailBusiness, companyWebsite);

  let mx;
  try {
    mx = domain ? await classifyMx(domain) : { domain: "", mxData: "", esp: "empty" as const, isSeg: false };
  } catch {
    mx = { domain, mxData: "", esp: "empty" as const, isSeg: false };
  }
  if (mx.isSeg) return drop("security_gateway", emailBusiness, mx.mxData);
  if (mx.esp === "outlook") return drop("outlook_skipped", emailBusiness, mx.mxData);

  const activeEmail = emailBusiness.toLowerCase();
  const emailSource = "csv";

  const companyNameNormalized = await normalizeCompany(raw.company_name);
  const companyType = await classifyCompanyType({
    companyNameNormalized,
    companyDescription: raw.company_description,
    companyProductsServices: productsField(raw)
  });
  const staffing = await enrichStaffingTalent({
    companyNameNormalized,
    companyDescription: raw.company_description,
    companyProductsServices: productsField(raw),
    title: raw.title
  });

  const route = routeCampaign(raw.domain_settings, config.campaigns);
  if (!route.ok) return drop("unknown_domain_setting", activeEmail, route.rawValue);

  const emailBody = wrapEmailBody(raw);
  if (!emailBody) return drop("missing_email_body", activeEmail);

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
      custom_state: cleanText(raw.state) || "",
      custom_title: cleanText(raw.title) || "",
      custom_company_type: companyType || "",
      custom_client_type: staffing.clientType || "",
      custom_talent_type: staffing.talentType || "",
      custom_email_body: emailBody,
      custom_cold_email: emailBody
    }
  };

  const uploaded: UploadedLead = {
    first_name: firstName,
    last_name: lastName,
    email: activeEmail,
    company_name: companyNameNormalized || companyName,
    client_type: staffing.clientType,
    talent_type: staffing.talentType,
    city: cleanText(raw.city),
    state: cleanText(raw.state),
    linkedin: cleanText(raw.linkedin),
    company_website: companyWebsite,
    email_body: emailBody,
    domain_settings: route.setting,
    email_source: emailSource,
    plusvibe_workspace_id: workspaceId,
    plusvibe_campaign_id: route.target.campaignId,
    upload_ok: dryRun ? "dry_run" : "pending",
    upload_error: ""
  };

  return { kind: "uploaded", uploaded, payload };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function run(): Promise<void> {
  const input = argValue("--input") ?? "data/staffing_leads_24.csv";
  const configPath = argValue("--config") ?? "configs/staffing_zs.json";
  const outDir = path.resolve(argValue("--out-dir") ?? `staffing_zs_run_${Date.now()}`);
  const workspaceName = argValue("--workspace") ?? process.env.PLUSVIBE_WORKSPACE_NAME ?? "zs";
  const campaignId =
    argValue("--campaign") ?? process.env.STAFFING_CAMPAIGN_ID ?? "6a414d310cd53ac8421e1e91";
  const dryRun = hasFlag("--dry-run");
  const skipUpload = hasFlag("--skip-upload") || dryRun;
  const concurrency = Math.max(1, Number(argValue("--concurrency") ?? "5"));
  const uploadBatchSize = Math.max(1, Number(argValue("--upload-batch") ?? "5"));

  const required = ["PLUSVIBE_KEY", "OPENAI_API_KEY"];
  if (!skipUpload && !dryRun) {
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }

  const config = readConfig(configPath);
  config.campaigns.smtp.campaignId = campaignId;
  config.campaigns.catchAll.campaignId = campaignId;

  const leadsAll = readLeadsCsv(input);
  const leads = leadsAll.filter((r) => cleanText(r.email_business));
  const noEmailRemoved: RemovedLead[] = leadsAll
    .filter((r) => !cleanText(r.email_business))
    .map((r) => ({
      first_name: salutationFirstName(r),
      last_name: cleanText(r.last_name),
      company_name: cleanText(r.company_name),
      email: "",
      reason: "no_email_found",
      detail: "skipped without enrichment"
    }));

  const workspaceId =
    dryRun || skipUpload
      ? config.campaigns.smtp.workspaceId
      : await resolveWorkspaceId(workspaceName).catch(() => config.campaigns.smtp.workspaceId);
  config.campaigns.smtp.workspaceId = workspaceId;
  config.campaigns.catchAll.workspaceId = workspaceId;

  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[staffing] ${leads.length} leads with email from ${input}`);
  console.log(`[staffing] workspace=${workspaceId} (${workspaceName}) campaign=${campaignId}`);
  console.log(`[staffing] dryRun=${dryRun} skipUpload=${skipUpload} skipOutlook=true`);

  const uploaded: UploadedLead[] = [];
  const removed: RemovedLead[] = [];
  const uploadQueue: PlusVibeLeadPayload[] = [];

  let completed = 0;
  const outcomes = await mapPool(leads, concurrency, async (raw, i) => {
    const outcome = await processRow(raw, config, workspaceId, i, dryRun);
    completed++;
    if (completed % 5 === 0 || completed === leads.length) {
      console.log(`[staffing] enriched ${completed}/${leads.length}`);
    }
    return outcome;
  });

  for (const outcome of outcomes) {
    if (outcome.kind === "removed") {
      removed.push(outcome.removed);
      continue;
    }
    uploaded.push(outcome.uploaded);
    if (!dryRun && !skipUpload) uploadQueue.push(outcome.payload);
  }
  removed.push(...noEmailRemoved);

  let uploadOk = 0;
  let uploadFailed = 0;
  const uploadErrors: Array<{ email: string; error: string }> = [];

  if (!dryRun && !skipUpload && uploadQueue.length > 0) {
    const batches: PlusVibeLeadPayload[][] = [];
    for (let i = 0; i < uploadQueue.length; i += uploadBatchSize) {
      batches.push(uploadQueue.slice(i, i + uploadBatchSize));
    }
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      const result = await uploadLeadsBatch(batch, { workspaceId, campaignId });
      if (result.ok) {
        uploadOk += batch.length;
      } else {
        uploadFailed += batch.length;
        for (const lead of batch) {
          uploadErrors.push({ email: lead.email, error: result.error });
        }
      }
      console.log(`[staffing] upload batch ${i + 1}/${batches.length}: ok=${result.ok}`);
      await sleep(250);
    }
    for (const row of uploaded) {
      const err = uploadErrors.find((e) => e.email === row.email);
      row.upload_ok = err ? "false" : "true";
      row.upload_error = err?.error ?? "";
    }
  }

  fs.writeFileSync(path.join(outDir, "uploaded_leads.csv"), stringify(uploaded, { header: true }));
  fs.writeFileSync(path.join(outDir, "removed_leads.csv"), stringify(removed, { header: true }));
  fs.writeFileSync(path.join(outDir, "upload_errors.csv"), stringify(uploadErrors, { header: true }));
  fs.writeFileSync(
    path.join(outDir, "run_summary.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        input,
        workspace_id: workspaceId,
        campaign_id: campaignId,
        total: leadsAll.length,
        with_email: leads.length,
        uploaded: uploaded.length,
        removed: removed.length,
        plusvibe_ok: uploadOk,
        plusvibe_failed: uploadFailed,
        removed_by_reason: removed.reduce<Record<string, number>>((acc, r) => {
          acc[r.reason] = (acc[r.reason] ?? 0) + 1;
          return acc;
        }, {})
      },
      null,
      2
    )
  );

  console.log(
    `[staffing] done uploaded=${uploaded.length} removed=${removed.length} plusvibe_ok=${uploadOk} plusvibe_failed=${uploadFailed}`
  );
  console.log(`[staffing] artifacts in ${outDir}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
