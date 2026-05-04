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

export function domainFromWebsite(website: unknown): string {
  let w = cleanText(website);
  if (!w) return "";
  if (!/^https?:\/\//i.test(w)) {
    w = "https://" + w;
  }
  try {
    const url = new URL(w);
    let host = url.host.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return "";
  }
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
