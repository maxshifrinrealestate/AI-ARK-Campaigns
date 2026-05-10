import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { classifyMx, cleanText, resolveLeadDomain } from "../functions/classifyMx.js";
import { normalizeCompany } from "../functions/normalizeCompany.js";
import { enrichFacilityAndTalent } from "../functions/enrichFacilityAndTalent.js";
import { findEmail } from "../functions/findEmail.js";
import { verifyEmail } from "../functions/verifyEmail.js";

type LeadRow = Record<string, string>;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

async function run(): Promise<void> {
  const input = argValue("--input");
  const output = argValue("--output");
  if (!input || !output) {
    throw new Error("Usage: npx tsx scripts/enrich10-no-upload.ts --input <csv> --output <csv>");
  }

  const raw = fs.readFileSync(input, "utf-8");
  const leads = parse(raw, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as LeadRow[];

  const slice = leads.slice(0, 10);
  const rows: Record<string, string>[] = [];
  const summary = {
    processed: slice.length,
    activeEligible: 0,
    enriched: 0,
    skippedNoActiveEmail: 0,
    skippedSecurityGateway: 0
  };

  for (let i = 0; i < slice.length; i++) {
    const lead = slice[i]!;
    const emailBusiness = cleanText(lead.email_business);
    const domain = resolveLeadDomain(emailBusiness, lead.company_website);
    const mx = await classifyMx(domain);

    let emailFound = "";
    let verificationStatus = "";
    let verifiedEmail = "";
    let activeEmail = "";
    let emailSource = "";
    let gateReason = "";
    let companyNameNormalized = "";
    let facilityType = "";
    let talentType = "";

    if (mx.isSeg) {
      gateReason = "security_gateway";
      summary.skippedSecurityGateway += 1;
    } else if (emailBusiness) {
      activeEmail = emailBusiness.toLowerCase();
      emailSource = "csv";
      summary.activeEligible += 1;
    } else {
      const found = await findEmail({
        firstName: lead.first_name,
        lastName: lead.last_name,
        companyWebsite: lead.company_website,
        companyLinkedin: lead.company_linkedin
      });
      emailFound = found.email ?? "";
      if (!found.email) {
        gateReason = "no_email_found";
      } else {
        const verified = await verifyEmail(found.email);
        verificationStatus = verified.status;
        if (!verified.accepted) {
          gateReason = "email_unverified";
        } else {
          verifiedEmail = found.email.toLowerCase();
          activeEmail = found.email;
          emailSource = "trykit";
          summary.activeEligible += 1;
        }
      }
    }

    if (activeEmail) {
      companyNameNormalized = await normalizeCompany(lead.company_name);
      const facilityTalent = await enrichFacilityAndTalent({
        companyNameNormalized,
        companyDescription: lead.company_description,
        companyProductsServices: lead.company_products_services,
        title: lead.title
      });
      facilityType = facilityTalent.facilityType;
      talentType = facilityTalent.talentType;
      summary.enriched += 1;
    } else {
      summary.skippedNoActiveEmail += 1;
    }

    rows.push({
      ...lead,
      mx_classification: mx.esp,
      is_security_gateway: mx.isSeg ? "true" : "false",
      email_found_trykitt: emailFound,
      email_verification_status: verificationStatus,
      verified_email: verifiedEmail,
      active_email: activeEmail,
      email_source: emailSource,
      gate_reason: gateReason,
      final_emails: [emailBusiness, verifiedEmail].filter(Boolean).join(", "),
      company_name_normalized: companyNameNormalized,
      facility_type: facilityType,
      talent_type: talentType
    });

    console.log(
      `[${i + 1}/${slice.length}] ${lead.first_name ?? ""} ${lead.last_name ?? ""} -> ${
        activeEmail || gateReason || "skipped"
      } | source=${emailSource || "none"} | found=${emailFound || "n/a"} | verify=${verificationStatus || "n/a"} | esp=${
        mx.esp
      }`
    );
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, stringify(rows, { header: true }));
  console.log(`Wrote ${rows.length} enriched rows to ${output}`);
  console.log(
    `Summary: processed=${summary.processed}, active_email_eligible=${summary.activeEligible}, enriched=${summary.enriched}, skipped_no_active_email=${summary.skippedNoActiveEmail}, skipped_security_gateway=${summary.skippedSecurityGateway}`
  );
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
