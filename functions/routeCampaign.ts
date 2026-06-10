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

/** Maps sheet values like SMTP_VALID / CATCH_ALL_VALID to smtp / catchall. */
export function normalizeDomainSettingRaw(rawDomainSetting: unknown): string {
  const norm = cleanText(rawDomainSetting).toLowerCase().replace(/[^a-z]/g, "");
  if (norm.startsWith("smtp")) return "smtp";
  if (norm.startsWith("catchall")) return "catchall";
  return norm;
}

export function routeCampaign(
  rawDomainSetting: unknown,
  config: CampaignsConfig,
  opts: RouteCampaignOptions = {}
): RouteResult {
  const raw = cleanText(rawDomainSetting);
  const norm = normalizeDomainSettingRaw(rawDomainSetting);
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
