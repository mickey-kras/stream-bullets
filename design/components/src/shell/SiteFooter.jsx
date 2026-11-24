import { Icon } from "../core/Icon.jsx";

// Paths from app/lib/shell.ts.
const LINKS = [
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
  { label: "Report content", href: "/terms#reporting" },
  { label: "AI agents", href: "/ai" },
];

export function SiteFooter({ links = LINKS, language = "English", onLanguage, className = "" }) {
  return (
    <footer className={`sb-footer ${className}`.trim()}>
      <nav aria-label="Footer">
        <span className="sb-sep">© StreamBullets</span>
        {links.map((l) => (
          <a key={l.href} href={l.href}>
            {l.label}
          </a>
        ))}
        <button type="button" onClick={onLanguage}>
          <Icon name="globe" size={16} />
          {language}
        </button>
      </nav>
    </footer>
  );
}
