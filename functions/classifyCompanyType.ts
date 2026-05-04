import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type ClassifyInput = {
  companyNameNormalized?: string;
  companyDescription?: string;
  companyProductsServices?: string;
};

const PROMPT = (input: ClassifyInput) => `You are a business classification assistant. Using the information below, classify this company into one specific company type or facility type. Return only a single classification label (2-5 words max). Do not explain your reasoning.

Company Name: ${cleanText(input.companyNameNormalized)}
Description: ${cleanText(input.companyDescription)}
Products/Services: ${cleanText(input.companyProductsServices)}`;

export async function classifyCompanyType(input: ClassifyInput): Promise<string> {
  const name = cleanText(input.companyNameNormalized);
  const desc = cleanText(input.companyDescription);
  const prod = cleanText(input.companyProductsServices);
  if (!name && !desc && !prod) return "unknown";

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: "Return only the 2-5 word classification label. No quotes, no punctuation other than spaces or hyphens." },
            { role: "user", content: PROMPT(input) }
          ]
        }),
      { label: `openai.classifyType "${(name || desc).slice(0, 40)}"` }
    );
    const raw = out.choices[0]?.message?.content?.trim() ?? "";
    return enforceWordLimit(raw) || "unknown";
  } catch (err) {
    console.warn(`[classifyCompanyType] fallback to unknown: ${(err as Error).message}`);
    return "unknown";
  }
}

function enforceWordLimit(text: string): string {
  const cleaned = text.replace(/^["']|["']$/g, "").replace(/[.]+$/, "").trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/);
  if (words.length > 6) {
    return words.slice(0, 4).join(" ");
  }
  return cleaned;
}
