import { useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import type { DialogState } from "../account/dialog-route";
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
export async function chooseLocale(locale: Locale, signedIn: boolean, fromAccount: boolean = false): Promise<void> {
  if (signedIn) await sendJson("PATCH", "/api/me/locale", { locale });
  await saveLocaleCookie(locale);
  // Remove dialog=language before reload to avoid reopening.
  const url = new URL(globalThis.location.href);
  url.searchParams.delete("dialog");
  try {
    sessionStorage.setItem("sb-language-opener", fromAccount ? "account" : "footer");
    sessionStorage.setItem("sb-language-focus", url.href);
  } catch {
    // Blocked storage must not prevent locale changes.
  }
  globalThis.location.replace(url.href);
}

// Display names in each language's own script.
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
