/**
 * Upload prepared JSON batches via Supabase RPC (function created via MCP migration).
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const BATCH_DIR = path.join(
  process.cwd(),
  "outputs",
  process.env.SUPABASE_BATCH_OUT ?? "supabase_batches_snf_trykitt"
);

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_KEY required in .env");

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const files = fs
    .readdirSync(BATCH_DIR)
    .filter((f) => f.startsWith("batch_") && f.endsWith(".json"))
    .sort();

  let totalInserted = 0;
  let totalUpdated = 0;

  for (const file of files) {
    const payload = JSON.parse(fs.readFileSync(path.join(BATCH_DIR, file), "utf-8"));
    const { data, error } = await supabase.rpc("upsert_lead_database_rows", { payload });
    if (error) {
      console.error(`FAIL ${file}:`, error.message);
      process.exitCode = 1;
      continue;
    }
    const row = data as { inserted?: number; updated?: number };
    const inserted = Number(row?.inserted ?? 0);
    const updated = Number(row?.updated ?? 0);
    totalInserted += inserted;
    totalUpdated += updated;
    console.log(`${file}: inserted=${inserted} updated=${updated}`);
  }

  console.log(
    JSON.stringify({
      batches: files.length,
      total_inserted: totalInserted,
      total_updated: totalUpdated,
      total_upserted: totalInserted + totalUpdated
    })
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
