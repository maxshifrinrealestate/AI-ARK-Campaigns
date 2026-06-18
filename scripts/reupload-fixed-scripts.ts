import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { cleanText } from "../functions/classifyMx.js";
import { mapPool } from "../functions/mapPool.js";
import { countWords, personalizeEmailLocal } from "../functions/personalizeEmail.js";
import { uploadLead } from "../integrations/plusvibe.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function productsField(lead: Record<string, string>): string {
  return cleanText(lead.company_product_and_services ?? lead.company_products_services);
}

async function run(): Promise<void> {
  const leadsPath = argValue("--leads") ?? "data/batch_5k.csv";
  const uploadedPath = argValue("--uploaded") ?? "run_outputs_batch_5k/uploaded_leads.csv";
  const outDir = argValue("--out") ?? "run_outputs_batch_5k_fixed";
  const workspaceId = argValue("--workspace") ?? "694c1ae9ebef3b84192da7fc";
  const campaignId = argValue("--campaign") ?? "6a339841a22d44d769190604";
  const dryRun = process.argv.includes("--dry-run");

  if (!process.env.PLUSVIBE_KEY && !dryRun) {
    throw new Error("PLUSVIBE_KEY required");
  }

  const allLeads = parse(fs.readFileSync(leadsPath, "utf-8"), {
    columns: (h: string[]) => h.map((x) => x.trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as Record<string, string>[];

  const uploadedRows = parse(fs.readFileSync(uploadedPath, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true
  }) as Array<Record<string, string>>;

  const byEmail = new Map<string, Record<string, string>>();
  const byPerson = new Map<string, Record<string, string>>();
  for (const row of allLeads) {
    const email = cleanText(row.email_business).toLowerCase();
    if (email) byEmail.set(email, row);
    byPerson.set(
      `${cleanText(row.first_name).toLowerCase()}|${cleanText(row.last_name).toLowerCase()}|${cleanText(row.company_name).toLowerCase()}`,
      row
    );
  }

  const concurrency = Math.max(1, Number(process.env.ROW_CONCURRENCY) || 12);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[fix] regenerating + re-uploading ${uploadedRows.length} leads`);

  let done = 0;
  let ok = 0;
  let failed = 0;

  const results = await mapPool(uploadedRows, concurrency, async (u, i) => {
    const email = cleanText(u.email).toLowerCase();
    let raw = byEmail.get(email);
    if (!raw) {
      raw = byPerson.get(
        `${cleanText(u.first_name).toLowerCase()}|${cleanText(u.last_name).toLowerCase()}|${cleanText(u.company_name).toLowerCase()}`
      );
    }
    if (!raw) {
      failed++;
      return { email, ok: false, error: "lead_not_in_source_csv" };
    }

    const personalized = personalizeEmailLocal({
      firstName: raw.first_name,
      lastName: raw.last_name,
      title: raw.title,
      headline: raw.headline,
      companyName: raw.company_name,
      companyDescription: raw.company_description,
      companyProductsServices: productsField(raw),
      companyIndustry: raw.company_industry,
      city: raw.city,
      state: raw.state,
      country: raw.country,
      rowIndex: i
    });

    if (!dryRun) {
      const upload = await uploadLead(
        {
          email,
          first_name: cleanText(raw.first_name) || undefined,
          last_name: cleanText(raw.last_name) || undefined,
          company_name: cleanText(raw.company_name) || undefined,
          custom_variables: {
            custom_email_body: personalized.body,
            custom_talent_type: u.talent_type ?? "",
            custom_facility_type: u.facility_type ?? ""
          }
        },
        { workspaceId, campaignId }
      );
      if (!upload.ok) {
        failed++;
        return { email, ok: false, error: upload.error, email_body: personalized.body };
      }
    }

    ok++;
    done++;
    if (done % 200 === 0 || done === uploadedRows.length) {
      console.log(`[fix] progress ${done}/${uploadedRows.length} ok=${ok} failed=${failed}`);
    }

    return {
      email,
      ok: true,
      email_body: personalized.body,
      word_count: String(personalized.wordCount)
    };
  });

  const fixed = results.filter((r) => r?.ok);
  fs.writeFileSync(
    path.join(outDir, "reuploaded_leads.csv"),
    stringify(
      fixed.map((r) => ({
        email: r!.email,
        email_body: r!.email_body,
        word_count: r!.word_count
      })),
      { header: true }
    )
  );

  const errors = results.filter((r) => r && !r.ok);
  fs.writeFileSync(path.join(outDir, "reupload_errors.csv"), stringify(errors, { header: true }));

  console.log(`[fix] done: ${ok} re-uploaded, ${failed} failed`);
  if (fixed[0]?.email_body) {
    console.log(`[fix] sample: ${fixed[0].email_body.replace(/<[^>]+>/g, " ").slice(0, 180)}`);
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
