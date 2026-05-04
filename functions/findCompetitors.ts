import { DEFAULT_WEBSEARCH_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import type { ICP } from "./findICP.js";

export type Competitor = {
  name: string;
  website?: string;
  rationale: string;
};

export type FindCompetitorsInput = {
  icp: ICP;
  productName?: string;
  productDescription: string;
  vendorCompanyName?: string;
};

const INSTRUCTIONS = `You are a B2B competitor researcher. You will be given an ICP and a vendor's product description. Use web search to identify the 3 best-known competing products in this exact space (not adjacent categories, not the vendor itself).

Output strict JSON only, no markdown, no commentary outside the JSON.

Schema:
{
  "competitors": [
    { "name": string, "website": string, "rationale": string },
    { "name": string, "website": string, "rationale": string },
    { "name": string, "website": string, "rationale": string }
  ]
}

Rules:
- Exactly 3 competitors.
- "name" is the product or brand name.
- "website" is the canonical company website (https://...).
- "rationale" is one sentence (<=180 chars) explaining why they fit the same ICP.
- If the vendor company name is provided, exclude it from the competitor list.`;

export async function findCompetitors(input: FindCompetitorsInput): Promise<Competitor[]> {
  if (!input.productDescription || input.productDescription.trim().length === 0) {
    return [];
  }

  const openai = getOpenAI();
  const userInput = buildUserInput(input);

  try {
    const text = await withRetry(
      async () => {
        const res = await (openai as unknown as {
          responses: {
            create: (args: Record<string, unknown>) => Promise<{ output_text?: string; output?: unknown }>;
          };
        }).responses.create({
          model: DEFAULT_WEBSEARCH_MODEL,
          instructions: INSTRUCTIONS,
          input: userInput,
          tools: [{ type: "web_search" }]
        });
        return extractText(res);
      },
      { label: "openai.findCompetitors" }
    );

    return coerceCompetitors(text, input.vendorCompanyName);
  } catch (err) {
    console.warn(`[findCompetitors] failed, returning []: ${(err as Error).message}`);
    return [];
  }
}

function buildUserInput(input: FindCompetitorsInput): string {
  const icp = input.icp;
  return [
    `Vendor Company: ${input.vendorCompanyName ?? "(not provided)"}`,
    `Product: ${input.productName ?? "(not provided)"}`,
    `Product Description: ${input.productDescription}`,
    `ICP industries: ${icp.industries.join(", ") || "(none)"}`,
    `ICP titles: ${icp.titles.join(", ") || "(none)"}`,
    `ICP sizes: ${icp.company_size_ranges.join(", ") || "(none)"}`,
    `ICP pains: ${icp.pains.join(", ") || "(none)"}`,
    `ICP geographies: ${icp.geographies.join(", ") || "(none)"}`,
    `ICP summary: ${icp.summary || "(none)"}`,
    "",
    "Return the JSON object now."
  ].join("\n");
}

function extractText(res: { output_text?: string; output?: unknown }): string {
  if (typeof res.output_text === "string" && res.output_text.trim().length > 0) {
    return res.output_text;
  }
  const output = res.output;
  if (Array.isArray(output)) {
    const chunks: string[] = [];
    for (const item of output) {
      const content = (item as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const t = (c as { text?: unknown }).text;
          if (typeof t === "string") chunks.push(t);
          else if (t && typeof (t as { value?: unknown }).value === "string") {
            chunks.push((t as { value: string }).value);
          }
        }
      }
    }
    if (chunks.length > 0) return chunks.join("\n");
  }
  return "";
}

function coerceCompetitors(rawText: string, vendor?: string): Competitor[] {
  const json = extractJsonObject(rawText);
  if (!json) return [];
  const arr = (json as { competitors?: unknown }).competitors;
  if (!Array.isArray(arr)) return [];
  const vendorLower = vendor?.trim().toLowerCase();

  const list: Competitor[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) continue;
    if (vendorLower && name.toLowerCase() === vendorLower) continue;
    const website = typeof obj.website === "string" ? obj.website.trim() : undefined;
    const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";
    list.push({ name, website, rationale });
    if (list.length === 3) break;
  }
  return list;
}

function extractJsonObject(text: string): unknown | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // fall through; the model may have wrapped JSON in prose
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}
