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
  notes?: string;
  address_line?: string;
  city?: string;
  country?: string;
  country_code?: string;
  phone_number?: string;
  company_name?: string;
  company_website?: string;
  linkedin_person_url?: string;
  linkedin_company_url?: string;
  custom_variables?: Record<string, string>;
};

export type UploadTarget = { workspaceId: string; campaignId: string };

export type UploadResult =
  | { ok: true; campaignId: string; workspaceId: string; count: number }
  | { ok: false; campaignId: string; workspaceId: string; error: string; count: number };

export type WorkspaceInfo = { id: string; name: string };

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const c = getClient();
  const resp = await withRetry(() => c.get("/api/v1/authenticate"), { label: "plusvibe.authenticate" });
  const workspaces = (resp.data?.workspaces ?? []) as Array<{ _id?: string; name?: string }>;
  return workspaces
    .map((w) => ({ id: String(w._id ?? ""), name: String(w.name ?? "") }))
    .filter((w) => w.id);
}

export async function resolveWorkspaceId(nameOrId?: string): Promise<string> {
  const direct = nameOrId?.trim() || process.env.PLUSVIBE_WORKSPACE_ID?.trim();
  if (direct && /^[a-f0-9]{24}$/i.test(direct)) return direct;

  const search = (direct || process.env.PLUSVIBE_WORKSPACE_NAME || "zs").toLowerCase();
  const workspaces = await listWorkspaces();
  const hit = workspaces.find((w) => w.name.toLowerCase() === search || w.name.toLowerCase().includes(search));
  if (hit) return hit.id;
  if (workspaces.length === 1) return workspaces[0]!.id;
  throw new Error(
    `Could not resolve workspace "${search}". Available: ${workspaces.map((w) => `${w.name} (${w.id})`).join(", ")}`
  );
}

export async function uploadLead(
  payload: PlusVibeLeadPayload,
  target: UploadTarget
): Promise<{ ok: boolean; campaignId: string; workspaceId: string; error?: string }> {
  const result = await uploadLeadsBatch([payload], target);
  return {
    ok: result.ok,
    campaignId: target.campaignId,
    workspaceId: target.workspaceId,
    error: result.ok ? undefined : result.error
  };
}

export async function uploadLeadsBatch(
  payloads: PlusVibeLeadPayload[],
  target: UploadTarget
): Promise<UploadResult> {
  if (payloads.length === 0) {
    return { ok: true, campaignId: target.campaignId, workspaceId: target.workspaceId, count: 0 };
  }
  const c = getClient();
  try {
    await withRetry(
      async () => {
        await c.post("/api/v1/lead/add", {
          workspace_id: target.workspaceId,
          campaign_id: target.campaignId,
          is_overwrite: true,
          leads: payloads
        });
      },
      { label: `plusvibe.uploadBatch ${target.campaignId} x${payloads.length}` }
    );
    return { ok: true, campaignId: target.campaignId, workspaceId: target.workspaceId, count: payloads.length };
  } catch (err: unknown) {
    let msg = "unknown error";
    if (axios.isAxiosError(err)) {
      const status = err.response?.status ?? "n/a";
      const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : err.message;
      msg = `status=${status} body=${body}`;
    } else if (err instanceof Error) {
      msg = err.message;
    }
    return { ok: false, campaignId: target.campaignId, workspaceId: target.workspaceId, error: msg, count: 0 };
  }
}
