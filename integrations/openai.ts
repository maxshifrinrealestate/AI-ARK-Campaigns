import OpenAI from "openai";

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set; the startup gate should have caught this.");
  }
  client = new OpenAI({ apiKey });
  return client;
}

export const DEFAULT_CHAT_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
export const DEFAULT_WEBSEARCH_MODEL = process.env.OPENAI_WEBSEARCH_MODEL ?? "gpt-4o";

const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { label: string; attempts?: number; backoffMs?: number[] } = { label: "op" }
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const backoff = opts.backoffMs ?? [2000, 4000, 8000];
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const status = extractStatus(err);
      const transient = status === undefined || TRANSIENT_STATUS.has(status);
      const isLast = i === attempts - 1;
      if (!transient || isLast) {
        break;
      }
      const wait = backoff[Math.min(i, backoff.length - 1)] ?? 8000;
      console.warn(
        `[retry] ${opts.label} failed (status=${status ?? "n/a"}, attempt ${i + 1}/${attempts}); retrying in ${wait}ms`
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const anyErr = err as { status?: number; response?: { status?: number } };
    return anyErr.status ?? anyErr.response?.status;
  }
  return undefined;
}
