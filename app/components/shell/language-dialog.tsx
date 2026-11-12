import { useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import type { DialogState } from "../account/dialog-route";
import { DEFAULT_LOCALE, getLocale, LOCALE_NAMES, LOCALES, t, type Locale } from "../../i18n";
import { saveLocaleCookie } from "../../lib/prefs";
import { useShell } from "../../lib/shell";
import { sendJson, errorMessage } from "../api";
import { Icon } from "../ui/icon";
import { Sheet } from "../ui/sheet";

/** English first, then the others by their own names (as the approved mockup lists them). */
const ORDERED: readonly Locale[] = [
  DEFAULT_LOCALE,
  ...LOCALES.filter((locale: Locale) => locale !== DEFAULT_LOCALE).sort((a: Locale, b: Locale) =>
    LOCALE_NAMES[a].localeCompare(LOCALE_NAMES[b], "en", { sensitivity: "base" }),
  ),
];

/**
 * Saves the language and reloads the page in it. Signed in, the account keeps it (`PATCH /api/me/locale`);
 * the cookie keeps it for this browser either way.
 */
export async function chooseLocale(locale: Locale, signedIn: boolean, fromAccount: boolean = false): Promise<void> {
  if (signedIn) await sendJson("PATCH", "/api/me/locale", { locale });
  await saveLocaleCookie(locale);
  // Reload the same page without `?dialog=language`, so the list does not open again.
  const url = new URL(globalThis.location.href);
  url.searchParams.delete("dialog");
  try {
    sessionStorage.setItem("sb-language-opener", fromAccount ? "account" : "footer");
    sessionStorage.setItem("sb-language-focus", url.href);
  } catch {
    // Blocked storage must not prevent applying the saved language.
  }
  globalThis.location.replace(url.href);
}

/** The language list (item 38). Each name shows in its own language and script. */
export function LanguageDialog({ onClose }: Readonly<{ onClose: () => void }>): ReactNode {
  const shell = useShell();
  const location = useLocation();
  const fromAccount: boolean = (location.state as DialogState | null)?.languageOpener === "account";
  const active: Locale = getLocale();
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  async function pick(locale: Locale): Promise<void> {
    if (locale === active) {
      onClose();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await chooseLocale(locale, Boolean(shell.viewer), fromAccount);
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
              onClick={() => void pick(locale)}
            >
              {locale === active ? <Icon name="check" size={18} /> : <span className="lang-check" aria-hidden="true" />}
              <span>{LOCALE_NAMES[locale]}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
