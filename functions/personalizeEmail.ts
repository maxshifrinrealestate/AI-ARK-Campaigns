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
  /** 0-based row index — rotates opener and CTA style for variety across the batch. */
  rowIndex?: number;
};

export type PersonalizeEmailResult = {
  body: string;
  wordCount: number;
  ctaStyle: string;
  openerStyle: string;
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

/** Hiring-intent CTAs — never promise to send lists, decks, or overviews. */
const CTA_STYLES = [
  "Are you adding anyone on the perception side this year?",
  "Is your team hiring in this area right now?",
  "Would this kind of background fit roles you're planning?",
  "Curious if you're staffing up on the engineering side soon?",
  "Are you open to strong candidates in this niche even if timing isn't immediate?",
  "Does this profile match anyone you're looking to bring on?",
  "Is talent like this on your hiring roadmap?",
  "Might someone with this background fill a gap you're expecting?",
  "Are you building out the team in this space this quarter?",
  "Would hires in this specialty be relevant for you right now?",
  "Is this the type of talent you're actively looking for?",
  "Any plans to grow the bench in this area soon?",
  "Would candidates in this lane be useful for what you're building?",
  "Are you exploring hires in this space this half?",
  "Is headcount growth here something you're thinking about?",
  "Would this skill set be on your radar for future roles?",
  "Are you keeping an eye out for people in this category?",
  "Does your roadmap include bringing on this kind of talent?",
  "Is this a hiring priority for you at the moment?",
  "Might your team need people like this in the near term?",
  "Are you planning to expand in this function soon?",
  "Would this background be relevant for upcoming openings?",
  "Is recruiting in this area something on your plate?",
  "Any interest in connecting if you're hiring in this space?"
];

/** Varied candidate-led openers — avoid repetitive "we have" patterns. */
const OPENER_STYLES = [
  "I've been in touch with a couple of",
  "I know a few",
  "Been speaking with some",
  "On my side, a couple of",
  "I came across a few",
  "Recently connected with a couple of",
  "A few folks in my network are",
  "I've crossed paths with some",
  "There's a small bench of",
  "I keep running into",
  "A couple of engineers I work with are",
  "I've been tracking a few",
  "Met a handful of",
  "There's a pair of",
  "I'm aware of a few",
  "A short list of people I know are",
  "I've bumped into a couple of",
  "A few builders I've spoken with are",
  "I'm in touch with a couple of",
  "Connected recently with a few",
  "I follow a small group of",
  "A couple names keep coming up —",
  "I've been introduced to a few",
  "There's a cluster of"
];

const BANNED_OPENERS = ["we have", "we've been", "we know", "we are"];

const SYSTEM_PROMPT = `You write short cold outreach emails for recruiting and talent placement.
Return ONLY the inner email content — no outer <div> wrapper (that is added automatically).

Hard rules:
- Under 65 words total in plain text (strict).
- Use exactly two <br></br> tags: one after the greeting, one before the closing question.
- Format: {first_name},<br></br>{candidate hook referencing their company}<br></br>{hiring-intent CTA}
- Start with first name only followed by a comma — NO salutation (no Hi, Hey, Hello, Dear).
- Candidate-led: lead with relevant talent you know or have been speaking with — never a product pitch.
- Vary the opening phrase; NEVER start the hook with "we have", "we've", or "we know".
- Prefer natural phrases like "I've been in touch with", "I know a few", "been speaking with", etc. — each email must feel distinct.
- The closing CTA must ask about hiring intent, future headcount, or whether this talent type is relevant — NEVER offer to send a list, deck, overview, profiles, or summary.
- Imply confidence that you place strong candidates in their space without over-promising.
- Reference one specific detail from the company or contact context.
- End with the exact CTA sentence provided — copy it verbatim.
- Conversational, plain English. No bullet points, no emojis, no ALL CAPS.
- Never use these spam-trigger words/phrases: ${SPAM_WORDS.join(", ")}.
- Do not mention "platform", "solution", "leverage", "synergy", or "game-changer".`;

function buildUserPrompt(input: PersonalizeEmailInput, cta: string, opener: string): string {
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

Suggested opener style (use or closely adapt): ${opener}
Required closing CTA (use exactly): ${cta}`;
}

function firstNameOnly(raw?: string): string {
  const name = cleanText(raw);
  if (!name) return "there";
  return name.split(/\s+/)[0]!.replace(/[^a-zA-Z'-]/g, "") || "there";
}

/** Count words in plain text, stripping HTML tags. */
export function countWords(text: string): number {
  const plain = stripHtml(text);
  return plain.trim().split(/\s+/).filter(Boolean).length;
}

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsSpam(text: string): string | null {
  const lower = stripHtml(text).toLowerCase();
  for (const word of SPAM_WORDS) {
    if (lower.includes(word)) return word;
  }
  for (const banned of BANNED_OPENERS) {
    if (lower.includes(banned)) return banned;
  }
  const listOffer =
    /\b(send|share|float|pass)\b.*\b(list|profiles|overview|summary|deck|names)\b/i.test(lower) ||
    /\b(short list|two-line|brief note)\b/i.test(lower);
  if (listOffer) return "list_offer";
  return null;
}

function pickCta(rowIndex = 0): string {
  return CTA_STYLES[rowIndex % CTA_STYLES.length]!;
}

function pickOpener(rowIndex = 0): string {
  return OPENER_STYLES[rowIndex % OPENER_STYLES.length]!;
}

/** Wrap inner content in required HTML envelope. */
export function wrapEmailHtml(inner: string): string {
  const trimmed = inner.trim();
  if (trimmed.startsWith("<div>") && trimmed.endsWith("</div>")) return trimmed;
  return `<div>${trimmed}</div>`;
}

export async function personalizeEmail(input: PersonalizeEmailInput): Promise<PersonalizeEmailResult> {
  const rowIndex = input.rowIndex ?? 0;
  const ctaStyle = pickCta(rowIndex);
  const openerStyle = pickOpener(rowIndex);
  const firstName = firstNameOnly(input.firstName);

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0.9,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(input, ctaStyle, openerStyle) }
          ]
        }),
      { label: `openai.personalizeEmail "${firstName}"` }
    );

    let inner = (out.choices[0]?.message?.content ?? "").trim();
    inner = normalizeInnerHtml(inner);

    const spam = containsSpam(inner);
    if (spam || countWords(inner) > MAX_WORDS) {
      inner = fallbackInner(input, ctaStyle, openerStyle);
    }

    const body = wrapEmailHtml(inner);
    return { body, wordCount: countWords(body), ctaStyle, openerStyle };
  } catch (err) {
    console.warn(`[personalizeEmail] fallback for ${firstName}: ${(err as Error).message}`);
    const inner = fallbackInner(input, ctaStyle, openerStyle);
    const body = wrapEmailHtml(inner);
    return { body, wordCount: countWords(body), ctaStyle, openerStyle };
  }
}

function normalizeInnerHtml(text: string): string {
  let t = text.replace(/^<div>/i, "").replace(/<\/div>$/i, "").trim();
  t = t.replace(/<br\s*\/?>/gi, "<br></br>");
  if (!/<br><\/br>/i.test(t)) {
    t = t.replace(/\n+/g, "<br></br>");
  }
  return t;
}

/** Deterministic fallback when the model is unavailable or output fails validation. */
function fallbackInner(input: PersonalizeEmailInput, cta: string, opener: string): string {
  const first = firstNameOnly(input.firstName);
  const company = cleanText(input.companyName) || "your team";
  const talent = cleanText(input.talentType) || inferTalentLabel(input) || "specialists";
  const niche =
    cleanText(input.facilityType) ||
    inferFacilityLabel(input.companyDescription, input.companyIndustry) ||
    cleanText(input.companyIndustry) ||
    "your space";
  const place = [cleanText(input.city), cleanText(input.state)].filter(Boolean).join(", ");

  const hook = place
    ? `${opener} ${talent} with ${niche.toLowerCase()} experience around ${place} — backgrounds that map to how ${company} operates.`
    : `${opener} ${talent} with ${niche.toLowerCase()} backgrounds that align with the work ${company} is doing.`;

  return `${first},<br></br>${hook}<br></br>${cta}`;
}

function inferTalentLabel(input: PersonalizeEmailInput): string {
  const text = `${cleanText(input.companyIndustry)} ${cleanText(input.companyDescription)}`.toLowerCase();
  if (text.includes("software") || text.includes("ai") || text.includes("saas")) return "engineers";
  if (text.includes("security") || text.includes("cyber")) return "security practitioners";
  if (text.includes("design")) return "designers";
  if (text.includes("health") || text.includes("clinical")) return "clinicians";
  return "professionals";
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
  if (text.includes("robotics") || text.includes("autonomy")) return "robotics and autonomy";
  if (text.includes("cyber") || text.includes("security")) return "cybersecurity";
  if (text.includes("mortgage") || text.includes("fintech")) return "fintech";
  if (text.includes("wealth")) return "wealth management";
  return "";
}
