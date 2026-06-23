import { cleanText } from "./classifyMx.js";

export type MaLeadInput = {
  first_name?: string;
  last_name?: string;
  title?: string;
  company_name?: string;
  company_name_normalized?: string;
  company_description?: string;
  company_products_services?: string;
  company_industry?: string;
  company_size?: string;
  city?: string;
  state?: string;
  country?: string;
  company_website?: string;
  company_linkedin?: string;
  ma_service_type?: string;
};

export type MaLeadContext = {
  firstName: string;
  title: string;
  companyName: string;
  serviceType: string;
  description: string;
  productsServices: string;
  industry: string;
  companySize: string;
  city: string;
  state: string;
  country: string;
  website: string;
  promptBlock: string;
};

export function buildMaLeadContext(input: MaLeadInput): MaLeadContext {
  const firstName = cleanText(input.first_name);
  const title = cleanText(input.title);
  const companyName = cleanText(input.company_name_normalized || input.company_name);
  const serviceType = cleanText(input.ma_service_type) || "Advisory";
  const description = cleanText(input.company_description);
  const productsServices = cleanText(input.company_products_services);
  const industry = cleanText(input.company_industry);
  const companySize = cleanText(input.company_size);
  const city = cleanText(input.city);
  const state = cleanText(input.state);
  const country = cleanText(input.country);
  const website = cleanText(input.company_website);

  const lines = [
    `Prospect first name: ${firstName || "(unknown)"}`,
    `Title: ${title || "(unknown)"}`,
    `Firm: ${companyName || "(unknown)"}`,
    `Service type: ${serviceType}`,
    industry ? `Industry: ${industry}` : "",
    companySize ? `Firm size (employees): ${companySize}` : "",
    [city, state, country].filter(Boolean).length > 0
      ? `Location: ${[city, state, country].filter(Boolean).join(", ")}`
      : "",
    description ? `Description: ${truncate(description, 400)}` : "",
    productsServices ? `Products/Services: ${truncate(productsServices, 300)}` : "",
    website ? `Website: ${website}` : ""
  ].filter(Boolean);

  return {
    firstName,
    title,
    companyName,
    serviceType,
    description,
    productsServices,
    industry,
    companySize,
    city,
    state,
    country,
    website,
    promptBlock: lines.join("\n")
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
