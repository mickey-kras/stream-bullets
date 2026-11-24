import { useRef } from "react";
import { useFitHeader } from "../../../../app/components/shell/fit-header.ts";
import { Icon } from "../core/Icon.jsx";
import { Logo } from "../core/Logo.jsx";
import { AccountMenu, SignInButton } from "./AccountMenu.jsx";

// The home link: the wordmark, or the mark on phones (app/components/shell/site-header.tsx).
export function SiteLogo({ href = "/", label = "StreamBullets home" }) {
  return <Logo kind="site" href={href} label={label} />;
}

// The globe button with the code of the current language, in both headers (header-language.tsx).
// It opens the language dialog. Its name gives the full language name.
export function HeaderLanguage({ locale = "en", name = "English", onClick }) {
  const label = `Language: ${name}`;
  return (
    <button
      type="button"
      className="header-language"
      aria-haspopup="dialog"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon name="globe" size={20} />
      <span className="header-language-code" aria-hidden="true">
        {locale.split("-")[0].toUpperCase()}
      </span>
    </button>
  );
}

// The header end of both headers: language, then notifications and the avatar menu, or Sign in.
export function HeaderAccount({
  signedIn,
  account,
  avatarPreset,
  onAccount,
  onSignIn,
  locale,
  languageName,
  onLanguage,
  streamerHeader,
}) {
  return (
    <>
      <HeaderLanguage locale={locale} name={languageName} onClick={onLanguage} />
      {signedIn ? (
        <AccountMenu
          preset={avatarPreset}
          streamerHeader={streamerHeader}
          {...account}
          onOpenChange={(open) => {
            account?.onOpenChange?.(open);
            onAccount?.(open);
          }}
        />
      ) : (
        <SignInButton onClick={onSignIn} />
      )}
    </>
  );
}

const STREAMERS = { id: "streamers", label: "Streamers", icon: "streamers", href: "/streamers" };

// The header of directory, legal, account and error pages. Links with `optional` hide on phones.
// When the tabs do not fit in one row, useFitHeader (the app hook) moves them to a second row.
export function SiteHeader({
  current = "streamers",
  links = [STREAMERS],
  homeHref = "/",
  signedIn = true,
  avatarPreset = 14,
  account,
  onSignIn,
  onAccount,
  locale = "en",
  languageName = "English",
  onLanguage,
  className = "",
}) {
  const header = useRef(null);
  useFitHeader(header);
  return (
    <header className={`site-header generic-header ${className}`.trim()} ref={header}>
      <SiteLogo href={homeHref} />
      <nav aria-label="Main navigation">
        {links.map((link) => (
          <a
            key={link.id}
            className={link.optional ? "nav-optional" : undefined}
            href={link.href}
            aria-current={current === link.id ? "page" : undefined}
          >
            {link.icon && <Icon name={link.icon} size={18} />}
            {link.label}
          </a>
        ))}
      </nav>
      <div className="header-end">
        <HeaderAccount
          signedIn={signedIn}
          account={account}
          avatarPreset={avatarPreset}
          onAccount={onAccount}
          onSignIn={onSignIn}
          locale={locale}
          languageName={languageName}
          onLanguage={onLanguage}
        />
      </div>
    </header>
  );
}
