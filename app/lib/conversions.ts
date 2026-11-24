export const CLICK_STORAGE = "sb.clickStats.v1";
export const CLICK_PERMISSION = "v1";

export function privacySignal(headers: Headers): boolean {
  return headers.get("DNT") === "1" || headers.get("Sec-GPC") === "1";
}

export function clickMeasurementAllowed(): boolean {
  try {
    const expires = Number(globalThis.localStorage.getItem(CLICK_STORAGE));
    return (
      Number.isSafeInteger(expires) &&
      Date.now() < expires &&
      navigator.doNotTrack !== "1" &&
      Reflect.get(navigator, "globalPrivacyControl") !== true
    );
  } catch {
    // A browser that blocks storage has no verifiable opt-in.
    return false;
  }
}

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

// An opt-in applies only to this browser. Click requests carry no cookies or referrer.
export function trackCta(event: CtaEvent): void {
  if (!clickMeasurementAllowed()) return;
  void fetch("/api/conversions", {
    method: "POST",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, id: crypto.randomUUID(), permission: CLICK_PERMISSION }),
    keepalive: true,
  })
    .then((response: Response): void => {
      if (!response.ok) console.warn("conversion_count_failed");
    })
    .catch((): void => {
      console.warn("conversion_count_failed");
    });
}
