import { cleanText } from "./classifyMx.js";

export type DomainSetting = "SMTP" | "CatchAll";

export type CampaignTarget = { workspaceId: string; campaignId: string };

export type CampaignsConfig = {
  smtp: CampaignTarget;
  catchAll: CampaignTarget;
};

export type RouteResult =
  | { ok: true; setting: DomainSetting; target: CampaignTarget }
  | { ok: false; reason: "unknown_domain_setting"; rawValue: string };

export function routeCampaign(rawDomainSetting: unknown, config: CampaignsConfig): RouteResult {
  const raw = cleanText(rawDomainSetting);
  const norm = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (norm === "smtp") {
    return { ok: true, setting: "SMTP", target: config.smtp };
  }
  if (norm === "catchall") {
    return { ok: true, setting: "CatchAll", target: config.catchAll };
  }
  return { ok: false, reason: "unknown_domain_setting", rawValue: raw };
}
