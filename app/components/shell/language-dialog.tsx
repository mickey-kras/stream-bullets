import { useState, type ReactNode } from "react";
import { DEFAULT_LOCALE, getLocale, LOCALE_NAMES, LOCALES, t, type Locale } from "../../i18n";
import { LOCALE_COOKIE } from "../../i18n/resolve";
import { setCookie } from "../../lib/prefs";
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
export async function chooseLocale(locale: Locale, signedIn: boolean): Promise<void> {
  if (signedIn) await sendJson("PATCH", "/api/me/locale", { locale });
  setCookie(LOCALE_COOKIE, locale);
  globalThis.location.reload();
}

/** The language list (item 38). Each name shows in its own language and script. */
export function LanguageDialog({ onClose }: Readonly<{ onClose: () => void }>): ReactNode {
  const shell = useShell();
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
      await chooseLocale(locale, Boolean(shell.viewer));
    } catch (failure: unknown) {
      setError(errorMessage(failure));
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
