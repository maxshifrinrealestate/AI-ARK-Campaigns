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

export type RouteCampaignOptions = {
  /** When true, blank domain_settings routes to the SMTP campaign (TryKitt-discovered emails). */
  treatEmptyAsSmtp?: boolean;
};

export function routeCampaign(
  rawDomainSetting: unknown,
  config: CampaignsConfig,
  opts: RouteCampaignOptions = {}
): RouteResult {
  const raw = cleanText(rawDomainSetting);
  const norm = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (norm === "smtp") {
    return { ok: true, setting: "SMTP", target: config.smtp };
  }
  if (norm === "catchall") {
    return { ok: true, setting: "CatchAll", target: config.catchAll };
  }
  if (norm === "" && opts.treatEmptyAsSmtp) {
    return { ok: true, setting: "SMTP", target: config.smtp };
  }
  return { ok: false, reason: "unknown_domain_setting", rawValue: raw };
}
