import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";
import type { MaLeadInput } from "./buildMaLeadContext.js";

export type MaIcp = {
  target_industries: string[];
  deal_size_bands: string[];
  target_company_types: string[];
  geographies: string[];
  deal_types: string[];
  portfolio_imagination: string;
  example_blinded_teaser: string;
};

const EMPTY_ICP: MaIcp = {
  target_industries: [],
  deal_size_bands: [],
  target_company_types: [],
  geographies: [],
  deal_types: [],
  portfolio_imagination: "",
  example_blinded_teaser: ""
};

const SYSTEM = `You are an M&A and private equity analyst. Given an advisory firm's profile, infer their ideal client / target company profile — what kinds of companies they pursue, their "portfolio imagination."

This is NOT about who they are as a vendor. It's about what blinded sell-side or buy-side companies would fit their mandate.

Output strict JSON only. No markdown.

Schema:
{
  "target_industries": string[],
  "deal_size_bands": string[],
  "target_company_types": string[],
  "geographies": string[],
  "deal_types": string[],
  "portfolio_imagination": string,
  "example_blinded_teaser": string
}

Rules:
- target_industries: 2-4 sectors they pursue (e.g. "industrial manufacturing", "healthcare services")
- deal_size_bands: 1-3 ranges (e.g. "$10-50M revenue", "lower middle market")
- target_company_types: 1-3 types (e.g. "founder-led", "platform add-on", "family-owned industrial")
- geographies: 1-3 regions if inferable
- deal_types: 1-3 (e.g. "buyout", "growth equity", "sell-side mandate", "add-on acquisition")
- portfolio_imagination: one sentence describing the kind of company they'd want to work with
- example_blinded_teaser: exactly 8-10 words, a hypothetical blinded company matching their ICP. Max TWO specificity dimensions (industry+type OR size+industry OR location+type). No company names. No "ready to sell". Not marketing copy — describe a company profile.`;

export async function enrichMaIcp(input: MaLeadInput): Promise<MaIcp> {
  const name = cleanText(input.company_name_normalized || input.company_name);
  const desc = cleanText(input.company_description);
  const prod = cleanText(input.company_products_services);
  const title = cleanText(input.title);
  const serviceType = cleanText(input.ma_service_type);
  const industry = cleanText(input.company_industry);
  const city = cleanText(input.city);
  const state = cleanText(input.state);

  if (!name && !desc && !prod) return EMPTY_ICP;

  const user = [
    `Firm: ${name}`,
    `Service type: ${serviceType || "(unknown)"}`,
    `Title: ${title || "(unknown)"}`,
    industry ? `Industry: ${industry}` : "",
    [city, state].filter(Boolean).length > 0 ? `Location: ${[city, state].filter(Boolean).join(", ")}` : "",
    desc ? `Description: ${desc.slice(0, 500)}` : "",
    prod ? `Products/Services: ${prod.slice(0, 400)}` : "",
    "",
    "Infer their ideal target company profile and return JSON."
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0.3,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: user }
          ]
        }),
      { label: `openai.enrichMaIcp "${name.slice(0, 40)}"` }
    );
    return parseMaIcp(out.choices[0]?.message?.content ?? "{}");
  } catch (err) {
    console.warn(`[enrichMaIcp] fallback: ${(err as Error).message}`);
    return EMPTY_ICP;
  }
}

export function maIcpPromptBlock(icp: MaIcp): string {
  if (!icp.portfolio_imagination && icp.target_industries.length === 0) return "";

  const lines = [
    "--- Their ideal client / portfolio imagination ---",
    icp.portfolio_imagination ? `Summary: ${icp.portfolio_imagination}` : "",
    icp.target_industries.length > 0 ? `Target industries: ${icp.target_industries.join(", ")}` : "",
    icp.deal_size_bands.length > 0 ? `Deal sizes: ${icp.deal_size_bands.join(", ")}` : "",
    icp.target_company_types.length > 0 ? `Company types: ${icp.target_company_types.join(", ")}` : "",
    icp.geographies.length > 0 ? `Geographies: ${icp.geographies.join(", ")}` : "",
    icp.deal_types.length > 0 ? `Deal types: ${icp.deal_types.join(", ")}` : "",
    icp.example_blinded_teaser ? `Example blinded teaser (style guide): ${icp.example_blinded_teaser}` : ""
  ].filter(Boolean);

  return lines.join("\n");
}

function parseMaIcp(raw: string): MaIcp {
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return EMPTY_ICP;
  }
  return {
    target_industries: toArray(obj.target_industries),
    deal_size_bands: toArray(obj.deal_size_bands),
    target_company_types: toArray(obj.target_company_types),
    geographies: toArray(obj.geographies),
    deal_types: toArray(obj.deal_types),
    portfolio_imagination: typeof obj.portfolio_imagination === "string" ? obj.portfolio_imagination.trim() : "",
    example_blinded_teaser:
      typeof obj.example_blinded_teaser === "string" ? obj.example_blinded_teaser.trim() : ""
  };
}

function toArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v.trim() : String(v ?? "").trim())).filter(Boolean);
}
