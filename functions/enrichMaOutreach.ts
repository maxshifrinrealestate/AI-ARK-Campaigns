import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { buildMaLeadContext, type MaLeadInput } from "./buildMaLeadContext.js";
import type { MaIcp } from "./enrichMaIcp.js";
import {
  assembleColdEmailHtml,
  validateColdEmailHtml,
  validateCta,
  validateOpeningLine,
  validateTeaser
} from "./validateColdEmail.js";

export type MaOutreachConfig = {
  companyDescription: string;
  productDescription: string;
};

export type MaOutreachResult = {
  opening_line: string;
  teaser: string;
  cta: string;
  cold_email_html: string;
};

export type MaOutreachInput = MaLeadInput & {
  ma_icp?: MaIcp;
};

export type MaOutreachBatchContext = {
  recentOpenings: string[];
  recentCtas: string[];
};

const COPY_TEMPERATURE = 0.85;
const MAX_RETRIES = 2;

const SHARED_RULES = `Rules:
- Write like a real person, not a template or AI.
- Never start with "You focus on" or "Noticed you".
- Never imply we hold a live deal or specific account.
- Outcome-focused for the prospect, not bragging about us.
- No salutations, signatures, emojis, or spam words.`;

export async function enrichMaOutreach(
  input: MaOutreachInput,
  config: MaOutreachConfig,
  batchCtx: MaOutreachBatchContext = { recentOpenings: [], recentCtas: [] }
): Promise<MaOutreachResult> {
  const ctx = buildMaLeadContext(input);
  const icp = input.ma_icp ?? ctx.icp;
  const negativeExamples = buildNegativeExamples(batchCtx);

  let openingLine = "";
  let teaser = "";
  let cta = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const openingFeedback =
      attempt > 0 && !openingLine ? "Previous attempt failed validation. Rewrite completely." : "";
    openingLine = await generateOpeningLine(ctx, config, negativeExamples, openingFeedback);
    const openingVal = validateOpeningLine(openingLine, ctx.firstName);
    if (!openingVal.ok) {
      if (attempt === MAX_RETRIES) break;
      continue;
    }

    teaser = await generateTeaser(ctx, openingLine, icp, attempt);
    const teaserVal = validateTeaser(teaser);
    if (!teaserVal.ok) {
      if (attempt === MAX_RETRIES) break;
      continue;
    }

    cta = await generateCta(ctx, openingLine, teaser, config, icp, negativeExamples, attempt);
    const ctaVal = validateCta(cta);
    if (!ctaVal.ok) {
      if (attempt === MAX_RETRIES) break;
      continue;
    }

    const html = assembleColdEmailHtml(ctx.firstName, openingLine, teaser, cta);
    const emailVal = validateColdEmailHtml(
      html,
      ctx.firstName,
      batchCtx.recentOpenings,
      batchCtx.recentCtas
    );
    if (emailVal.ok) {
      return { opening_line: openingLine, teaser, cta, cold_email_html: html };
    }
    if (attempt === MAX_RETRIES) {
      console.warn(`[enrichMaOutreach] validation failed for ${ctx.firstName}: ${emailVal.errors.join("; ")}`);
      return { opening_line: openingLine, teaser, cta, cold_email_html: html };
    }
  }

  const fallbackTeaser = icp?.example_blinded_teaser || buildIcpFallbackTeaser(icp);
  const fallbackCta = buildIcpFallbackCta(icp);

  const html = assembleColdEmailHtml(
    ctx.firstName,
    openingLine || buildIcpFallbackOpening(ctx),
    teaser || fallbackTeaser,
    cta || fallbackCta
  );
  return {
    opening_line: openingLine || buildIcpFallbackOpening(ctx),
    teaser: teaser || fallbackTeaser,
    cta: cta || fallbackCta,
    cold_email_html: html
  };
}

async function generateOpeningLine(
  ctx: ReturnType<typeof buildMaLeadContext>,
  config: MaOutreachConfig,
  negativeExamples: string,
  feedback: string
): Promise<string> {
  const prompt = `Write ONE opening line for a cold email to an M&A/capital advisory prospect.
This line comes right after their first name — no greeting, no first name in the line.

${SHARED_RULES}
- Reference something specific about THEIR firm using the context below (sector, geography, deal size band, services).
- Vary sentence structure — question, observation, or direct statement.
- Keep it under 20 words.

Our offer (for context only, don't pitch us): ${config.productDescription}

${ctx.promptBlock}
${negativeExamples}
${feedback}

Return only the opening line.`;

  return generateCopy(prompt, `opening "${ctx.firstName}"`);
}

async function generateTeaser(
  ctx: ReturnType<typeof buildMaLeadContext>,
  openingLine: string,
  icp: MaIcp | null | undefined,
  attempt: number
): Promise<string> {
  const icpGuide = icp
    ? `
Their portfolio imagination (use this to craft the teaser — match what THEY pursue):
${ctx.icpBlock}
`
    : "";

  const prompt = `Write a teaser line (8-10 words) for a cold email.

${SHARED_RULES}
- Hypothetical blinded company profile matching THIS firm's ideal client / portfolio imagination.
- NOT a generic "family-owned mid-market business" — be specific to their sectors, deal sizes, and company types.
- Use at most TWO dimensions: industry, size/revenue band, location, or company type.
- No company names. No "ready to sell" or "preparing exit".
- NOT marketing copy — no "unlock", "enhance", "achieve", "growth strategies".
- Describe a company TYPE they'd want, e.g. "founder-led industrial services platform" or "$20M healthcare staffing firm".
- Must flow naturally from the opening line.

Opening line already written:
"${openingLine}"

${ctx.promptBlock}
${icpGuide}
${attempt > 0 ? "Previous teaser failed validation. Rewrite as a simple company profile (max 2 dimensions), not marketing copy." : ""}

Return only the teaser (8-10 words).`;

  return generateCopy(prompt, `teaser "${ctx.firstName}"`);
}

async function generateCta(
  ctx: ReturnType<typeof buildMaLeadContext>,
  openingLine: string,
  teaser: string,
  config: MaOutreachConfig,
  icp: MaIcp | null | undefined,
  negativeExamples: string,
  attempt: number
): Promise<string> {
  const icpHint = icp?.portfolio_imagination
    ? `Their portfolio focus: ${icp.portfolio_imagination}`
    : "";

  const prompt = `Write ONE closing CTA sentence for a cold email.

${SHARED_RULES}
- Vague connectivity framing — we can connect/introduce them to companies LIKE the teaser.
- Reference their mandate, criteria, portfolio, or investment vision — not generic "fit your criteria".
- Use soft language: "connect you with companies like this", "intros to companies aligned with your portfolio".
- NEVER say we have a company, deal, or seller.
- One sentence only. Vary wording from other emails.

Opening: "${openingLine}"
Teaser: "${teaser}"
${icpHint}

Our offer: ${config.productDescription}
${negativeExamples}
${attempt > 0 ? "Previous CTA failed validation. Use clearer vague connectivity language." : ""}

Return only the CTA sentence.`;

  return generateCopy(prompt, `cta "${ctx.firstName}"`);
}

async function generateCopy(prompt: string, label: string): Promise<string> {
  const openai = getOpenAI();
  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: DEFAULT_CHAT_MODEL,
        temperature: COPY_TEMPERATURE,
        messages: [
          {
            role: "system",
            content:
              "You write concise, human cold-email copy. Return only the requested line with no quotes or extra text."
          },
          { role: "user", content: prompt }
        ]
      }),
    { label: `openai.${label}` }
  );
  return cleanLine(out.choices[0]?.message?.content ?? "");
}

function cleanLine(text: string): string {
  return text
    .replace(/^["']|["']$/g, "")
    .replace(/^opening_line:\s*/i, "")
    .replace(/^teaser:\s*/i, "")
    .replace(/^cta:\s*/i, "")
    .replace(/[.]+$/, "")
    .trim();
}

function buildIcpFallbackTeaser(icp: MaIcp | null | undefined): string {
  if (icp?.example_blinded_teaser) return icp.example_blinded_teaser;
  const industry = icp?.target_industries[0];
  const type = icp?.target_company_types[0];
  if (industry && type) return `${type} in ${industry}`;
  if (industry) return `Privately held ${industry} business`;
  if (icp?.deal_size_bands[0]) return `${icp.deal_size_bands[0]} platform company`;
  return "Founder-led niche services business";
}

function buildIcpFallbackCta(icp: MaIcp | null | undefined): string {
  if (icp?.deal_types[0]) {
    return `We can connect you with companies like this that fit your ${icp.deal_types[0]} focus`;
  }
  if (icp?.target_industries[0]) {
    return `Happy to intro you to companies like this in ${icp.target_industries[0]}`;
  }
  return "We can connect you with companies like this aligned with your portfolio";
}

function buildIcpFallbackOpening(ctx: ReturnType<typeof buildMaLeadContext>): string {
  if (ctx.icp?.portfolio_imagination) {
    return `Saw ${ctx.companyName} works in ${ctx.icp.target_industries[0] || ctx.serviceType.toLowerCase()} — curious how you're sourcing new deals`;
  }
  return `Came across ${ctx.companyName} and your work in ${ctx.city || ctx.state || "the space"}`;
}

function buildNegativeExamples(batchCtx: MaOutreachBatchContext): string {
  const parts: string[] = [];
  if (batchCtx.recentOpenings.length > 0) {
    parts.push("Do NOT repeat these recent opening patterns:");
    parts.push(...batchCtx.recentOpenings.map((o) => `- "${o}"`));
  }
  if (batchCtx.recentCtas.length > 0) {
    parts.push("Do NOT repeat these recent CTA patterns:");
    parts.push(...batchCtx.recentCtas.map((c) => `- "${c}"`));
  }
  return parts.length > 0 ? parts.join("\n") : "";
}

export function pushToBatchContext(
  batchCtx: MaOutreachBatchContext,
  result: MaOutreachResult,
  windowSize = 3
): void {
  batchCtx.recentOpenings.push(result.opening_line);
  batchCtx.recentCtas.push(result.cta);
  if (batchCtx.recentOpenings.length > windowSize) {
    batchCtx.recentOpenings.shift();
  }
  if (batchCtx.recentCtas.length > windowSize) {
    batchCtx.recentCtas.shift();
  }
}
