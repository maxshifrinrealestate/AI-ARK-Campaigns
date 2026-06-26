import { DEFAULT_CHAT_MODEL, getOpenAI, withRetry } from "../integrations/openai.js";
import { buildMaLeadContext, type MaLeadInput } from "./buildMaLeadContext.js";
import { enrichMaIcp, type MaIcp } from "./enrichMaIcp.js";
import { classifyMaServiceType } from "./classifyMaServiceType.js";
import { quickNormalizeCompanyName } from "./enrichMaLeadFast.js";
import {
  assembleColdEmailHtml,
  validateColdEmailHtml,
  validateCta,
  validateOpeningLine,
  validateTeaser
} from "./validateColdEmail.js";

export type MaSequentialResult = {
  company_name_normalized: string;
  ma_service_type: string;
  icp: MaIcp;
  narrative_angle: string;
  opening_line: string;
  teaser: string;
  cta: string;
  cold_email_html: string;
};

const COPY_TEMP = 0.82;
const MAX_RETRIES = 2;

const GLOBAL_BANS = `
Never use:
- Empty compliments ("impressive", "excels", "stands out", "unique approach", "truly", "powerful")
- "You focus on" / "Noticed you" / "I came across"
- Template filler or marketing speak ("unlock", "enhance", "growth strategies")
- Implied possession of a live deal ("we have a company", "ready to sell")
- Salutations (Hi/Hello) or signatures
`;

async function generateSection(
  label: string,
  system: string,
  user: string,
  temperature = COPY_TEMP
): Promise<string> {
  const openai = getOpenAI();
  const out = await withRetry(
    () =>
      openai.chat.completions.create({
        model: DEFAULT_CHAT_MODEL,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
    { label: `openai.${label}` }
  );
  return cleanLine(out.choices[0]?.message?.content ?? "");
}

export async function enrichMaOutreachSequential(
  input: MaLeadInput,
  productDescription: string
): Promise<MaSequentialResult> {
  const companyNameNormalized = quickNormalizeCompanyName(
    input.company_name_normalized || input.company_name
  );

  const maServiceType = await classifyMaServiceType({
    companyNameNormalized,
    companyDescription: input.company_description,
    companyProductsServices: input.company_products_services,
    title: input.title,
    companyWebsite: input.company_website
  });

  const icp = await enrichMaIcp({
    ...input,
    company_name_normalized: companyNameNormalized,
    ma_service_type: maServiceType
  });

  const ctx = buildMaLeadContext({
    ...input,
    company_name_normalized: companyNameNormalized,
    ma_service_type: maServiceType,
    ma_icp: icp
  });

  const firstName = ctx.firstName || "there";
  let narrativeAngle = "";
  let openingLine = "";
  let teaser = "";
  let cta = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    narrativeAngle = await generateSection(
      `narrative "${firstName}"`,
      `You pick one specific, credible angle for a cold email to an M&A/capital advisory contact. Return one short sentence describing the angle only — not the email text. ${GLOBAL_BANS}`,
      `${ctx.promptBlock}

Pick a narrative angle grounded in their sector, deal size, geography, or mandate. No flattery. Return one sentence only.`
    );

    openingLine = await generateSection(
      `opening "${firstName}"`,
      `You write the opening line of a cold email. It comes right after the prospect's first name — do NOT include their name.

${GLOBAL_BANS}
- Sound like a person who read about their firm for 60 seconds
- Observation, question, or direct point — not a compliment
- Under 22 words
- Do not mention any blinded company yet
- Return only the opening line`,
      `Narrative angle for this email: ${narrativeAngle}

${ctx.promptBlock}

Our offer (context only, do not pitch): ${productDescription}
${attempt > 0 ? "Rewrite — previous opening felt templated or complimentary." : ""}`
    );

    const openingVal = validateOpeningLine(openingLine, firstName);
    if (!openingVal.ok && attempt < MAX_RETRIES) continue;

    teaser = await generateSection(
      `teaser "${firstName}"`,
      `You write the NEXT sentence in the same cold email — it must flow directly from the opening line like one continuous thought.

${GLOBAL_BANS}
- 8-10 words
- Hypothetical blinded company profile matching their ICP — max TWO dimensions (industry+type OR size+industry OR location+type)
- Must read as a natural continuation of the opening, NOT a random profile dropped in
- No company names
- Return only the teaser sentence`,
      `Opening line already written:
"${openingLine}"

Narrative angle: ${narrativeAngle}
${ctx.icpBlock}

The teaser should feel like the opening naturally leads to this example company type.
${attempt > 0 ? "Rewrite — previous teaser did not flow from the opening." : ""}`
    );

    const teaserVal = validateTeaser(teaser);
    if (!teaserVal.ok && attempt < MAX_RETRIES) continue;

    cta = await generateSection(
      `cta "${firstName}"`,
      `You write the closing sentence of the same cold email. It must complete the narrative started by the opening and teaser.

${GLOBAL_BANS}
- One sentence, casual and human
- Vague connectivity only: we can intro/connect them with companies like the teaser that fit their mandate/portfolio/criteria
- Never claim we hold the account
- Return only the CTA`,
      `Opening: "${openingLine}"
Teaser: "${teaser}"
Narrative angle: ${narrativeAngle}
Their portfolio focus: ${icp.portfolio_imagination}

Our offer: ${productDescription}
The CTA should feel like the natural end of this specific email thread — not a generic closer.
${attempt > 0 ? "Rewrite — previous CTA felt templated." : ""}`
    );

    const ctaVal = validateCta(cta);
    if (!ctaVal.ok && attempt < MAX_RETRIES) continue;

    const html = assembleColdEmailHtml(firstName, openingLine, teaser, cta);
    const emailVal = validateColdEmailHtml(html, firstName);
    if (emailVal.ok) {
      return {
        company_name_normalized: companyNameNormalized,
        ma_service_type: maServiceType,
        icp,
        narrative_angle: narrativeAngle,
        opening_line: openingLine,
        teaser,
        cta,
        cold_email_html: html
      };
    }
    if (attempt === MAX_RETRIES) {
      return {
        company_name_normalized: companyNameNormalized,
        ma_service_type: maServiceType,
        icp,
        narrative_angle: narrativeAngle,
        opening_line: openingLine,
        teaser,
        cta,
        cold_email_html: html
      };
    }
  }

  const html = assembleColdEmailHtml(
    firstName,
    openingLine,
    teaser,
    cta || "Happy to intro you to companies like this if it's relevant."
  );
  return {
    company_name_normalized: companyNameNormalized,
    ma_service_type: maServiceType,
    icp,
    narrative_angle: narrativeAngle,
    opening_line: openingLine,
    teaser,
    cta,
    cold_email_html: html
  };
}

function cleanLine(text: string): string {
  return text
    .replace(/^["']|["']$/g, "")
    .replace(/^(opening|teaser|cta|narrative)\s*:\s*/i, "")
    .trim();
}
