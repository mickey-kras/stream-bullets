import type { ReactNode } from "react";
import { t } from "../i18n";
import { legal, legalPlaceholdersRemain } from "../legal";
import { BackLink } from "./shell/back-link";
import { SiteHeader } from "./shell/site-header";
import { Dialog } from "./ui/dialog";
import { Icon, type IconName } from "./ui/icon";

/* Shared pieces now live in ./ui (primitives) and ./shell (headers, menu, footer). These re-exports keep the
   existing imports working; new code imports from ./ui and ./shell directly. */
export { Avatar } from "./ui/avatar";
export { SignIn, SignInDialog } from "./shell/sign-in-dialog";
export { SiteHeader } from "./shell/site-header";
export { SiteFooter } from "./shell/footer";
export type { Provider } from "../lib/shell";

/** A plain dialog with a title, a description and free-form content. New code uses <Dialog> from ./ui/dialog. */
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

/** An empty list or page. `action` (a button or link) sits inside the panel, under the text. */
export function EmptyState({
  title,
  icon,
  children,
  action,
}: Readonly<{ title: string; icon?: IconName; children: ReactNode; action?: ReactNode }>): ReactNode {
  return (
    <div className={action ? "empty-state has-cta" : "empty-state"}>
      {icon && <Icon name={icon} size={40} />}
      <h2>{title}</h2>
      <p>{children}</p>
      {action && <p className="empty-cta">{action}</p>}
    </div>
  );
}

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

/** Shared layout for the privacy policy and terms: header, back link, draft notice, contents, and sections. */
export function LegalDocument({
  title,
  summary,
  sections,
}: Readonly<{ title: string; summary: ReactNode; sections: readonly LegalSection[] }>): ReactNode {
  return (
    <>
      <SiteHeader />
      <main className="page-panel legal-page" id="main-content">
        <article aria-labelledby="legal-title">
          <BackLink />
          {legalPlaceholdersRemain && (
            <p className="legal-draft" role="note">
              <strong>Draft — operator details pending.</strong> Values in square brackets are placeholders. This text
              is not final until the operator replaces them.
            </p>
          )}
          <span className="eyebrow">StreamBullets</span>
          <h1 id="legal-title">{title}</h1>
          <p className="legal-meta">Effective date: {legal.policyEffectiveDate}</p>
          <div className="legal-summary">{summary}</div>
          <nav className="info-card legal-toc" aria-labelledby="legal-toc-title">
            <h2 id="legal-toc-title">{t("legal.contents")}</h2>
            <ol>
              {sections.map((section: LegalSection) => (
                <li key={section.id}>
                  <a href={`#${section.id}`}>{section.title}</a>
                </li>
              ))}
            </ol>
          </nav>
          {sections.map((section: LegalSection, index: number) => (
            <section key={section.id} id={section.id} className="legal-section" aria-labelledby={`${section.id}-title`}>
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
