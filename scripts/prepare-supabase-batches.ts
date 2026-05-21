/**
 * Merge enriched_leads.csv from SNF shard outputs into JSON batch files for MCP SQL upsert.
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

const ROOT = process.cwd();
const SOURCES = (
  process.env.SUPABASE_BATCH_SOURCES?.split(",").map((s) => s.trim()).filter(Boolean) ?? [
    "run_outputs_snf_trykitt_shard0",
    "run_outputs_snf_trykitt_shard1",
    "run_outputs_snf_trykitt_shard2",
    "run_outputs_snf_trykitt_shard3"
  ]
);

type Row = {
  Email: string;
  "First Name": string | null;
  "Last Name": string | null;
  Linkedin: string | null;
  "Company Name": string | null;
  Website: string | null;
};

function clean(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s || null;
}

function main(): void {
  const byEmail = new Map<string, Row>();

  for (const dir of SOURCES) {
    const csvPath = path.join(ROOT, dir, "enriched_leads.csv");
    if (!fs.existsSync(csvPath)) {
      console.warn(`skip missing ${csvPath}`);
      continue;
    }
    const text = fs.readFileSync(csvPath, "utf-8");
    const records = parse(text, { columns: true, skip_empty_lines: true, bom: true }) as Record<
      string,
      string
    >[];
    for (const r of records) {
      if (String(r.upload_ok).toLowerCase() !== "true") continue;
      const email = clean(r.email);
      if (!email) continue;
      const key = email.toLowerCase();
      byEmail.set(key, {
        Email: email,
        "First Name": clean(r.first_name),
        "Last Name": clean(r.last_name),
        Linkedin: clean(r.linkedin),
        "Company Name": clean(r.company_name_normalized) ?? clean(r.company_name),
        Website: clean(r.company_website)
      });
    }
  }

  const rows = [...byEmail.values()];
  const outDir = path.join(ROOT, "outputs", process.env.SUPABASE_BATCH_OUT ?? "supabase_batches_snf_trykitt");
  fs.mkdirSync(outDir, { recursive: true });

  const batchSize = 50;
  let batchIdx = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    fs.writeFileSync(
      path.join(outDir, `batch_${String(batchIdx).padStart(3, "0")}.json`),
      JSON.stringify(chunk)
    );
    batchIdx++;
  }

  const manifest = { total_rows: rows.length, batches: batchIdx, outDir };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest));
}

main();
