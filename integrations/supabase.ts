import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { withRetry } from "./openai.js";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL/SUPABASE_KEY not set; the startup gate should have caught this.");
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return client;
}

export const SUPABASE_TABLE = process.env.SUPABASE_TABLE ?? "leads";

/** Row shape for Supabase table `Lead Database` (matches user column names). */
export type SupabaseLeadRow = {
  Email: string;
  "First Name"?: string | null;
  "Last Name"?: string | null;
  Linkedin?: string | null;
  "Company Name"?: string | null;
  Website?: string | null;
};

export type UpsertReport = {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Array<{ chunk: number; message: string }>;
};

export async function upsertLeads(
  rows: SupabaseLeadRow[],
  opts: { chunkSize?: number } = {}
): Promise<UpsertReport> {
  const chunkSize = opts.chunkSize ?? 500;
  const report: UpsertReport = { attempted: rows.length, succeeded: 0, failed: 0, errors: [] };
  if (rows.length === 0) return report;

  const supabase = getSupabase();
  const onConflict = process.env.SUPABASE_ON_CONFLICT ?? "Email";
  const stamped = rows.map((r) => ({ ...r }));

  for (let i = 0; i < stamped.length; i += chunkSize) {
    const chunk = stamped.slice(i, i + chunkSize);
    const chunkIdx = Math.floor(i / chunkSize);
    try {
      await withRetry(
        async () => {
          const { error } = await supabase
            .from(SUPABASE_TABLE)
            .upsert(chunk, { onConflict, ignoreDuplicates: false });
          if (error) {
            const status = (error as { status?: number }).status;
            const wrapped: Error & { status?: number } = new Error(error.message);
            wrapped.status = status;
            throw wrapped;
          }
        },
        { label: `supabase.upsert chunk=${chunkIdx}` }
      );
      report.succeeded += chunk.length;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      report.failed += chunk.length;
      report.errors.push({ chunk: chunkIdx, message });
      console.error(`[supabase] chunk ${chunkIdx} failed: ${message}`);
    }
  }
  return report;
}
