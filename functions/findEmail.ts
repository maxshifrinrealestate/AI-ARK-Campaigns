import { findEmailViaTryKitt } from "../integrations/trykitt.js";
import { cleanText, domainFromWebsite } from "./classifyMx.js";

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

export async function findEmail(input: FindEmailInput): Promise<FindEmailResult> {
  const firstName = cleanText(input.firstName);
  const lastName = cleanText(input.lastName);
  let domain = domainFromWebsite(input.companyWebsite);
  if (!domain) {
    domain = domainFromCompanyLinkedin(input.companyLinkedin);
  }

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

function domainFromCompanyLinkedin(linkedin: unknown): string {
  const v = cleanText(linkedin);
  if (!v) return "";
  const match = v.match(/linkedin\.com\/company\/([^\/?#]+)/i);
  if (!match) return "";
  return "";
}
