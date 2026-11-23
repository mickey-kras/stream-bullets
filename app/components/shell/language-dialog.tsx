import { useState, type ReactNode } from "react";
import { useLocation, useRevalidator } from "react-router";
import type { DialogState, LanguageOpener } from "../account/dialog-route";
import { DEFAULT_LOCALE, getLocale, LOCALE_NAMES, LOCALES, t, type Locale } from "../../i18n";
import { saveLocaleCookie } from "../../lib/prefs";
import { useShell } from "../../lib/shell";
import { sendJson, errorMessage } from "../api";
import { Icon } from "../ui/icon";
import { Sheet } from "../ui/sheet";

// English first; remaining languages sort by native name.
const ORDERED: readonly Locale[] = [
  DEFAULT_LOCALE,
  ...LOCALES.filter((locale: Locale) => locale !== DEFAULT_LOCALE).sort((a: Locale, b: Locale) =>
    LOCALE_NAMES[a].localeCompare(LOCALE_NAMES[b], "en", { sensitivity: "base" }),
  ),
];

// Save locale to account when signed in and browser cookie; reload to apply it.
export async function chooseLocale(
  locale: Locale,
  signedIn: boolean,
  opener: LanguageOpener = "footer",
  keyboard: boolean = true,
): Promise<void> {
  if (signedIn) await sendJson("PATCH", "/api/me/locale", { locale });
  await saveLocaleCookie(locale);
  // Remove dialog=language before reload to avoid reopening.
  const url = new URL(globalThis.location.href);
  url.searchParams.delete("dialog");
  try {
    // After the reload, focus goes back to the control that opened the dialog, also for a screen reader that
    // sends a pointer click. After a pointer choice the control gets focus without its ring.
    sessionStorage.setItem("sb-language-opener", opener);
    sessionStorage.setItem("sb-language-focus", url.href);
    sessionStorage.setItem("sb-language-ring", keyboard ? "1" : "0");
  } catch {
    // Blocked storage must not prevent locale changes.
  }
  globalThis.location.replace(url.href);
}

/**
 * The languages that a signed-in reader reads. Content in these languages shows in its original text, without a
 * translation. Each change is saved, and the page loads its content again.
 */
function KeepOriginal({ saved, active }: Readonly<{ saved: readonly Locale[]; active: Locale }>): ReactNode {
  const revalidator = useRevalidator();
  const [keep, setKeep] = useState<readonly Locale[]>(saved);
  const [error, setError] = useState<string>("");
  async function toggle(locale: Locale, checked: boolean): Promise<void> {
    const next: Locale[] = LOCALES.filter((item: Locale) => (item === locale ? checked : keep.includes(item)));
    setKeep(next);
    setError("");
    try {
      await sendJson("PATCH", "/api/me/keep-original", { locales: next });
      await revalidator.revalidate();
    } catch (error_: unknown) {
      setKeep(keep);
      setError(errorMessage(error_));
    }
  }
  return (
    <fieldset className="keep-original">
      <legend>{t("language.keepTitle")}</legend>
      <p className="hint">{t("language.keepHelp")}</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {ORDERED.filter((locale: Locale) => locale !== active).map((locale: Locale) => (
        <label key={locale} className="choice">
          <input
            type="checkbox"
            checked={keep.includes(locale)}
            onChange={(event) => void toggle(locale, event.currentTarget.checked)}
          />
          <span lang={locale}>{LOCALE_NAMES[locale]}</span>
        </label>
      ))}
    </fieldset>
  );
}

// Display names in each language's own script.
export function LanguageDialog({ onClose }: Readonly<{ onClose: () => void }>): ReactNode {
  const shell = useShell();
  const location = useLocation();
  const opener: LanguageOpener = (location.state as DialogState | null)?.languageOpener ?? "footer";
  const active: Locale = getLocale();
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  async function pick(locale: Locale, keyboard: boolean): Promise<void> {
    if (locale === active) {
      onClose();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await chooseLocale(locale, Boolean(shell.viewer), opener, keyboard);
    } catch (error_: unknown) {
      setError(errorMessage(error_));
      setBusy(false);
    }
  }
  return (
    <Sheet
      open
      short
      name="language"
      title={t("language.title")}
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
    >
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <ul className="lang-list" aria-label={t("language.title")}>
        {ORDERED.map((locale: Locale) => (
          <li key={locale}>
            <button
              type="button"
              className="lang-option"
              lang={locale}
              aria-pressed={locale === active}
              disabled={busy}
              // A click from the keyboard has no click count.
              onClick={(event) => void pick(locale, event.detail === 0)}
            >
              {locale === active ? <Icon name="check" size={18} /> : <span className="lang-check" aria-hidden="true" />}
              <span>{LOCALE_NAMES[locale]}</span>
            </button>
          </li>
        ))}
      </ul>
      {shell.viewer && <KeepOriginal saved={shell.viewer.keepOriginal} active={active} />}
    </Sheet>
  );
}
