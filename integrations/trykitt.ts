import axios, { AxiosInstance } from "axios";
import { withRetry } from "./openai.js";

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
  raw?: unknown;
};

const POLL_DELAYS_MS = [1000, 2000, 3000, 4000, 5000];
const MAX_POLL_ATTEMPTS = 12;

export async function findEmailViaTryKitt(input: TryKittFindInput): Promise<TryKittFindResult> {
  const { firstName, lastName, domain } = input;
  if (!firstName || !lastName || !domain) {
    return { email: null };
  }

  const fullName = `${firstName} ${lastName}`.trim();
  const c = getClient();

  try {
    const submit = await withRetry(
      async () =>
        c.post("/job/find_email", {
          fullName,
          domain,
          companyName: input.companyName || undefined,
          linkedinStandardProfileURL: input.linkedinUrl || undefined,
          realtime: true,
          dataProviderFallback: true
        }),
      { label: `trykitt.find_email ${domain}` }
    );

    const submitBody = submit.data;
    if (isNoResultMarker(submitBody)) {
      return { email: null, raw: submitBody };
    }

    const emailFromSubmit = extractEmail(submitBody);
    if (emailFromSubmit) return { email: emailFromSubmit, raw: submitBody };

    const jobId = extractJobId(submitBody);
    if (!jobId) return { email: null, raw: submitBody };

    await sleep(2000);
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await sleep(POLL_DELAYS_MS[Math.min(i, POLL_DELAYS_MS.length - 1)]!);
      let jobRes;
      try {
        jobRes = await c.get("/job", { params: { id: jobId } });
      } catch {
        continue;
      }
      const terminal = isTerminalJob(jobRes.data);
      const email = extractEmail(jobRes.data);
      if (email) return { email, raw: jobRes.data };
      if (terminal.failed) return { email: null, raw: jobRes.data };
      if (terminal.done && !email) return { email: null, raw: jobRes.data };
    }

    return { email: null, raw: submit.data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[trykitt] find failed for ${fullName} @ ${domain}: ${message}`);
    return { email: null };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
