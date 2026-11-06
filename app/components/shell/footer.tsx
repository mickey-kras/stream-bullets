import { useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { t } from "../../i18n";
import { paths } from "../../lib/shell";
import { Icon } from "../ui/icon";
import { Sheet } from "../ui/sheet";
import { ContactDialog } from "./contact-dialog";

/**
 * The footer: legal links on the gold bottom band of the frame (42px desktop, 34px phones) in dark ink; the
 * landing page keeps its own dark strip. Phones show Privacy, Terms and More; More opens a sheet with the rest.
 * Later phases add Accessibility, Suggest an improvement, AI agents and the language switch here.
 */
export function SiteFooter(): ReactNode {
  const { pathname } = useLocation();
  const [dialog, setDialog] = useState<"contact" | "more" | null>(null);
  const current = (path: string): "page" | undefined => (pathname === path ? "page" : undefined);
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
              <Icon name="mail" size={18} />
              {t("footer.contact")}
            </button>
          </li>
          <li>
            <Link to={paths.reporting} onClick={() => setDialog(null)}>
              <Icon name="flag" size={18} />
              {t("footer.report")}
            </Link>
          </li>
          <li>
            <Link to={paths.streamers} onClick={() => setDialog(null)}>
              <Icon name="streamers" size={18} />
              {t("nav.streamers")}
            </Link>
          </li>
        </ul>
      </Sheet>
    </footer>
  );
}
