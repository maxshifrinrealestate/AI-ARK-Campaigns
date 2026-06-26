export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

const BANNED_ROBOTIC = [
  /you focus on/i,
  /noticed you focus/i,
  /i came across your firm/i,
  /hope this finds you well/i,
  /just reaching out/i,
  /i wanted to reach out/i,
  /\bimpressive\b/i,
  /\bexcels\b/i,
  /\bstands out\b/i,
  /\bunique approach\b/i,
  /\bpowerful catalyst\b/i,
  /\btruly\b/i,
  /is vital\b/i,
  /is inspiring\b/i
];

const BANNED_POSSESSION = [
  /we have a (company|deal|seller|target)/i,
  /i have a (company|deal|seller|target)/i,
  /on my desk/i,
  /ready to sell/i,
  /preparing (an )?exit/i,
  /owner ready to step back/i,
  /came across my desk/i,
  /live (deal|target|seller)/i
];

const BANNED_MARKETING = [
  /^unlock/i,
  /^enhance/i,
  /^achieve/i,
  /growth strateg/i,
  /growth potential/i,
  /growth opportunit/i
];

const BANNED_SALUTATIONS = /^(hi|hello|dear|hey)\b/i;

const BANNED_SIGNATURE = [
  /\b(best|regards|thanks|cheers|sincerely)\b/i,
  /\b(ceo|founder|partner|director)\b/i
];

const SPAM_WORDS = [
  /\bfree\b/i,
  /\bguarantee/i,
  /act now/i,
  /limited time/i,
  /!!!+/,
  /\$\$\$/
];

const INDUSTRY_PATTERNS = [
  /\b(industrial|healthcare|saas|software|manufacturing|tech|retail|services|energy|logistics|construction|food|media|financial)\b/i
];
const SIZE_PATTERNS = [
  /\$[\d,.]+[kmb]?\b/i,
  /\b\d+[\-–]\d+\s*m\b/i,
  /\bmid[\- ]?market\b/i,
  /\blower[\- ]?middle\b/i,
  /\brevenue\b/i,
  /\b\d+\s*million\b/i
];
const LOCATION_PATTERNS = [
  /\b(midwest|southeast|northeast|southwest|west coast|east coast|texas|chicago|california|florida|new york|boston|atlanta|dallas|denver|seattle)\b/i,
  /\b(us|usa|united states)\b/i
];
const TYPE_PATTERNS = [
  /\bfamily[\- ]?owned\b/i,
  /\bfounder[\- ]?led\b/i,
  /\bpe[\- ]?backed\b/i,
  /\bprivately held\b/i,
  /\bbootstrapped\b/i
];

export function validateOpeningLine(line: string, firstName: string): ValidationResult {
  const errors: string[] = [];
  const text = line.trim();
  if (!text) errors.push("opening_line is empty");
  if (text.length > 120) errors.push("opening_line too long");
  for (const p of BANNED_ROBOTIC) {
    if (p.test(text)) errors.push(`opening_line matches robotic pattern: ${p}`);
  }
  if (firstName && text.toLowerCase().startsWith(firstName.toLowerCase())) {
    errors.push("opening_line should not repeat first name");
  }
  return { ok: errors.length === 0, errors };
}

export function validateTeaser(teaser: string): ValidationResult {
  const errors: string[] = [];
  const text = teaser.trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 5 || words.length > 14) {
    errors.push(`teaser word count ${words.length} (want 8-10, allow 5-14)`);
  }
  for (const p of [...BANNED_POSSESSION, ...BANNED_ROBOTIC, ...BANNED_MARKETING]) {
    if (p.test(text)) errors.push(`teaser matches banned pattern: ${p}`);
  }
  const dims = countTeaserDimensions(text);
  if (dims > 2) {
    errors.push(`teaser has ${dims} specificity dimensions (max 2)`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateCta(cta: string): ValidationResult {
  const errors: string[] = [];
  const text = cta.trim();
  if (!text) errors.push("cta is empty");
  const hasConnectivity =
    /connect you with|intro(s|duce)? (you )?to|point you toward|companies like|fit your|aligned with your|fall under your|investment vision|your (mandate|portfolio|focus|criteria)/i.test(
      text
    );
  if (!hasConnectivity) {
    errors.push("cta lacks vague connectivity framing");
  }
  for (const p of BANNED_POSSESSION) {
    if (p.test(text)) errors.push(`cta matches possession pattern: ${p}`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateColdEmailHtml(
  html: string,
  firstName: string,
  recentOpenings: string[] = [],
  recentCtas: string[] = []
): ValidationResult {
  const errors: string[] = [];
  if (!html.startsWith("<div>") || !html.endsWith("</div>")) {
    errors.push("HTML must start with <div> and end with </div>");
  }
  if (/<(?!div|br\s*\/?>|\/div)[a-z]/i.test(html)) {
    errors.push("HTML contains tags other than div and br");
  }

  const bodyText = html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?div>/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = bodyText.split(/\s+/).filter(Boolean);
  if (words.length > 62) {
    errors.push(`email word count ${words.length} (max 60)`);
  }

  if (!bodyText.toLowerCase().startsWith(firstName.toLowerCase())) {
    errors.push("email must start with first name");
  }
  if (BANNED_SALUTATIONS.test(bodyText)) {
    errors.push("email contains salutation");
  }
  for (const p of [...BANNED_ROBOTIC, ...BANNED_POSSESSION, ...BANNED_SIGNATURE, ...SPAM_WORDS]) {
    if (p.test(bodyText)) errors.push(`email matches banned pattern: ${p}`);
  }

  const parts = html
    .replace(/^<div>/, "")
    .replace(/<\/div>$/, "")
    .split(/<br\s*\/?>/i)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length < 4) {
    errors.push("email should have first name + opening + teaser + cta");
  }

  const opening = parts[1] ?? "";
  const cta = parts[parts.length - 1] ?? "";
  for (const prev of recentOpenings) {
    if (jaccardSimilarity(opening, prev) > 0.8) {
      errors.push("opening_line too similar to recent row");
      break;
    }
  }
  for (const prev of recentCtas) {
    if (jaccardSimilarity(cta, prev) > 0.8) {
      errors.push("cta too similar to recent row");
      break;
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assembleColdEmailHtml(
  firstName: string,
  openingLine: string,
  teaser: string,
  cta: string
): string {
  return `<div>${firstName}<br><br>${openingLine}<br><br>${teaser}<br><br>${cta}</div>`;
}

function countTeaserDimensions(text: string): number {
  let count = 0;
  if (INDUSTRY_PATTERNS.some((p) => p.test(text))) count++;
  if (SIZE_PATTERNS.some((p) => p.test(text))) count++;
  if (LOCATION_PATTERNS.some((p) => p.test(text))) count++;
  if (TYPE_PATTERNS.some((p) => p.test(text))) count++;
  return count;
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}
