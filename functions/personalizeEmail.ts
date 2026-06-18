import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type PersonalizeEmailInput = {
  firstName?: string;
  lastName?: string;
  title?: string;
  headline?: string;
  companyName?: string;
  companyDescription?: string;
  companyProductsServices?: string;
  companyIndustry?: string;
  city?: string;
  state?: string;
  country?: string;
  facilityType?: string;
  talentType?: string;
  /** 0-based row index — rotates CTA style for variety across the batch. */
  rowIndex?: number;
};

export type PersonalizeEmailResult = {
  body: string;
  wordCount: number;
  ctaStyle: string;
};

const MAX_WORDS = 65;

const SPAM_WORDS = [
  "free",
  "guarantee",
  "guaranteed",
  "act now",
  "limited time",
  "click here",
  "buy now",
  "discount",
  "offer",
  "revolutionary",
  "amazing",
  "incredible",
  "unprecedented",
  "risk-free",
  "no obligation",
  "winner",
  "congratulations",
  "urgent",
  "exclusive deal",
  "100%",
  "cash",
  "cheap",
  "lowest price"
];

const CTA_STYLES = [
  "Worth a quick look if timing lines up?",
  "Open to a brief note on who we have in mind?",
  "Happy to share a few profiles if that would help.",
  "Would a two-line summary be useful on your end?",
  "Curious if that is on your radar right now?",
  "Mind if I send over a short list to react to?",
  "Open to hearing whether this fits your current needs?",
  "Could I float a couple names your way?"
];

const SYSTEM_PROMPT = `You write short cold outreach emails for healthcare recruiting.
Return ONLY the email body — no subject line, no greeting label, no sign-off name, no markdown.

Hard rules:
- Under 65 words total (strict).
- Exactly one paragraph — no line breaks.
- Start with "Hi {first_name}," using the provided first name only (no Dr./titles).
- Candidate-led: lead with a relevant clinician or role profile, not a sales pitch.
- Keep the ask vague and low-pressure — imply you may have someone worth a look without over-promising.
- Reference one specific detail from the company or contact context (facility type, geography, specialty, mission).
- End with the exact CTA sentence provided — copy it verbatim.
- Conversational, plain English. No bullet points, no emojis, no ALL CAPS.
- Never use these spam-trigger words/phrases: ${SPAM_WORDS.join(", ")}.
- Do not mention "AI", "platform", "solution", "leverage", "synergy", or "game-changer".`;

function buildUserPrompt(input: PersonalizeEmailInput, cta: string): string {
  const firstName = firstNameOnly(input.firstName);
  return `Write one personalized email for this contact.

First name (for greeting): ${firstName}
Title: ${cleanText(input.title)}
Headline: ${cleanText(input.headline)}
Company: ${cleanText(input.companyName)}
Industry: ${cleanText(input.companyIndustry)}
Location: ${[cleanText(input.city), cleanText(input.state), cleanText(input.country)].filter(Boolean).join(", ")}
Company description: ${cleanText(input.companyDescription).slice(0, 400)}
Products/services: ${cleanText(input.companyProductsServices).slice(0, 200)}
Facility type (if known): ${cleanText(input.facilityType)}
Talent type (if known): ${cleanText(input.talentType)}

Required closing CTA (use exactly): ${cta}`;
}

function firstNameOnly(raw?: string): string {
  const name = cleanText(raw);
  if (!name) return "there";
  return name.split(/\s+/)[0]!.replace(/[^a-zA-Z'-]/g, "") || "there";
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function containsSpam(text: string): string | null {
  const lower = text.toLowerCase();
  for (const word of SPAM_WORDS) {
    if (lower.includes(word)) return word;
  }
  if (/\n\s*\n/.test(text)) return "multiple_paragraphs";
  return null;
}

function pickCta(rowIndex = 0): string {
  return CTA_STYLES[rowIndex % CTA_STYLES.length]!;
}

export async function personalizeEmail(input: PersonalizeEmailInput): Promise<PersonalizeEmailResult> {
  const ctaStyle = pickCta(input.rowIndex ?? 0);
  const firstName = firstNameOnly(input.firstName);

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0.85,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(input, ctaStyle) }
          ]
        }),
      { label: `openai.personalizeEmail "${firstName}"` }
    );

    let body = (out.choices[0]?.message?.content ?? "").trim();
    body = body.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();

    const spam = containsSpam(body);
    if (spam || countWords(body) > MAX_WORDS) {
      body = fallbackEmail(input, ctaStyle);
    }

    return { body, wordCount: countWords(body), ctaStyle };
  } catch (err) {
    console.warn(`[personalizeEmail] fallback for ${firstName}: ${(err as Error).message}`);
    const body = fallbackEmail(input, ctaStyle);
    return { body, wordCount: countWords(body), ctaStyle };
  }
}

/** Deterministic fallback when the model is unavailable or output fails validation. */
function fallbackEmail(input: PersonalizeEmailInput, cta: string): string {
  const first = firstNameOnly(input.firstName);
  const company = cleanText(input.companyName) || "your team";
  const facility =
    cleanText(input.facilityType) ||
    inferFacilityLabel(input.companyDescription, input.companyIndustry) ||
    "your setting";
  const talent = cleanText(input.talentType) || "clinicians";
  const place = [cleanText(input.city), cleanText(input.state)].filter(Boolean).join(", ");

  const opener = place
    ? `Hi ${first}, we have a few ${talent} who have spent time in ${place} and know ${facility.toLowerCase()} workflows.`
    : `Hi ${first}, we have a few ${talent} with background in settings like ${company}.`;

  const body = `${opener} Nothing formal — just people who might fit how ${company} runs day to day. ${cta}`;
  const words = body.split(/\s+/);
  if (words.length > MAX_WORDS) {
    return words.slice(0, MAX_WORDS).join(" ").replace(/[,—-]\s*$/, "") + `. ${cta}`;
  }
  return body;
}

function inferFacilityLabel(desc?: string, industry?: string): string {
  const text = `${cleanText(desc)} ${cleanText(industry)}`.toLowerCase();
  if (text.includes("urgent care")) return "urgent care";
  if (text.includes("mental health") || text.includes("counseling")) return "outpatient behavioral health";
  if (text.includes("pediatric")) return "pediatric care";
  if (text.includes("nephrology") || text.includes("kidney")) return "nephrology";
  if (text.includes("primary care") || text.includes("family medicine")) return "primary care";
  if (text.includes("rehab") || text.includes("recovery") || text.includes("addiction")) return "behavioral health";
  if (text.includes("proton") || text.includes("cancer")) return "oncology";
  if (text.includes("community health")) return "community health";
  if (text.includes("surgery") || text.includes("ambulatory")) return "ambulatory care";
  return "";
}
