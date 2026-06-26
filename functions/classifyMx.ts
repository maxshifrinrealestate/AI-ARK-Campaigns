import axios from "axios";
import { withRetry } from "../integrations/openai.js";

export type Esp = "google" | "outlook" | "others" | "empty";

export type MxResult = {
  domain: string;
  mxData: string;
  esp: Esp;
  isSeg: boolean;
};

const GOOGLE_PATTERNS = ["google", "googlemail", "aspmx", "gmail", "gsuite", "workspace"];
const OUTLOOK_PATTERNS = ["outlook", "office365", "microsoft", "hotmail", "protection.outlook.com"];
const SEG_PATTERNS = [
  "proofpoint",
  "pphosted",
  "ppe-hosted",
  "mimecast",
  "barracuda",
  "barracudanetworks",
  "cisco",
  "ironport",
  "messagelabs",
  "sophos",
  "securence",
  "spamtitan",
  "mailprotector",
  "abnormal"
];

const cache = new Map<string, MxResult>();

export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value).replace(/\ufeff/g, "").trim();
  if (["nan", "none", "null"].includes(text.toLowerCase())) return "";
  return text;
}

export function domainFromEmail(email: unknown): string {
  const e = cleanText(email);
  if (!e.includes("@")) return "";
  return e.split("@", 2)[1]!.trim().toLowerCase();
}

/**
 * Normalize a website, URL, or host to a bare domain for TryKitt (no https/www/path).
 */
export function normalizeTryKittDomain(raw: unknown): string {
  let s = cleanText(raw);
  if (!s) return "";

  if (s.includes("@")) {
    return domainFromEmail(s);
  }

  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && s.includes("/") && !s.startsWith("//")) {
    const first = s.split("/")[0]!.trim();
    if (first.includes(".")) s = first;
  }

  if (/^https?:\/\//i.test(s) || s.startsWith("//")) {
    try {
      const url = new URL(s.startsWith("//") ? `https:${s}` : s);
      s = url.hostname;
    } catch {
      s = s.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0] ?? "";
    }
  } else {
    s = s.split(/[/?#]/)[0] ?? s;
  }

  s = s.trim().toLowerCase();
  if (s.startsWith("www.")) s = s.slice(4);
  s = s.replace(/:\d+$/, "");
  s = s.replace(/\.+$/, "");

  if (!s || !s.includes(".")) return "";
  if (!/^[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}$/i.test(s)) return "";

  return s;
}

export function resolveTryKittDomain(companyWebsite: unknown, emailBusiness?: unknown): string {
  const fromSite = normalizeTryKittDomain(companyWebsite);
  if (fromSite) return fromSite;
  return domainFromEmail(emailBusiness);
}

export function domainFromWebsite(website: unknown): string {
  return normalizeTryKittDomain(website);
}

export function resolveLeadDomain(emailBusiness: unknown, companyWebsite: unknown): string {
  const fromEmail = domainFromEmail(emailBusiness);
  if (fromEmail) return fromEmail;
  return domainFromWebsite(companyWebsite);
}

function classifyEsp(mxData: string): Esp {
  if (!mxData) return "empty";
  const lower = mxData.toLowerCase();
  if (GOOGLE_PATTERNS.some((p) => lower.includes(p))) return "google";
  if (OUTLOOK_PATTERNS.some((p) => lower.includes(p))) return "outlook";
  return "others";
}

export function espFromMxData(mxData: string): Esp {
  return classifyEsp(mxData);
}

export function isSegMxData(mxData: string): boolean {
  const lower = mxData.toLowerCase();
  return SEG_PATTERNS.some((p) => lower.includes(p));
}

export async function classifyMx(domain: string): Promise<MxResult> {
  const d = domain.trim().toLowerCase();
  if (!d) {
    return { domain: "", mxData: "", esp: "empty", isSeg: false };
  }
  const hit = cache.get(d);
  if (hit) return hit;

  let mxData = "";
  try {
    const resp = await withRetry(
      async () =>
        axios.get(`https://dns.google.com/resolve`, {
          params: { name: d, type: "MX" },
          timeout: 20_000
        }),
      { label: `dns.MX ${d}` }
    );
    const answers = (resp.data?.Answer ?? []) as Array<{ data?: string }>;
    mxData = answers
      .map((a) => String(a.data ?? ""))
      .join(" ")
      .toLowerCase()
      .trim();
  } catch {
    mxData = "";
  }

  const result: MxResult = {
    domain: d,
    mxData,
    esp: classifyEsp(mxData),
    isSeg: SEG_PATTERNS.some((p) => mxData.includes(p))
  };
  cache.set(d, result);
  return result;
}
