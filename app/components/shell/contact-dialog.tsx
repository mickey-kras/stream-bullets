import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { t } from "../../i18n";
import { copyText } from "../../lib/clipboard";
import { contactEmails } from "../../legal";
import { paths } from "../../lib/shell";
import { Icon } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { Sheet } from "../ui/sheet";

/** Selects the address text so the person can copy it by hand when the clipboard is unavailable. */
function selectText(element: HTMLElement | null): void {
  if (!element) return;
  const range: Range = document.createRange();
  range.selectNodeContents(element);
  const selection: Selection | null = globalThis.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * "Contact us" (approved items 30 and 48): the support address as selectable text with a Copy button that falls
 * back to selecting it, an optional mailto link, and shortcuts to reporting and the legal pages.
 * The legal pages keep their own privacy@ address.
 */
export function ContactDialog({
  open,
  onOpenChange,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>): ReactNode {
  const address = useRef<HTMLSpanElement | null>(null);
  const [notice, setNotice] = useState<string>("");
  // Clear the notice when the dialog closes. React allows this state update during render.
  const [wasOpen, setWasOpen] = useState<boolean>(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setNotice("");
  }
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function copy(): Promise<void> {
    if (await copyText(contactEmails.support)) {
      setNotice(t("contact.copied"));
      return;
    }
    selectText(address.current);
    setNotice(t("contact.copyFallback"));
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("contact.title")} name="contact" short>
      {notice && <output className="dialog-notice">{notice}</output>}
      <p>{t("contact.body")}</p>
      <div className="contact-address">
        <span className="contact-email" ref={address}>
          {/* On a narrow screen the address breaks after the @, not inside the domain. */}
          {contactEmails.support.split("@")[0]}@<wbr />
          {contactEmails.support.split("@")[1]}
        </span>
        <IconButton
          label={t("contact.copy")}
          icon="copy"
          iconSize={18}
          onClick={() => {
            void copy();
          }}
        />
      </div>
      <p>
        <a className="text-link" href={`mailto:${contactEmails.support}`}>
          <Icon name="mail" size={16} />
          {t("contact.openEmail")}
        </a>{" "}
        <span className="muted">{t("contact.openEmailNote")}</span>
      </p>
      <nav className="contact-links" aria-label={t("contact.moreHelp")}>
        <Link className="button-link" to={paths.reporting} onClick={() => onOpenChange(false)}>
          <Icon name="flag" size={18} />
          {t("footer.report")}
        </Link>
        <Link className="button-link" to={paths.privacy} onClick={() => onOpenChange(false)}>
          <Icon name="privacy" size={18} />
          {t("legal.privacyPolicy")}
        </Link>
        <Link className="button-link" to={paths.terms} onClick={() => onOpenChange(false)}>
          <Icon name="terms" size={18} />
          {t("legal.terms")}
        </Link>
      </nav>
    </Sheet>
  );
}
