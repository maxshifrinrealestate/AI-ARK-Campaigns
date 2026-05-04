import axios, { AxiosInstance } from "axios";
import { withRetry } from "./openai.js";

let client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (client) return client;
  const apiKey = process.env.PLUSVIBE_KEY;
  if (!apiKey) {
    throw new Error("PLUSVIBE_KEY not set; the startup gate should have caught this.");
  }
  const baseURL = process.env.PLUSVIBE_BASE_URL ?? "https://api.plusvibe.ai";
  client = axios.create({
    baseURL,
    timeout: 30_000,
    headers: {
      "x-api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });
  return client;
}

export type PlusVibeLeadPayload = {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  title?: string;
  linkedin?: string;
  company_website?: string;
  company_linkedin?: string;
  company_size?: string;
  company_industry?: string;
  company_type?: string;
  esp?: string;
  city?: string;
  state?: string;
  country?: string;
};

export type UploadTarget = { workspaceId: string; campaignId: string };

export type UploadResult =
  | { ok: true; campaignId: string; workspaceId: string }
  | { ok: false; campaignId: string; workspaceId: string; error: string };

export async function uploadLead(
  payload: PlusVibeLeadPayload,
  target: UploadTarget
): Promise<UploadResult> {
  const c = getClient();
  try {
    await withRetry(
      async () => {
        await c.post(
          `/api/v1/campaign/${encodeURIComponent(target.campaignId)}/leads`,
          {
            workspace_id: target.workspaceId,
            leads: [payload]
          }
        );
      },
      { label: `plusvibe.upload ${target.campaignId}` }
    );
    return { ok: true, campaignId: target.campaignId, workspaceId: target.workspaceId };
  } catch (err: unknown) {
    let msg = "unknown error";
    if (axios.isAxiosError(err)) {
      const status = err.response?.status ?? "n/a";
      const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : err.message;
      msg = `status=${status} body=${body}`;
    } else if (err instanceof Error) {
      msg = err.message;
    }
    return { ok: false, campaignId: target.campaignId, workspaceId: target.workspaceId, error: msg };
  }
}
