// Cloudflare routes general contact to support@ and legal/data requests to privacy@.
export const contactEmails = {
  support: "support@streambullets.com",
  privacy: "privacy@streambullets.com",
} as const;

// Runtime operator details keep unconfigured legal pages in draft without exposing personal data in source.
export interface LegalDetails {
  operatorName: string;
  operatorCountry: string;
  contactEmail: string;
  minimumAge: number;
  policyEffectiveDate: string;
}

export const legal: LegalDetails = {
  operatorName: "[OPERATOR NAME]",
  operatorCountry: "[COUNTRY OF RESIDENCE]",
  contactEmail: contactEmails.privacy,
  minimumAge: 16,
  policyEffectiveDate: "[EFFECTIVE DATE]",
} as const;

export function legalPlaceholdersRemain(details: LegalDetails): boolean {
  return Object.values(details).some(
    (value: string | number): boolean => typeof value === "string" && value.startsWith("["),
  );
}
