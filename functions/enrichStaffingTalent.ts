import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type StaffingTalentInput = {
  companyNameNormalized?: string;
  companyDescription?: string;
  companyProductsServices?: string;
  title?: string;
};

type StaffingTalentOutput = {
  clientType: string;
  talentType: string;
};

const PROMPT = (input: StaffingTalentInput) => `You classify staffing and recruiting firms for outreach.
Return exactly two lines in this exact format:
client_type: <broad short client/company type label, 1-4 words>
talent_type: <one short talent label they place, plural, 1-3 words>

Rules:
- client_type describes who they sell to (employers, families, agencies, etc.)
- talent_type is ONE talent category only, plural (examples: LVNs, Nannies, Engineers)
- No explanations. No bullets. No extra lines.

Company Name: ${cleanText(input.companyNameNormalized)}
Description: ${cleanText(input.companyDescription)}
Products/Services: ${cleanText(input.companyProductsServices)}
Job Title Context: ${cleanText(input.title)}`;

export async function enrichStaffingTalent(input: StaffingTalentInput): Promise<StaffingTalentOutput> {
  const name = cleanText(input.companyNameNormalized);
  const desc = cleanText(input.companyDescription);
  const prod = cleanText(input.companyProductsServices);
  const title = cleanText(input.title);

  if (!name && !desc && !prod && !title) {
    return { clientType: "unknown", talentType: "" };
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
              content: "Return exactly two lines: client_type and talent_type. No markdown, no extra text."
            },
            { role: "user", content: PROMPT(input) }
          ]
        }),
      { label: `openai.staffingTalent "${(name || desc || prod).slice(0, 40)}"` }
    );

    const raw = out.choices[0]?.message?.content?.trim() ?? "";
    return parseOutput(raw);
  } catch (err) {
    console.warn(`[enrichStaffingTalent] fallback values: ${(err as Error).message}`);
    return { clientType: "unknown", talentType: "" };
  }
}

function parseOutput(raw: string): StaffingTalentOutput {
  let clientType = "";
  let talentType = "";

  for (const line of raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const clientMatch = line.match(/^client_type\s*:\s*(.+)$/i);
    if (clientMatch) {
      clientType = (clientMatch[1] ?? "").replace(/^["']|["']$/g, "").replace(/[.]+$/, "").trim();
      continue;
    }
    const talentMatch = line.match(/^talent_type\s*:\s*(.+)$/i);
    if (talentMatch) {
      talentType = (talentMatch[1] ?? "").replace(/^["']|["']$/g, "").replace(/[.]+$/, "").trim();
    }
  }

  return { clientType: clientType || "unknown", talentType };
}
