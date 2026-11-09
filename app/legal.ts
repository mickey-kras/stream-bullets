/**
 * Contact addresses (approved item 48). General contact (the Contact dialog, footer, support and ideas) uses
 * support@; the privacy policy, terms and data requests use privacy@. Both are routed by Cloudflare Email Routing.
 */
export const contactEmails = {
  support: "support@streambullets.com",
  privacy: "privacy@streambullets.com",
} as const;

/**
 * Operator details shown in the privacy policy, terms, and contact points.
 * Replace every placeholder before launch. `legalPlaceholdersRemain` lets pages
 * show a visible warning while any placeholder is still present.
 */
export const legal = {
  operatorName: "[OPERATOR NAME]",
  operatorCountry: "[COUNTRY OF RESIDENCE]",
  contactEmail: contactEmails.privacy,
  minimumAge: 16,
  policyEffectiveDate: "[EFFECTIVE DATE]",
} as const;

export const legalPlaceholdersRemain: boolean = Object.values(legal).some(
  (value: string | number): boolean => typeof value === "string" && value.startsWith("["),
);
