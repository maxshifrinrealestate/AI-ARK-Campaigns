import {
  findEmailViaTryKitt,
  findEmailsViaTryKittPool,
  type TryKittPoolItem
} from "../integrations/trykitt.js";
import { cleanText } from "./classifyMx.js";
import { resolveTryKittDomain } from "./classifyMx.js";

export type FindEmailInput = {
  firstName?: string;
  lastName?: string;
  companyName?: string;
  companyWebsite?: string;
  companyLinkedin?: string;
  /** Person LinkedIn URL (TryKitt `linkedinStandardProfileURL`). */
  personLinkedin?: string;
};

export type FindEmailResult = {
  email: string | null;
  domainUsed: string;
};

export function resolveFindEmailDomain(input: FindEmailInput): string {
  return resolveTryKittDomain(input.companyWebsite);
}

export async function findEmail(input: FindEmailInput): Promise<FindEmailResult> {
  const firstName = cleanText(input.firstName);
  const lastName = cleanText(input.lastName);
  const domain = resolveFindEmailDomain(input);

  if (!firstName || !lastName || !domain) {
    return { email: null, domainUsed: domain };
  }

  const personLinkedin = cleanText(input.personLinkedin);
  const result = await findEmailViaTryKitt({
    firstName,
    lastName,
    domain,
    companyName: cleanText(input.companyName) || undefined,
    linkedinUrl: personLinkedin || undefined
  });
  return { email: result.email, domainUsed: domain };
}

export type BatchFindEmailItem = FindEmailInput & { key: string | number };

/** Parallel TryKitt submit + HTTP job polling for many leads at once. */
export async function findEmailsBatch(
  items: BatchFindEmailItem[],
  opts?: { submitConcurrency?: number; pollConcurrency?: number }
): Promise<Map<string | number, FindEmailResult>> {
  const poolItems: TryKittPoolItem[] = [];
  const domainByKey = new Map<string | number, string>();

  for (const item of items) {
    const firstName = cleanText(item.firstName);
    const lastName = cleanText(item.lastName);
    const domain = resolveFindEmailDomain(item);
    domainByKey.set(item.key, domain);
    if (!firstName || !lastName || !domain) continue;
    poolItems.push({
      key: item.key,
      firstName,
      lastName,
      domain,
      companyName: cleanText(item.companyName) || undefined,
      linkedinUrl: cleanText(item.personLinkedin) || undefined
    });
  }

  const raw = await findEmailsViaTryKittPool(poolItems, opts);
  const mapped = new Map<string | number, FindEmailResult>();
  for (const item of items) {
    const domainUsed = domainByKey.get(item.key) ?? "";
    const hit = raw.get(item.key);
    mapped.set(item.key, { email: hit?.email ?? null, domainUsed });
  }
  return mapped;
}
