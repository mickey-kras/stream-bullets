// Fixed labels only. No handles, URLs, account IDs or user content.
export const CTA_EVENTS = [
  "cta_browse",
  "cta_suggest",
  "cta_vote",
  "cta_discuss",
  "cta_sign_in",
  "cta_your_page",
] as const;
export type CtaEvent = (typeof CTA_EVENTS)[number];

// One receipt per click. No cookies, storage or retries.
export function trackCta(event: CtaEvent): void {
  void fetch("/api/conversions", {
    method: "POST",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, id: crypto.randomUUID() }),
    keepalive: true,
  })
    .then((response: Response): void => {
      if (!response.ok) console.warn("conversion_count_failed");
    })
    .catch((): void => {
      console.warn("conversion_count_failed");
    });
}
