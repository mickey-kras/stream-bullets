import type { ReactNode } from "react";
import { getLocale, t } from "../i18n";
import { type LegalDetails, legalPlaceholdersRemain } from "../legal";
import { BackLink } from "./shell/back-link";
import { SiteHeader } from "./shell/site-header";
import { Dialog } from "./ui/dialog";
import { Icon, type IconName } from "./ui/icon";

// Compatibility exports. New imports use ./ui and ./shell directly.
export { Avatar } from "./ui/avatar";
export { SignIn, SignInDialog } from "./shell/sign-in-dialog";
export { SiteHeader } from "./shell/site-header";
export { SiteFooter } from "./shell/footer";
export type { Provider } from "../lib/shell";

// Legacy dialog. New code uses Dialog from ./ui/dialog.
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}>): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description}>
      {children}
    </Dialog>
  );
}

// Place the optional action below the empty-state text.
export function EmptyState({
  title,
  icon,
  children,
  action,
}: Readonly<{ title: string; icon?: IconName; children?: ReactNode; action?: ReactNode }>): ReactNode {
  return (
    <div className={action ? "empty-state has-cta" : "empty-state"}>
      {icon && <Icon name={icon} size={40} />}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action && <p className="empty-cta">{action}</p>}
    </div>
  );
}

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

// Shared privacy/terms layout.
export function LegalDocument({
  title,
  summary,
  sections,
  legal,
}: Readonly<{ title: string; summary: ReactNode; sections: readonly LegalSection[]; legal: LegalDetails }>): ReactNode {
  return (
    <>
      <SiteHeader />
      <main className="page-panel legal-page" id="main-content">
        <article aria-labelledby="legal-title">
          <BackLink />
          {getLocale() !== "en" && (
            <p className="legal-draft legal-translation" role="note">
              <Icon name="globe" size={18} />
              <span>{t("legal.englishOnly")}</span>
            </p>
          )}
          {legalPlaceholdersRemain(legal) && (
            <p className="legal-draft" role="note" lang="en">
              <strong>Draft — operator details pending.</strong> Values in square brackets are placeholders. This text
              is not final until the operator replaces them.
            </p>
          )}
          <span className="eyebrow">StreamBullets</span>
          <h1 id="legal-title" lang="en">
            {title}
          </h1>
          <p className="legal-meta" lang="en">
            Effective date: {legal.policyEffectiveDate}
          </p>
          <div className="legal-summary" lang="en">
            {summary}
          </div>
          <nav className="info-card legal-toc" aria-labelledby="legal-toc-title">
            <h2 id="legal-toc-title">{t("legal.contents")}</h2>
            <ol lang="en">
              {sections.map((section: LegalSection) => (
                <li key={section.id}>
                  <a href={`#${section.id}`}>{section.title}</a>
                </li>
              ))}
            </ol>
          </nav>
          {sections.map((section: LegalSection, index: number) => (
            <section
              key={section.id}
              id={section.id}
              className="legal-section"
              lang="en"
              aria-labelledby={`${section.id}-title`}
            >
              <h2 id={`${section.id}-title`}>
                {index + 1}. {section.title}
              </h2>
              {section.body}
            </section>
          ))}
        </article>
      </main>
    </>
  );
}
