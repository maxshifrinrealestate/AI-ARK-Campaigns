import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { buildMaLeadContext, type MaLeadInput } from "./buildMaLeadContext.js";
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
  input: MaLeadInput,
  config: MaOutreachConfig,
  batchCtx: MaOutreachBatchContext = { recentOpenings: [], recentCtas: [] }
): Promise<MaOutreachResult> {
  const ctx = buildMaLeadContext(input);
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

    teaser = await generateTeaser(ctx, openingLine, config, attempt);
    const teaserVal = validateTeaser(teaser);
    if (!teaserVal.ok) {
      if (attempt === MAX_RETRIES) break;
      continue;
    }

    cta = await generateCta(ctx, openingLine, teaser, config, negativeExamples, attempt);
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

  const html = assembleColdEmailHtml(
    ctx.firstName,
    openingLine || "Wanted to share something that might fit your deal focus.",
    teaser || "Family-owned mid-market business.",
    cta || "We can connect you with companies like this that fit your criteria."
  );
  return {
    opening_line: openingLine || "Wanted to share something that might fit your deal focus.",
    teaser: teaser || "Family-owned mid-market business.",
    cta: cta || "We can connect you with companies like this that fit your criteria.",
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
  config: MaOutreachConfig,
  attempt: number
): Promise<string> {
  const prompt = `Write a teaser line (8-10 words) for a cold email.

${SHARED_RULES}
- Hypothetical company profile — the KIND of company they'd pursue. NOT a real company we hold.
- Use at most TWO of these dimensions: industry, size/revenue band, location, company type.
- Do NOT stack industry + size + location + type together.
- No company names. No "ready to sell" or "preparing exit".
- Must flow naturally from the opening line.

Opening line already written:
"${openingLine}"

${ctx.promptBlock}
${attempt > 0 ? "Previous teaser failed validation (too many specifics or possession language). Simplify to max 2 dimensions." : ""}

Return only the teaser (8-10 words).`;

  return generateCopy(prompt, `teaser "${ctx.firstName}"`);
}

async function generateCta(
  ctx: ReturnType<typeof buildMaLeadContext>,
  openingLine: string,
  teaser: string,
  config: MaOutreachConfig,
  negativeExamples: string,
  attempt: number
): Promise<string> {
  const prompt = `Write ONE closing CTA sentence for a cold email.

${SHARED_RULES}
- Vague connectivity framing — we can connect/introduce them to companies LIKE the teaser.
- Use soft language: "connect you with companies like this", "intros to companies that fit your criteria/mandate/portfolio/investment vision".
- NEVER say we have a company, deal, or seller.
- Outcome-focused for them. One sentence only.
- Wording must differ from typical cold emails.

Opening: "${openingLine}"
Teaser: "${teaser}"

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
