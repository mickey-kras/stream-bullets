/**
 * Operator details shown in the privacy policy, terms, and contact points.
 * Replace every placeholder before launch. `legalPlaceholdersRemain` lets pages
 * show a visible warning while any placeholder is still present.
 */
export const legal = {
  operatorName: "[OPERATOR NAME]",
  operatorCountry: "[COUNTRY OF RESIDENCE]",
  contactEmail: "privacy@streambullets.com",
  minimumAge: 16,
  policyEffectiveDate: "[EFFECTIVE DATE]",
} as const;

export const legalPlaceholdersRemain: boolean = Object.values(legal).some(
  (value: string | number): boolean => typeof value === "string" && value.startsWith("["),
);
