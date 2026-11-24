import React from "react";
import { Icon } from "../core/Icon.jsx";

const LINKS = ["Privacy", "Terms", "Accessibility", "Contact", "Report content", "AI agents"];

export function SiteFooter({ links = LINKS, language = "English", onLanguage, className = "" }) {
  return (
    <footer className={`sb-footer ${className}`.trim()}>
      <nav aria-label="Footer">
        <span className="sb-sep">© StreamBullets</span>
        {links.map((l) => <a key={l} href="#">{l}</a>)}
        <button type="button" onClick={onLanguage}><Icon name="globe" size={16} />{language}</button>
      </nav>
    </footer>
  );
}
