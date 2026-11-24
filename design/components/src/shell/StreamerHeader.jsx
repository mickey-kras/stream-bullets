import { useRef } from "react";
import { useFitHeader } from "../../../../app/components/shell/fit-header.ts";
import { StreamerLogo } from "../core/Avatar.jsx";
import { Icon } from "../core/Icon.jsx";
import { Logo } from "../core/Logo.jsx";
import { LivePill, OnAirTicker } from "../feedback/LivePill.jsx";
import { HeaderAccount } from "./SiteHeader.jsx";

const VIEWS = ["topics", "polls", "schedule", "about", "community"];
const LABELS = { topics: "Topics", polls: "Polls", schedule: "Schedule", about: "About", community: "Community" };

// The paths of app/lib/shell.ts for a streamer handle.
export function streamerHref(handle) {
  return (id) => {
    if (id === "home") return "/";
    if (id === "streamers") return "/streamers";
    if (id === "overlay") return "/overlay-control";
    if (id === "page") return `/@${handle}`;
    return `/@${handle}?view=${id}`;
  };
}

// The gold header action of the official StreamBullets page ("Suggest an improvement").
export function HeaderSuggestButton({ label = "Suggest an improvement", disabled = false, onClick }) {
  return (
    <button className="gold" id="suggest" type="button" aria-label={label} disabled={disabled} onClick={onClick}>
      <span className="suggest-plus" aria-hidden="true">
        <Icon name="plus" size={18} />
      </span>
      <span className="suggest-label">{label}</span>
    </button>
  );
}

// The header of a streamer page (app/components/shell/streamer-header.tsx): SB mark, divider, streamer
// picture and name, icon tabs, the Streamers link, the language button and the account controls.
export function StreamerHeader({
  name = "Sunny",
  handle = "sunny",
  preset = 14,
  avatar,
  logo,
  current = "topics",
  views = VIEWS,
  labels = {},
  icons = {},
  hrefFor,
  brand,
  live = false,
  liveTitle,
  badge,
  ticker,
  own = false,
  action = null,
  signedIn = true,
  avatarPreset = 14,
  account,
  onAccount,
  onSignIn,
  locale = "en",
  languageName = "English",
  onLanguage,
  className = "",
}) {
  const header = useRef(null);
  useFitHeader(header);
  const href = hrefFor ?? streamerHref(handle);
  const label = (view) => labels[view] ?? LABELS[view];
  const strip = typeof ticker === "string" ? <OnAirTicker title={ticker} href={href("schedule")} /> : ticker;
  return (
    <header className={`site-header streamer-header ${className}`.trim()} ref={header}>
      <div className="brand streamer-brand">
        <a className="sb-mark" href={href("home")} aria-label="StreamBullets home">
          <Logo kind="icon" />
        </a>
        <span className="brand-divider" aria-hidden="true" />
        <a className="streamer-home" href={href("page")} aria-label={`${name} home`}>
          {brand ?? (
            <>
              <StreamerLogo className="brand-avatar" logo={logo} avatar={avatar} ownerAvatarPreset={preset} />
              <span className="streamer-name" aria-hidden="true">
                {name}
              </span>
            </>
          )}
        </a>
        {badge ?? (live && <LivePill title={liveTitle} href={href("schedule")} />)}
      </div>
      <nav aria-label="Main navigation">
        {views.map((view) => (
          <a
            key={view}
            className="nav-tab"
            href={href(view)}
            aria-label={label(view)}
            title={label(view)}
            aria-current={current === view ? "page" : undefined}
          >
            <Icon name={icons[view] ?? view} size={20} />
            <span className="nav-label">{label(view)}</span>
          </a>
        ))}
        {own && (
          <a
            className="nav-tab"
            href={href("overlay")}
            aria-label="Overlay"
            title="Overlay"
            aria-current={current === "overlay" ? "page" : undefined}
          >
            <Icon name="overlay" size={20} />
            <span className="nav-label">Overlay</span>
          </a>
        )}
      </nav>
      <div className="header-end">
        <a className="header-streamers" href={href("streamers")} aria-label="Streamers">
          <Icon name="streamers" size={20} />
          <span className="hs-label" aria-hidden="true">
            Streamers
          </span>
        </a>
        {action}
        <HeaderAccount
          streamerHeader
          signedIn={signedIn}
          account={{ handle: own ? handle : undefined, name: own ? name : undefined, ...account }}
          avatarPreset={own ? preset : avatarPreset}
          onAccount={onAccount}
          onSignIn={onSignIn}
          locale={locale}
          languageName={languageName}
          onLanguage={onLanguage}
        />
      </div>
      {strip && <div className="onair-ticker">{strip}</div>}
    </header>
  );
}
