import { useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { getLocale, LOCALE_NAMES, t, type Locale } from "../../i18n";
import { paths } from "../../lib/shell";
import { Icon, type IconName } from "../ui/icon";
import { Sheet } from "../ui/sheet";
import { ContactDialog } from "./contact-dialog";
import { DialogLink } from "./dialog-link";

function MoreRow({ icon, children }: Readonly<{ icon: IconName; children: ReactNode }>): ReactNode {
  return (
    <>
      <Icon name={icon} size={18} />
      {children}
    </>
  );
}

/**
 * The footer: legal links on the gold bottom band of the frame (42px desktop, 34px phones) in dark ink; the
 * landing page keeps its own dark strip. Phones show Privacy, Terms and More; More opens a sheet with the rest.
 * Suggest an improvement opens the official Ideas board with its dialog. The language switch shows the current
 * language in its own script.
 */
export function SiteFooter(): ReactNode {
  const { pathname } = useLocation();
  const [dialog, setDialog] = useState<"contact" | "more" | null>(null);
  const current = (path: string): "page" | undefined => (pathname === path ? "page" : undefined);
  const locale: Locale = getLocale();
  const languageLabel: string = t("language.current", { name: LOCALE_NAMES[locale] });
  const close = (): void => setDialog(null);
  return (
    <footer className="site-footer">
      <nav aria-label={t("footer.nav")} className="footer-full">
        <Link to={paths.streamers} aria-current={current(paths.streamers)}>
          {t("nav.streamers")}
        </Link>
        <Link to={paths.privacy} aria-current={current(paths.privacy)}>
          {t("legal.privacy")}
        </Link>
        <Link to={paths.terms} aria-current={current(paths.terms)}>
          {t("legal.terms")}
        </Link>
        <button type="button" className="footer-link" aria-haspopup="dialog" onClick={() => setDialog("contact")}>
          {t("footer.contact")}
        </button>
        <Link to={paths.reporting}>{t("footer.report")}</Link>
        <DialogLink name="a11y">{t("footer.accessibility")}</DialogLink>
        <Link to={paths.ideas}>
          <Icon name="idea" size={16} />
          {t("ideas.suggest")}
        </Link>
        <Link to={paths.ai} className="footer-muted" aria-current={current(paths.ai)}>
          {t("footer.ai")}
        </Link>
        <DialogLink name="language" className="lang-switch" label={languageLabel}>
          <Icon name="globe" size={16} />
          <span lang={locale}>{LOCALE_NAMES[locale]}</span>
        </DialogLink>
      </nav>
      <nav aria-label={t("footer.nav")} className="footer-compact">
        <Link to={paths.privacy} aria-current={current(paths.privacy)}>
          {t("legal.privacy")}
        </Link>
        <Link to={paths.terms} aria-current={current(paths.terms)}>
          {t("legal.terms")}
        </Link>
        <button type="button" className="footer-link" aria-haspopup="dialog" onClick={() => setDialog("more")}>
          {t("footer.more")}
          <Icon name="chevron-down" size={16} />
        </button>
      </nav>
      <ContactDialog open={dialog === "contact"} onOpenChange={(open: boolean) => setDialog(open ? "contact" : null)} />
      <Sheet
        open={dialog === "more"}
        onOpenChange={(open: boolean) => setDialog(open ? "more" : null)}
        title={t("footer.more")}
        name="more"
        short
      >
        <ul className="more-list">
          <li>
            <button type="button" onClick={() => setDialog("contact")}>
              <MoreRow icon="mail">{t("footer.contact")}</MoreRow>
            </button>
          </li>
          <li>
            <Link to={paths.reporting} onClick={close}>
              <MoreRow icon="flag">{t("footer.report")}</MoreRow>
            </Link>
          </li>
          <li>
            <DialogLink name="a11y" onClick={close}>
              <MoreRow icon="eye">{t("footer.accessibility")}</MoreRow>
            </DialogLink>
          </li>
          <li>
            <DialogLink name="language" onClick={close}>
              <MoreRow icon="globe">{languageLabel}</MoreRow>
            </DialogLink>
          </li>
          <li>
            <Link to={paths.ai} onClick={close}>
              <MoreRow icon="about">{t("footer.ai")}</MoreRow>
            </Link>
          </li>
          <li>
            <Link to={paths.ideas} onClick={close}>
              <MoreRow icon="idea">{t("ideas.suggest")}</MoreRow>
            </Link>
          </li>
          <li>
            <Link to={paths.streamers} onClick={close}>
              <MoreRow icon="streamers">{t("nav.streamers")}</MoreRow>
            </Link>
          </li>
        </ul>
      </Sheet>
    </footer>
  );
}
