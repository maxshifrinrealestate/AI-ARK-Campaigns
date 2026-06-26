export type EspBucket = "outlook" | "google_others";

export function espToBucket(esp: string): EspBucket {
  const p = esp.toLowerCase().trim();
  if (p === "outlook") return "outlook";
  return "google_others";
}

export type EspCampaignConfig = {
  googleOthersCampaignId: string;
  outlookCampaignId: string;
  workspaceId: string;
};

export function resolveEspCampaign(
  esp: string,
  config: EspCampaignConfig
): { bucket: EspBucket; campaignId: string; workspaceId: string } {
  const bucket = espToBucket(esp);
  return {
    bucket,
    campaignId:
      bucket === "outlook" ? config.outlookCampaignId : config.googleOthersCampaignId,
    workspaceId: config.workspaceId
  };
}
