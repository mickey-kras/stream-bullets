/**
 * Contact addresses (approved item 48). General contact (the Contact dialog, footer, support and ideas) uses
 * support@; the privacy policy, terms and data requests use privacy@. Both are routed by Cloudflare Email Routing.
 */
export const contactEmails = {
  support: "support@streambullets.com",
  privacy: "privacy@streambullets.com",
} as const;

/**
 * Public legal fields. Runtime configuration supplies operator details on the legal routes.
 * The defaults keep unconfigured deployments visibly in draft without personal data in source.
 */
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
