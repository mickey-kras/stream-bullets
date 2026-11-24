import { useState } from "react";
import { Icon } from "../core/Icon.jsx";
import { Sheet } from "../feedback/Sheet.jsx";

// Paths of app/lib/shell.ts. Dialog links add ?dialog= to the current page.
const PATHS = {
  streamers: "/streamers",
  privacy: "/privacy",
  terms: "/terms",
  reporting: "/terms#reporting",
  a11y: "?dialog=a11y",
  ideas: "/@streambullets?intent=suggest",
  ai: "/ai",
  language: "?dialog=language",
};

function MoreRow({ icon, children }) {
  return (
    <>
      <Icon name={icon} size={18} />
      {children}
    </>
  );
}

// The site footer (app/components/shell/footer.tsx). Wide screens show the full row; phones show icon links
// and a More sheet. The app CSS styles it as a direct child of <body>.
export function SiteFooter({ current, paths = {}, locale = "en", language = "English", onContact, className = "" }) {
  const [more, setMore] = useState(false);
  const to = { ...PATHS, ...paths };
  const here = (id) => (current === id ? "page" : undefined);
  const languageLabel = `Language: ${language}`;
  const close = () => setMore(false);
  return (
    <footer className={`site-footer ${className}`.trim()}>
      <nav aria-label="Footer" className="footer-full">
        <a href={to.streamers} aria-current={here("streamers")}>
          Streamers
        </a>
        <a href={to.privacy} aria-current={here("privacy")}>
          Privacy
        </a>
        <a href={to.terms} aria-current={here("terms")}>
          Terms
        </a>
        <button type="button" className="footer-link" aria-haspopup="dialog" onClick={onContact}>
          Contact
        </button>
        <a href={to.reporting}>Report content</a>
        <a href={to.a11y} aria-haspopup="dialog">
          Accessibility
        </a>
        <a href={to.ideas}>
          <Icon name="idea" size={16} />
          Suggest an improvement
        </a>
        <a href={to.ai} className="footer-muted" aria-current={here("ai")}>
          AI agents
        </a>
        <a href={to.language} aria-haspopup="dialog" className="lang-switch" aria-label={languageLabel}>
          <Icon name="globe" size={16} />
          <span lang={locale}>{language}</span>
        </a>
      </nav>
      <nav aria-label="Footer" className="footer-compact">
        <a href={to.privacy} aria-current={here("privacy")} aria-label="Privacy" title="Privacy">
          <Icon name="privacy" size={18} />
          <span className="footer-label">Privacy</span>
        </a>
        <a href={to.terms} aria-current={here("terms")} aria-label="Terms" title="Terms">
          <Icon name="terms" size={18} />
          <span className="footer-label">Terms</span>
        </a>
        <a href={to.a11y} aria-haspopup="dialog" aria-label="Accessibility">
          <Icon name="eye" size={18} />
        </a>
        <a href={to.language} aria-haspopup="dialog" aria-label={languageLabel}>
          <Icon name="globe" size={18} />
        </a>
        <button type="button" className="footer-link" aria-haspopup="dialog" onClick={() => setMore(true)}>
          More
          <Icon name="chevron-down" size={16} />
        </button>
      </nav>
      <Sheet open={more} onOpenChange={setMore} title="More" name="more" short>
        <ul className="more-list">
          <li>
            <button
              type="button"
              onClick={() => {
                close();
                onContact?.();
              }}
            >
              <MoreRow icon="mail">Contact</MoreRow>
            </button>
          </li>
          <li>
            <a href={to.reporting} onClick={close}>
              <MoreRow icon="flag">Report content</MoreRow>
            </a>
          </li>
          <li>
            <a href={to.a11y} aria-haspopup="dialog" onClick={close}>
              <MoreRow icon="eye">Accessibility</MoreRow>
            </a>
          </li>
          <li>
            <a href={to.language} aria-haspopup="dialog" onClick={close}>
              <MoreRow icon="globe">{languageLabel}</MoreRow>
            </a>
          </li>
          <li>
            <a href={to.ai} onClick={close}>
              <MoreRow icon="about">AI agents</MoreRow>
            </a>
          </li>
          <li>
            <a href={to.ideas} onClick={close}>
              <MoreRow icon="idea">Suggest an improvement</MoreRow>
            </a>
          </li>
          <li>
            <a href={to.streamers} onClick={close}>
              <MoreRow icon="streamers">Streamers</MoreRow>
            </a>
          </li>
        </ul>
      </Sheet>
    </footer>
  );
}
