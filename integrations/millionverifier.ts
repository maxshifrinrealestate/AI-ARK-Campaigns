import axios, { AxiosInstance } from "axios";
import { withRetry } from "./openai.js";

let client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (client) return client;
  const apiKey = process.env.MILLIONVERIFIER_API_KEY;
  if (!apiKey) {
    throw new Error("MILLIONVERIFIER_API_KEY not set; the startup gate should have caught this.");
  }
  const baseURL = process.env.MILLIONVERIFIER_BASE_URL ?? "https://api.millionverifier.com";
  client = axios.create({ baseURL, timeout: 30_000 });
  return client;
}

export type MvStatus = "valid" | "catch_all" | "invalid" | "disposable" | "unknown" | "risky";

export type MvResult = {
  email: string;
  status: MvStatus;
  raw?: unknown;
};

const ACCEPT: ReadonlySet<MvStatus> = new Set(["valid", "catch_all"]);

export function isAcceptable(status: MvStatus): boolean {
  return ACCEPT.has(status);
}

export async function verifyEmailViaMv(email: string): Promise<MvResult> {
  if (!email) return { email, status: "unknown" };
  const c = getClient();
  const apiKey = process.env.MILLIONVERIFIER_API_KEY!;

  try {
    const res = await withRetry(
      async () =>
        c.get("/api/v3/", {
          params: { api: apiKey, email, timeout: 20 }
        }),
      { label: `millionverifier.verify ${email}` }
    );
    const status = mapStatus(res.data);
    return { email, status, raw: res.data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[millionverifier] verify failed for ${email}: ${message}`);
    return { email, status: "unknown" };
  }
}

function mapStatus(data: unknown): MvStatus {
  if (!data || typeof data !== "object") return "unknown";
  const obj = data as Record<string, unknown>;

  const raw =
    (typeof obj.result === "string" && obj.result.toLowerCase()) ||
    (typeof obj.resultcode === "string" && obj.resultcode.toLowerCase()) ||
    (typeof obj.status === "string" && obj.status.toLowerCase()) ||
    "";

  switch (raw) {
    case "ok":
    case "good":
    case "valid":
      return "valid";
    case "catch_all":
    case "catchall":
    case "catch-all":
      return "catch_all";
    case "bad":
    case "invalid":
      return "invalid";
    case "disposable":
      return "disposable";
    case "risky":
    case "spamtrap":
    case "abuse":
      return "risky";
    case "unknown":
    case "":
    default:
      return "unknown";
  }
}
