import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";
import { buildMaLeadContext, type MaLeadInput } from "./buildMaLeadContext.js";
import { assembleColdEmailHtml } from "./validateColdEmail.js";

export type MaFastResult = {
  company_name_normalized: string;
  ma_service_type: string;
  icp_portfolio_imagination: string;
  icp_target_industries: string;
  icp_deal_sizes: string;
  icp_company_types: string;
  icp_deal_types: string;
  opening_line: string;
  teaser: string;
  cta: string;
  cold_email_html: string;
};

const ALLOWED_SERVICES = [
  "M&A Advisory",
  "Investment Banking",
  "Capital Advisory",
  "Business Brokerage",
  "Private Equity",
  "Restructuring Advisory",
  "Fairness Opinion",
  "Valuation Advisory",
  "Other Advisory"
];

export function quickNormalizeCompanyName(raw: unknown): string {
  const text = cleanText(raw);
  if (!text) return "";
  return text
    .replace(/\b(inc|llc|ltd|corp|co)\.?$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function enrichMaLeadFast(
  input: MaLeadInput,
  productDescription: string
): Promise<MaFastResult> {
  const companyNameNormalized = quickNormalizeCompanyName(
    input.company_name_normalized || input.company_name
  );
  const ctx = buildMaLeadContext({ ...input, company_name_normalized: companyNameNormalized });
  const firstName = ctx.firstName || "there";

  const prompt = `You enrich M&A/capital advisory leads for cold outreach. Return strict JSON only.

${ctx.promptBlock.replace(/--- Their ideal client.*$/s, "")}

Our offer (context only): ${productDescription}

Return JSON:
{
  "ma_service_type": one of [${ALLOWED_SERVICES.join(", ")}],
  "portfolio_imagination": "one sentence on what blinded companies they'd pursue",
  "target_industries": ["2-4 sectors"],
  "deal_size_bands": ["1-3 ranges"],
  "target_company_types": ["1-3 types"],
  "deal_types": ["1-3 deal types"],
  "opening_line": "human opening after first name, under 20 words, specific to their firm",
  "teaser": "8-10 words, blinded company matching THEIR portfolio imagination, max 2 dimensions (industry+size OR type+industry etc), NOT generic family-owned mid-market",
  "cta": "one sentence, vague connectivity to companies like the teaser, aligned with their mandate/portfolio"
}

Rules:
- Teaser must match this firm's unique focus (PE vs M&A vs capital advisory vs agribusiness etc).
- Never imply we hold a live deal. No Hi/Hello. No signatures.
- No marketing copy in teaser (no unlock/enhance/achieve).
- Each field unique to this firm — not templated.
- cold_email_html will be assembled locally — do not include it in JSON.`;

  const openai = getOpenAI();
  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: DEFAULT_CHAT_MODEL,
        temperature: 0.75,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Return only valid JSON matching the schema. Be fast and specific."
          },
          { role: "user", content: prompt }
        ]
      }),
    { label: `openai.enrichMaFast "${firstName}"`, attempts: 2, backoffMs: [1000, 2000] }
  );

  const parsed = parseFastJson(out.choices[0]?.message?.content ?? "{}");
  const opening = parsed.opening_line || `Curious how ${companyNameNormalized} is sourcing deals lately`;
  const teaser = parsed.teaser || buildQuickTeaser(parsed);
  const cta =
    parsed.cta ||
    `We can connect you with companies like this aligned with your ${parsed.deal_types[0] || "investment"} focus`;

  return {
    company_name_normalized: companyNameNormalized,
    ma_service_type: matchService(parsed.ma_service_type),
    icp_portfolio_imagination: parsed.portfolio_imagination,
    icp_target_industries: parsed.target_industries.join("; "),
    icp_deal_sizes: parsed.deal_size_bands.join("; "),
    icp_company_types: parsed.target_company_types.join("; "),
    icp_deal_types: parsed.deal_types.join("; "),
    opening_line: opening,
    teaser,
    cta,
    cold_email_html: assembleColdEmailHtml(firstName, opening, teaser, cta)
  };
}

type ParsedFast = {
  ma_service_type: string;
  portfolio_imagination: string;
  target_industries: string[];
  deal_size_bands: string[];
  target_company_types: string[];
  deal_types: string[];
  opening_line: string;
  teaser: string;
  cta: string;
};

function parseFastJson(raw: string): ParsedFast {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return {
      ma_service_type: typeof obj.ma_service_type === "string" ? obj.ma_service_type : "",
      portfolio_imagination:
        typeof obj.portfolio_imagination === "string" ? obj.portfolio_imagination.trim() : "",
      target_industries: toArr(obj.target_industries),
      deal_size_bands: toArr(obj.deal_size_bands),
      target_company_types: toArr(obj.target_company_types),
      deal_types: toArr(obj.deal_types),
      opening_line: typeof obj.opening_line === "string" ? obj.opening_line.trim() : "",
      teaser: typeof obj.teaser === "string" ? obj.teaser.trim() : "",
      cta: typeof obj.cta === "string" ? obj.cta.trim() : ""
    };
  } catch {
    return {
      ma_service_type: "",
      portfolio_imagination: "",
      target_industries: [],
      deal_size_bands: [],
      target_company_types: [],
      deal_types: [],
      opening_line: "",
      teaser: "",
      cta: ""
    };
  }
}

function toArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? "").trim()).filter(Boolean);
}

function matchService(raw: string): string {
  const hit = ALLOWED_SERVICES.find((s) => s.toLowerCase() === raw.toLowerCase());
  if (hit) return hit;
  const partial = ALLOWED_SERVICES.find((s) => raw.toLowerCase().includes(s.toLowerCase()));
  return partial || "Other Advisory";
}

function buildQuickTeaser(parsed: ParsedFast): string {
  const ind = parsed.target_industries[0];
  const type = parsed.target_company_types[0];
  if (ind && type) return `${type} in ${ind}`;
  if (parsed.deal_size_bands[0] && ind) return `${parsed.deal_size_bands[0]} ${ind} company`;
  return "Founder-led niche platform business";
}
