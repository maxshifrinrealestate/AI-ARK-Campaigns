import { DEFAULT_CHAT_MODEL, DEFAULT_WEBSEARCH_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type ClassifyMaInput = {
  companyNameNormalized?: string;
  companyDescription?: string;
  companyProductsServices?: string;
  title?: string;
  companyWebsite?: string;
};

const ALLOWED_LABELS = [
  "M&A Advisory",
  "Investment Banking",
  "Capital Advisory",
  "Business Brokerage",
  "Private Equity",
  "Restructuring Advisory",
  "Fairness Opinion",
  "Valuation Advisory",
  "Other Advisory"
] as const;

const PROMPT = (input: ClassifyMaInput, research?: string) => `Classify this firm's primary advisory service into exactly one label from this list:
${ALLOWED_LABELS.join(", ")}

Return only the label. No explanation.

Company: ${cleanText(input.companyNameNormalized)}
Title: ${cleanText(input.title)}
Description: ${cleanText(input.companyDescription)}
Products/Services: ${cleanText(input.companyProductsServices)}
${research ? `Web research:\n${research}` : ""}`;

export async function classifyMaServiceType(input: ClassifyMaInput): Promise<string> {
  const name = cleanText(input.companyNameNormalized);
  const desc = cleanText(input.companyDescription);
  const prod = cleanText(input.companyProductsServices);
  if (!name && !desc && !prod) return "Other Advisory";

  let research = "";
  if (!desc && !prod && name) {
    research = await webResearchFirm(name, cleanText(input.companyWebsite));
  }

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: `Return only one label from: ${ALLOWED_LABELS.join(", ")}`
            },
            { role: "user", content: PROMPT(input, research) }
          ]
        }),
      { label: `openai.classifyMaService "${(name || desc).slice(0, 40)}"` }
    );
    const raw = out.choices[0]?.message?.content?.trim() ?? "";
    return matchAllowedLabel(raw) || "Other Advisory";
  } catch (err) {
    console.warn(`[classifyMaServiceType] fallback: ${(err as Error).message}`);
    return "Other Advisory";
  }
}

function matchAllowedLabel(raw: string): string | null {
  const cleaned = raw.replace(/^["']|["']$/g, "").trim();
  const exact = ALLOWED_LABELS.find((l) => l.toLowerCase() === cleaned.toLowerCase());
  if (exact) return exact;
  const partial = ALLOWED_LABELS.find((l) => cleaned.toLowerCase().includes(l.toLowerCase()));
  return partial ?? null;
}

async function webResearchFirm(name: string, website: string): Promise<string> {
  try {
    const openai = getOpenAI();
    const res = await (openai as unknown as {
      responses: {
        create: (args: Record<string, unknown>) => Promise<{ output_text?: string }>;
      };
    }).responses.create({
      model: DEFAULT_WEBSEARCH_MODEL,
      instructions: "Summarize what advisory services this firm provides in 2-3 sentences. No markdown.",
      input: `Firm: ${name}${website ? `\nWebsite: ${website}` : ""}`,
      tools: [{ type: "web_search" }]
    });
    return res.output_text?.trim() ?? "";
  } catch {
    return "";
  }
}
