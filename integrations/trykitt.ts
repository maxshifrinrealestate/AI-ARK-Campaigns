import axios, { AxiosInstance } from "axios";
import { withRetry } from "./openai.js";

let client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (client) return client;
  const apiKey = process.env.TRYKITT_API_KEY;
  if (!apiKey) {
    throw new Error("TRYKITT_API_KEY not set; the startup gate should have caught this.");
  }
  const baseURL = process.env.TRYKITT_BASE_URL ?? "https://api.trykitt.com";
  client = axios.create({
    baseURL,
    timeout: 30_000,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });
  return client;
}

export type TryKittFindInput = {
  firstName: string;
  lastName: string;
  domain: string;
};

export type TryKittFindResult = {
  email: string | null;
  raw?: unknown;
};

export async function findEmailViaTryKitt(input: TryKittFindInput): Promise<TryKittFindResult> {
  const { firstName, lastName, domain } = input;
  if (!firstName || !lastName || !domain) {
    return { email: null };
  }

  const c = getClient();
  try {
    const res = await withRetry(
      async () =>
        c.post("/v1/email/find", {
          first_name: firstName,
          last_name: lastName,
          domain
        }),
      { label: `trykitt.find ${domain}` }
    );

    const data = res.data ?? {};
    const email = extractEmail(data);
    return { email, raw: data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[trykitt] find failed for ${firstName} ${lastName} @ ${domain}: ${message}`);
    return { email: null };
  }
}

function extractEmail(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const candidate =
    (typeof obj.email === "string" && obj.email) ||
    (obj.data && typeof (obj.data as Record<string, unknown>).email === "string" &&
      ((obj.data as Record<string, unknown>).email as string)) ||
    (obj.result && typeof (obj.result as Record<string, unknown>).email === "string" &&
      ((obj.result as Record<string, unknown>).email as string)) ||
    null;

  if (!candidate || typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.includes("@") ? trimmed.toLowerCase() : null;
}
