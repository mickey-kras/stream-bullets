import type { DisplayPrefs } from "../types";

/** Display preferences for signed-out visitors (and a copy for signed-in ones, so signing out keeps them). */
export const PREFS_COOKIE = "sb_prefs";

/** The defaults the "Accessibility & display" dialog starts from and resets to. */
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

/**
 * The inline head script. It runs before first paint, so a saved text size or contrast never flashes. It reads
 * the saved preferences from its own `data-prefs` attribute and sets the `data-*` hooks on <html> that the
 * styles use (app/styles/tokens.css and base.css). "Follow system" settings track the media queries live.
 * It also exposes the same function as `window.sbApplyPrefs`, so the preferences dialog applies a change
 * with exactly this code.
 */
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

/** Applies preferences to the page now, with the head script's own function. */
export function applyPrefs(prefs: DisplayPrefs): void {
  globalThis.window?.sbApplyPrefs?.(prefs);
}

/** Saves preferences in a cookie for this browser (one year, readable by the server for the first paint). */
export function savePrefsCookie(prefs: DisplayPrefs): Promise<void> {
  return setCookie(PREFS_COOKIE, JSON.stringify(prefs));
}

/** Sets a first-party preference cookie for one year, through the Cookie Store API. */
export async function setCookie(name: string, value: string): Promise<void> {
  await globalThis.cookieStore?.set({
    name,
    value: encodeURIComponent(value),
    path: "/",
    sameSite: "lax",
    expires: Date.now() + 31_536_000_000,
  });
}

/*
 * The preferences changed in this page view. The shell's loader data holds what was saved when the page loaded;
 * a change made in the dialog updates this store, and usePrefs() reads it first.
 */
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
