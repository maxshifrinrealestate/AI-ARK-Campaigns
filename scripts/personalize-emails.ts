import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { cleanText } from "../functions/classifyMx.js";
import { enrichFacilityAndTalent } from "../functions/enrichFacilityAndTalent.js";
import { mapPool } from "../functions/mapPool.js";
import { normalizeCompany } from "../functions/normalizeCompany.js";
import { personalizeEmail } from "../functions/personalizeEmail.js";

type LeadRow = Record<string, string>;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function run(): Promise<void> {
  const input = argValue("--input");
  const output = argValue("--output");
  const limitRaw = argValue("--limit");
  const concurrency = Math.max(1, Number(argValue("--concurrency") ?? process.env.ROW_CONCURRENCY ?? 8));
  const skipEnrich = hasFlag("--skip-enrich");

  if (!input || !output) {
    throw new Error(
      "Usage: npx tsx scripts/personalize-emails.ts --input <csv> --output <csv> [--limit N] [--concurrency N] [--skip-enrich]"
    );
  }

  const raw = fs.readFileSync(input, "utf-8");
  const leads = parse(raw, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  }) as LeadRow[];

  const limit = limitRaw ? Math.max(1, Number(limitRaw)) : leads.length;
  const slice = leads.slice(0, limit);

  console.log(`[personalize] ${slice.length} rows from ${input} (concurrency=${concurrency})`);

  const started = Date.now();
  const rows = await mapPool(slice, concurrency, async (lead, i) => {
    const companyNameNormalized = skipEnrich
      ? cleanText(lead.company_name)
      : await normalizeCompany(lead.company_name);

    let facilityType = cleanText(lead.facility_type);
    let talentType = cleanText(lead.talent_type);

    if (!skipEnrich && (!facilityType || !talentType)) {
      const ft = await enrichFacilityAndTalent({
        companyNameNormalized,
        companyDescription: lead.company_description,
        companyProductsServices: lead.company_product_and_services ?? lead.company_products_services,
        title: lead.title
      });
      facilityType = facilityType || ft.facilityType;
      talentType = talentType || ft.talentType;
    }

    const result = await personalizeEmail({
      firstName: lead.first_name,
      lastName: lead.last_name,
      title: lead.title,
      headline: lead.headline,
      companyName: companyNameNormalized || lead.company_name,
      companyDescription: lead.company_description,
      companyProductsServices: lead.company_product_and_services ?? lead.company_products_services,
      companyIndustry: lead.company_industry,
      city: lead.city,
      state: lead.state,
      country: lead.country,
      facilityType,
      talentType,
      rowIndex: i
    });

    console.log(
      `[${i + 1}/${slice.length}] ${cleanText(lead.first_name)} ${cleanText(lead.last_name)} — ${result.wordCount} words`
    );

    return {
      first_name: cleanText(lead.first_name),
      last_name: cleanText(lead.last_name),
      title: cleanText(lead.title),
      company_name: cleanText(lead.company_name),
      company_name_normalized: companyNameNormalized,
      facility_type: facilityType,
      talent_type: talentType,
      email_body: result.body,
      word_count: String(result.wordCount),
      cta_style: result.ctaStyle,
      opener_style: result.openerStyle
    };
  });

  const elapsedMs = Date.now() - started;
  const perRowMs = slice.length > 0 ? elapsedMs / slice.length : 0;

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, stringify(rows, { header: true }));

  console.log(`Wrote ${rows.length} personalized emails to ${output}`);
  console.log(
    `Timing: ${(elapsedMs / 1000).toFixed(1)}s total, ${perRowMs.toFixed(0)}ms/row avg` +
      ` | projected 1k=${formatDuration(perRowMs * 1000)}` +
      ` 5k=${formatDuration(perRowMs * 5000)}` +
      ` 10k=${formatDuration(perRowMs * 10000)}`
  );
}

function formatDuration(ms: number): string {
  const sec = ms / 1000;
  if (sec < 120) return `${sec.toFixed(0)}s`;
  const min = sec / 60;
  if (min < 120) return `${min.toFixed(1)} min`;
  return `${(min / 60).toFixed(1)} hr`;
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
