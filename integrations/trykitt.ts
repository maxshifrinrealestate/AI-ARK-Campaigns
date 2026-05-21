import axios, { AxiosInstance } from "axios";
import { withRetry } from "./openai.js";
import { normalizeTryKittDomain } from "../functions/classifyMx.js";
import { mapPool } from "../functions/mapPool.js";

let client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (client) return client;
  const apiKey = process.env.TRYKITT_API_KEY;
  if (!apiKey) {
    throw new Error("TRYKITT_API_KEY not set; the startup gate should have caught this.");
  }
  const baseURL = process.env.TRYKITT_BASE_URL ?? "https://api.trykitt.ai";
  client = axios.create({
    baseURL,
    timeout: 60_000,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  });
  return client;
}

export type TryKittFindInput = {
  firstName: string;
  lastName: string;
  domain: string;
  companyName?: string;
  linkedinUrl?: string;
};

export type TryKittFindResult = {
  email: string | null;
  jobId?: string | null;
  raw?: unknown;
};

type PendingJob = {
  key: string | number;
  jobId: string;
  input: TryKittFindInput;
};

type SubmitOutcome =
  | { key: string | number; status: "resolved"; email: string; raw?: unknown }
  | { key: string | number; status: "pending"; jobId: string; input: TryKittFindInput }
  | { key: string | number; status: "failed"; raw?: unknown };

const POLL_INTERVAL_MS = Number(process.env.TRYKITT_POLL_INTERVAL_MS) || 2000;
const INITIAL_WAIT_MS = Number(process.env.TRYKITT_INITIAL_WAIT_MS) || 5000;
const DEFAULT_SUBMIT_CONCURRENCY = Number(process.env.TRYKITT_SUBMIT_CONCURRENCY) || 15;
const DEFAULT_POLL_CONCURRENCY = Number(process.env.TRYKITT_POLL_CONCURRENCY) || 25;
const MAX_POLL_ROUNDS = Number(process.env.TRYKITT_MAX_POLL_ROUNDS) || 80;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Single-row find (uses parallel pool of 1). */
export async function findEmailViaTryKitt(input: TryKittFindInput): Promise<TryKittFindResult> {
  const domain = normalizeTryKittDomain(input.domain);
  const results = await findEmailsViaTryKittPool([{ key: 0, ...input, domain }], {
    submitConcurrency: 1
  });
  return results.get(0) ?? { email: null };
}

export type TryKittPoolItem = TryKittFindInput & { key: string | number };

export type TryKittPoolOptions = {
  submitConcurrency?: number;
  pollConcurrency?: number;
  maxPollRounds?: number;
};

/**
 * Submit many find_email jobs in parallel, then HTTP-poll GET /job?id=... in rounds
 * until each job completes (TryKitt async job pattern).
 */
export async function findEmailsViaTryKittPool(
  items: TryKittPoolItem[],
  opts: TryKittPoolOptions = {}
): Promise<Map<string | number, TryKittFindResult>> {
  const out = new Map<string | number, TryKittFindResult>();
  if (items.length === 0) return out;

  const submitConcurrency = opts.submitConcurrency ?? DEFAULT_SUBMIT_CONCURRENCY;
  const pollConcurrency = opts.pollConcurrency ?? DEFAULT_POLL_CONCURRENCY;
  const maxPollRounds = opts.maxPollRounds ?? MAX_POLL_ROUNDS;

  const submits = await mapPool(items, submitConcurrency, async (item) => submitFindEmailJob(item));

  const pending: PendingJob[] = [];
  for (const s of submits) {
    if (s.status === "resolved") {
      out.set(s.key, { email: s.email, raw: s.raw });
    } else if (s.status === "pending") {
      pending.push({ key: s.key, jobId: s.jobId, input: s.input });
    } else {
      out.set(s.key, { email: null, raw: s.raw });
    }
  }

  if (pending.length > 0) {
    console.log(
      `[trykitt] polling ${pending.length} jobs after ${INITIAL_WAIT_MS}ms (interval=${POLL_INTERVAL_MS}ms, maxRounds=${maxPollRounds})`
    );
    await sleep(INITIAL_WAIT_MS);
  }

  for (let round = 0; round < maxPollRounds && pending.length > 0; round++) {
    if (round > 0) await sleep(POLL_INTERVAL_MS);

    const pollResults = await mapPool(pending, pollConcurrency, async (job) => {
      const polled = await pollTryKittJob(job.jobId);
      return { job, polled };
    });

    const stillPending: PendingJob[] = [];
    for (const { job, polled } of pollResults) {
      if (polled.email) {
        out.set(job.key, { email: polled.email, jobId: job.jobId, raw: polled.raw });
      } else if (polled.terminal) {
        out.set(job.key, { email: null, jobId: job.jobId, raw: polled.raw });
      } else {
        stillPending.push(job);
      }
    }

    pending.length = 0;
    pending.push(...stillPending);
  }

  for (const job of pending) {
    out.set(job.key, { email: null, jobId: job.jobId });
    console.warn(`[trykitt] job ${job.jobId} timed out after ${maxPollRounds} poll rounds`);
  }

  return out;
}

async function submitFindEmailJob(item: TryKittPoolItem): Promise<SubmitOutcome> {
  const domain = normalizeTryKittDomain(item.domain);
  const firstName = item.firstName.trim();
  const lastName = item.lastName.trim();
  if (!firstName || !lastName || !domain) {
    return { key: item.key, status: "failed" };
  }

  const fullName = `${firstName} ${lastName}`.trim();
  const c = getClient();

  try {
    const submit = await withRetry(
      async () =>
        c.post("/job/find_email", {
          fullName,
          domain,
          companyName: item.companyName || undefined,
          linkedinStandardProfileURL: item.linkedinUrl || undefined,
          realtime: true,
          fastMode: false,
          dataProviderFallback: true,
          discoverAlternativeDomains: true
        }),
      { label: `trykitt.submit ${domain}` }
    );

    const body = submit.data;
    if (isNoResultMarker(body)) {
      return { key: item.key, status: "failed", raw: body };
    }

    const immediate = extractEmail(body);
    if (immediate) {
      return { key: item.key, status: "resolved", email: immediate, raw: body };
    }

    const jobId = extractJobId(body);
    if (!jobId) {
      return { key: item.key, status: "failed", raw: body };
    }

    return {
      key: item.key,
      status: "pending",
      jobId,
      input: { ...item, domain }
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[trykitt] submit failed ${fullName} @ ${domain}: ${message}`);
    return { key: item.key, status: "failed" };
  }
}

async function pollTryKittJob(
  jobId: string
): Promise<{ email: string | null; terminal: boolean; raw?: unknown }> {
  const c = getClient();
  try {
    const jobRes = await c.get("/job", { params: { id: jobId } });
    const data = jobRes.data;
    const email = extractEmail(data);
    if (email) return { email, terminal: true, raw: data };

    const terminal = isTerminalJob(data);
    if (terminal.done) {
      return { email: null, terminal: true, raw: data };
    }
    return { email: null, terminal: false, raw: data };
  } catch {
    return { email: null, terminal: false };
  }
}

function extractJobId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const candidates = [obj.jobId, obj.job_id, obj.jobID, obj.id];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  if (obj.data && typeof obj.data === "object") {
    return extractJobId(obj.data);
  }
  return null;
}

function isTerminalJob(data: unknown): { done: boolean; failed: boolean } {
  if (!data || typeof data !== "object") return { done: false, failed: false };
  const obj = data as Record<string, unknown>;
  const status = String(obj.status ?? obj.state ?? obj.jobStatus ?? "").toLowerCase();
  if (["failed", "error", "cancelled", "canceled"].includes(status)) {
    return { done: true, failed: true };
  }
  if (["completed", "complete", "success", "succeeded", "done"].includes(status)) {
    return { done: true, failed: false };
  }
  return { done: false, failed: false };
}

function isNoResultMarker(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  const markers = [obj.email, obj.displayText, obj.status, obj.result]
    .filter((v) => typeof v === "string")
    .map((v) => (v as string).trim().toLowerCase());
  return markers.some((m) =>
    ["no-results-found", "no results found", "not found", "no_result", "failed"].includes(m)
  );
}

function isValidEmail(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.includes("@")) return false;
  if (trimmed === "no-results-found" || trimmed.endsWith("@no-results-found")) return false;
  return true;
}

function extractEmail(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  const direct =
    (typeof obj.email === "string" && obj.email) ||
    (typeof obj.foundEmail === "string" && obj.foundEmail) ||
    (typeof obj.workEmail === "string" && obj.workEmail) ||
    null;

  if (direct && isValidEmail(direct)) return direct.trim().toLowerCase();

  const nestedKeys = ["result", "data", "output", "response", "payload"];
  for (const key of nestedKeys) {
    if (obj[key]) {
      const nested = extractEmail(obj[key]);
      if (nested) return nested;
    }
  }

  return null;
}
