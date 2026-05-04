import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

const PROMPT = (raw: string) => `You are a company name normalization assistant.
Given the raw company name below, return only the clean, normalized, properly capitalized legal or trade name. Remove suffixes like "Inc", "LLC", "Ltd", "Corp", "Co." only if they appear redundant or inconsistently cased. Do not invent information. Return only the normalized name, nothing else.

Raw company name: ${raw}`;

export async function normalizeCompany(rawCompanyName: unknown): Promise<string> {
  const raw = cleanText(rawCompanyName);
  if (!raw) return "";

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: "You output only the normalized company name with no preface, quotes, or trailing punctuation." },
            { role: "user", content: PROMPT(raw) }
          ]
        }),
      { label: `openai.normalize "${raw.slice(0, 40)}"` }
    );
    const content = out.choices[0]?.message?.content?.trim() ?? "";
    if (!content) return raw;
    return content.replace(/^["']|["']$/g, "").trim() || raw;
  } catch (err) {
    console.warn(`[normalizeCompany] fallback to raw for "${raw}": ${(err as Error).message}`);
    return raw;
  }
}
