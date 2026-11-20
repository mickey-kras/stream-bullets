import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { getLocale, LOCALE_NAMES, t, type Locale } from "../../i18n";
import { detached } from "../../lib/detached";
import { dialogHref, type DialogState } from "../account/dialog-route";
import { Icon } from "../ui/icon";

// Globe button in both headers. Its name states the current language; it opens the shared language dialog.
// A button carries no address, so pages that must not repeat their query, such as error pages, stay clean.
export function HeaderLanguage(): ReactNode {
  const location = useLocation();
  const navigate = useNavigate();
  const locale: Locale = getLocale();
  const label: string = t("language.current", { name: LOCALE_NAMES[locale] });
  return (
    <button
      type="button"
      className="header-language"
      aria-haspopup="dialog"
      aria-label={label}
      title={label}
      onClick={() =>
        detached(
          navigate(dialogHref(location, "language"), {
            state: { dialogFrom: location.pathname, languageOpener: "header" } satisfies DialogState,
            preventScrollReset: true,
          }),
        )
      }
    >
      <Icon name="globe" size={20} />
    </button>
  );
}
