import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type FacilityTalentInput = {
  companyNameNormalized?: string;
  companyDescription?: string;
  companyProductsServices?: string;
  title?: string;
};

type FacilityTalentOutput = {
  facilityType: string;
  talentType: string;
};

const PROMPT = (input: FacilityTalentInput) => `You classify healthcare companies for outreach.
Return exactly two lines in this exact format:
facility_type: <broad short facility type label>
talent_type: <one or two plural short talent labels, comma-separated>

Rules:
- facility_type must be broad and short (1-3 words), e.g. Nursing Facility, Senior Care, Rehab Center.
- talent_type must contain 1 or 2 labels only.
- talent labels must be plural and short words only (examples: CNAs, LVNs, RNs, Therapists).
- No explanations. No bullets. No extra lines.

Company Name: ${cleanText(input.companyNameNormalized)}
Description: ${cleanText(input.companyDescription)}
Products/Services: ${cleanText(input.companyProductsServices)}
Job Title Context: ${cleanText(input.title)}`;

export async function enrichFacilityAndTalent(input: FacilityTalentInput): Promise<FacilityTalentOutput> {
  const name = cleanText(input.companyNameNormalized);
  const desc = cleanText(input.companyDescription);
  const prod = cleanText(input.companyProductsServices);
  const title = cleanText(input.title);

  if (!name && !desc && !prod && !title) {
    return { facilityType: "unknown", talentType: "" };
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
              content:
                "Return exactly two lines: facility_type and talent_type. No markdown, no extra text."
            },
            { role: "user", content: PROMPT(input) }
          ]
        }),
      { label: `openai.facilityTalent "${(name || desc || prod).slice(0, 40)}"` }
    );

    const raw = out.choices[0]?.message?.content?.trim() ?? "";
    const parsed = parseOutput(raw);
    return {
      facilityType: parsed.facilityType || "unknown",
      talentType: parsed.talentType
    };
  } catch (err) {
    console.warn(`[enrichFacilityAndTalent] fallback values: ${(err as Error).message}`);
    return { facilityType: "unknown", talentType: "" };
  }
}

function parseOutput(raw: string): FacilityTalentOutput {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let facilityType = "";
  let talentType = "";

  for (const line of lines) {
    const facilityMatch = line.match(/^facility_type\s*:\s*(.+)$/i);
    if (facilityMatch) {
      facilityType = normalizeFacilityType(facilityMatch[1] ?? "");
      continue;
    }

    const talentMatch = line.match(/^talent_type\s*:\s*(.+)$/i);
    if (talentMatch) {
      talentType = normalizeTalentType(talentMatch[1] ?? "");
    }
  }

  return { facilityType, talentType };
}

function normalizeFacilityType(text: string): string {
  const cleaned = text.replace(/^["']|["']$/g, "").replace(/[.]+$/, "").trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/).slice(0, 3);
  return words.join(" ");
}

function normalizeTalentType(text: string): string {
  const cleaned = text
    .replace(/^["']|["']$/g, "")
    .replace(/[.]+$/, "")
    .replace(/\band\b/gi, ",")
    .replace(/[;/|]+/g, ",")
    .trim();

  if (!cleaned) return "";

  const parts = cleaned
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => toPluralShortLabel(p))
    .filter(Boolean)
    .slice(0, 2);

  return parts.join(", ");
}

function toPluralShortLabel(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";

  if (compact.endsWith("s") || compact.endsWith("S")) return compact;
  return `${compact}s`;
}
