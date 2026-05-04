import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type ICP = {
  industries: string[];
  titles: string[];
  company_size_ranges: string[];
  pains: string[];
  geographies: string[];
  summary: string;
};

export type FindICPInput = {
  companyName?: string;
  companyDescription: string;
  productName?: string;
  productDescription: string;
};

const SYSTEM = `You are a B2B GTM analyst. From a vendor's company description and product description, define the Ideal Customer Profile (ICP) for that product.

Rules:
- Output strict JSON only matching the requested schema.
- Do not invent specific company names; use industries, titles, sizes, pains, geographies.
- Use 3-7 items per array.
- Keep each item concise (max ~6 words).
- "summary" is one sentence (<=200 chars) describing the ICP in plain English.
- Do not output markdown, prose, or commentary outside the JSON object.`;

const USER = (input: FindICPInput) => `Vendor Company: ${cleanText(input.companyName) || "(not provided)"}
Company Description: ${cleanText(input.companyDescription)}
Product Name: ${cleanText(input.productName) || "(not provided)"}
Product Description: ${cleanText(input.productDescription)}

Return a JSON object with exactly these keys:
{
  "industries": string[],
  "titles": string[],
  "company_size_ranges": string[],
  "pains": string[],
  "geographies": string[],
  "summary": string
}`;

const EMPTY_ICP: ICP = {
  industries: [],
  titles: [],
  company_size_ranges: [],
  pains: [],
  geographies: [],
  summary: ""
};

export async function findICP(input: FindICPInput): Promise<ICP> {
  if (!cleanText(input.companyDescription) && !cleanText(input.productDescription)) {
    return EMPTY_ICP;
  }

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: USER(input) }
          ]
        }),
      { label: "openai.findICP" }
    );
    const content = out.choices[0]?.message?.content?.trim() ?? "{}";
    return parseICP(content);
  } catch (err) {
    console.warn(`[findICP] failed, returning empty ICP: ${(err as Error).message}`);
    return EMPTY_ICP;
  }
}

function parseICP(raw: string): ICP {
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return EMPTY_ICP;
  }
  return {
    industries: toStringArray(obj.industries),
    titles: toStringArray(obj.titles),
    company_size_ranges: toStringArray(obj.company_size_ranges),
    pains: toStringArray(obj.pains),
    geographies: toStringArray(obj.geographies),
    summary: typeof obj.summary === "string" ? obj.summary.trim() : ""
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : String(v ?? "").trim()))
    .filter((v) => v.length > 0);
}
