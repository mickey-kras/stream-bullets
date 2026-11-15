import { t } from "../i18n";
import { LOCALE_COOKIE } from "../i18n/resolve";
import type { DisplayPrefs } from "../types";

// Browser copy preserves preferences after sign-out.
export const PREFS_COOKIE = "sb_prefs";

export const DEFAULT_PREFS: Required<DisplayPrefs> = {
  cvd: "default",
  contrast: "default",
  motion: "system",
  text: "100",
  underline: false,
  font: "default",
  mashAssist: "off",
  srInterval: "5",
  shortcuts: true,
};

export function withDefaults(prefs: DisplayPrefs | null | undefined): Required<DisplayPrefs> {
  return { ...DEFAULT_PREFS, ...prefs };
}

// Apply data-prefs to html before paint. Follow-system settings track media queries. Expose the same function
// as sbApplyPrefs for dialog updates.
export const PREFS_SCRIPT: string = `(function () {
  var root = document.documentElement;
  var script = document.currentScript;
  var current = {};
  function media(query) {
    try { return window.matchMedia(query).matches; } catch (error) { return false; }
  }
  function apply(prefs) {
    current = prefs || {};
    var contrast = current.contrast || "default";
    var motion = current.motion || "system";
    var high = contrast === "high" || (contrast === "default" && media("(prefers-contrast: more)"));
    var reduced = motion === "reduce" || (motion === "system" && media("(prefers-reduced-motion: reduce)"));
    root.setAttribute("data-cvd", current.cvd || "default");
    root.setAttribute("data-contrast", high ? "high" : "default");
    root.setAttribute("data-motion", motion);
    root.setAttribute("data-reduced", String(reduced));
    root.setAttribute("data-text", current.text || "100");
    root.setAttribute("data-underline", String(Boolean(current.underline) || high));
    root.setAttribute("data-font", current.font || "default");
  }
  window.sbApplyPrefs = apply;
  try { apply(JSON.parse((script && script.getAttribute("data-prefs")) || "{}")); } catch (error) { apply({}); }
  ["(prefers-contrast: more)", "(prefers-reduced-motion: reduce)"].forEach(function (query) {
    var list = window.matchMedia ? window.matchMedia(query) : null;
    if (list && list.addEventListener) list.addEventListener("change", function () { apply(current); });
  });
})();`;

declare global {
  interface Window {
    sbApplyPrefs?: (prefs: DisplayPrefs) => void;
  }
}

export function applyPrefs(prefs: DisplayPrefs): void {
  globalThis.window?.sbApplyPrefs?.(prefs);
}

// One-year cookie makes preferences available before paint.
export async function savePrefsCookie(prefs: DisplayPrefs): Promise<void> {
  try {
    await setPreferenceCookie(PREFS_COOKIE, JSON.stringify(prefs), { prefs });
  } catch {
    // Keep the applied/account change; retry cookie storage on the next change.
  }
}

export function saveLocaleCookie(locale: string): Promise<void> {
  return setPreferenceCookie(LOCALE_COOKIE, locale, { locale });
}

// Set a one-year first-party cookie through Cookie Store or POST /api/preference-cookies. Never write
// document.cookie.
export async function setPreferenceCookie(name: string, value: string, fallback: object): Promise<void> {
  const store = globalThis.cookieStore;
  if (store) {
    await store.set({
      name,
      value: encodeURIComponent(value),
      path: "/",
      sameSite: "lax",
      expires: Date.now() + 31_536_000_000,
    });
    return;
  }
  const response: Response = await fetch("/api/preference-cookies", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fallback),
  });
  if (!response.ok) throw new Error(t("common.failed"));
}

// Dialog changes override the shell loader's initial preferences for this page view.
let changed: DisplayPrefs | null = null;
const listeners = new Set<() => void>();

export function setChangedPrefs(prefs: DisplayPrefs): void {
  changed = prefs;
  for (const listener of listeners) listener();
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function changedPrefs(): DisplayPrefs | null {
  return changed;
}
