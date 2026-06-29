import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { cleanText } from "./classifyMx.js";

export type StaffingEmailInput = {
  firstName?: string;
  title?: string;
  companyName?: string;
  companyDescription?: string;
  companyProductsServices?: string;
  companyIndustry?: string;
  city?: string;
  state?: string;
  talentType?: string;
  rowIndex?: number;
};

export type StaffingEmailResult = {
  body: string;
  wordCount: number;
};

const MAX_WORDS = 60;

const HOOK_PATTERNS = [
  (first: string, talent: string) =>
    `${first}, we're tied into a couple of employers looking for ${talent} — open to new searches on your end?`,
  (first: string, talent: string) =>
    `${first}, quick one — a few companies we work with need ${talent} coverage, could your team help?`,
  (first: string, talent: string) =>
    `${first}, a couple buyers we touch are staffing ${talent} roles — worth a look for you?`,
  (first: string, talent: string) =>
    `${first}, we've got access to a few accounts hiring ${talent} — are you taking new reqs?`,
  (first: string, talent: string) =>
    `${first}, wanted to run something by you — employers we know need ${talent} placement, is that your lane?`,
  (first: string, talent: string) =>
    `${first}, not sure if this lands — a few clients we know are hiring ${talent}, could you place that?`,
  (first: string, talent: string) =>
    `${first}, facilities we work with keep asking about ${talent} coverage — something you take on?`,
  (first: string, talent: string) =>
    `${first}, a few operators we know are reopening ${talent} searches — open to new work right now?`,
  (first: string, talent: string) =>
    `${first}, buyers we touch need ${talent} support on contract — does your bench have room?`,
  (first: string, talent: string) =>
    `${first}, we're connected to a handful of accounts hunting ${talent} — can you help?`
];

const CTA_PATTERNS = [
  "Can walk you through the accounts on a quick call if that helps.",
  "I'd be glad to share the briefs over a short call.",
  "Happy to walk you through the accounts whenever you have ten minutes.",
  "Would be glad to pass the account details on a quick call.",
  "Let me know if a short call to review the accounts makes sense.",
  "I can share what we have over a quick call.",
  "Would be happy to share the accounts with you over a quick call.",
  "Can walk you through the accounts on a short call if useful.",
  "Happy to share the rundown over ten minutes.",
  "Let me know if you want the account briefs on a short call.",
  "Should I pass assignment briefs that match your placement lane.",
  "Would be glad to share what we have over a short call.",
  "Happy to walk you through the accounts on a quick call.",
  "Can share the accounts with you over a short call if useful.",
  "I'd be glad to walk you through what's there on a quick call.",
  "Can pass along the account details on a short call.",
  "Let me know if a quick call to walk through the accounts works.",
  "Happy to share what we have on a short call."
];

function firstNameOnly(raw?: string): string {
  const name = cleanText(raw);
  if (!name) return "there";
  return name.split(/\s+/)[0]!.replace(/[^a-zA-Z'-]/g, "") || "there";
}

export function countWords(text: string): number {
  const plain = text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.split(/\s+/).filter(Boolean).length;
}

function inferTalent(input: StaffingEmailInput): string {
  const explicit = cleanText(input.talentType);
  if (explicit) return explicit.toLowerCase();

  const text = `${cleanText(input.companyProductsServices)} ${cleanText(input.companyDescription)} ${cleanText(input.companyIndustry)}`.toLowerCase();
  if (/\bnurs|rn|lpn|cna|lvn|clinical/.test(text)) return "nursing talent";
  if (/\bnanny|household|domestic|estate/.test(text)) return "household staff";
  if (/\bphysician|crna|anesthesia|advanced practice/.test(text)) return "advanced practice providers";
  if (/\bit\b|software|engineer|sap|java|cloud|developer/.test(text)) return "IT contractors";
  if (/\bfinance|accounting|controller|cfo/.test(text)) return "finance leaders";
  if (/\bwarehouse|logistics|industrial|manufacturing/.test(text)) return "warehouse and logistics talent";
  if (/\bexecutive|c-suite|retained|search/.test(text)) return "executive leadership";
  if (/\bhealth|hospital|medical|therapy/.test(text)) return "healthcare staff";
  if (/\bcreative|marketing|design|copy/.test(text)) return "creative contractors";
  if (/\bcleared|defense|federal/.test(text)) return "cleared consultants";
  if (/\bscreening|background/.test(text)) return "high-volume screening support";
  return "contract talent";
}

export function personalizeStaffingEmailLocal(input: StaffingEmailInput): StaffingEmailResult {
  const rowIndex = input.rowIndex ?? 0;
  const first = firstNameOnly(input.firstName);
  const talent = inferTalent(input);
  const hook = HOOK_PATTERNS[rowIndex % HOOK_PATTERNS.length]!(first, talent);
  const cta = CTA_PATTERNS[rowIndex % CTA_PATTERNS.length]!;
  const inner = `${hook}<br></br>${cta}`;
  const body = `<div>${inner}</div>`;
  return { body, wordCount: countWords(body) };
}

export async function personalizeStaffingEmail(
  input: StaffingEmailInput,
  opts: { fallbackOnly?: boolean } = {}
): Promise<StaffingEmailResult> {
  if (opts.fallbackOnly) return personalizeStaffingEmailLocal(input);

  const local = personalizeStaffingEmailLocal(input);
  const first = firstNameOnly(input.firstName);

  try {
    const openai = getOpenAI();
    const out = await withRetry(
      () =>
        openai.chat.completions.create({
          model: DEFAULT_CHAT_MODEL,
          temperature: 0.9,
          messages: [
            {
              role: "system",
              content: `Write a 2-line cold email for staffing firm founders. Return ONLY inner HTML (no outer div).
Format: {hook line}<br></br>{CTA line}
Rules: under 60 words, first line starts with first name and comma, no Hi/Hello, outcome-focused, one talent type only, CTA offers a quick call to walk through accounts (never send lists). Use <br></br> between lines.`
            },
            {
              role: "user",
              content: `First name: ${first}
Company: ${cleanText(input.companyName)}
Industry: ${cleanText(input.companyIndustry)}
Products: ${cleanText(input.companyProductsServices).slice(0, 200)}
Talent lane: ${inferTalent(input)}
Required CTA (adapt slightly): ${CTA_PATTERNS[(input.rowIndex ?? 0) % CTA_PATTERNS.length]}`
            }
          ]
        }),
      { label: `openai.staffingEmail "${first}"` }
    );

    let inner = (out.choices[0]?.message?.content ?? "").trim();
    inner = inner.replace(/^<div>/i, "").replace(/<\/div>$/i, "").trim();
    inner = inner.replace(/<br\s*\/?>/gi, "<br></br>");
    if (countWords(inner) > MAX_WORDS || !inner.includes("<br></br>")) {
      return local;
    }
    const body = `<div>${inner}</div>`;
    return { body, wordCount: countWords(body) };
  } catch {
    return local;
  }
}
