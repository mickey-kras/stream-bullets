import { Icon } from "../core/Icon.jsx";
import { Logo } from "../core/Logo.jsx";
import { Avatar } from "../core/Avatar.jsx";
import { Button } from "../core/Button.jsx";
import { LivePill } from "../feedback/LivePill.jsx";

const VIEWS = [
  { id: "topics", label: "Topics", icon: "topics" },
  { id: "polls", label: "Polls", icon: "polls" },
  { id: "schedule", label: "Schedule", icon: "schedule" },
  { id: "about", label: "About", icon: "about" },
  { id: "community", label: "Community", icon: "community" },
];

export function StreamerHeader({
  name,
  preset = 14,
  current = "topics",
  hrefFor = (id) => `#${id}`,
  live = false,
  ticker,
  own = false,
  action,
  signedIn = true,
  avatarPreset = 1,
  onAccount,
  compact = false,
  className = "",
}) {
  const views = own ? [...VIEWS, { id: "overlay", label: "Overlay", icon: "overlay" }] : VIEWS;
  return (
    <header className={`sb-header ${className}`.trim()} data-compact={compact || undefined}>
      <div className="sb-header-brand">
        <a className="sb-mark" href={hrefFor("home")} aria-label="StreamBullets home">
          <Logo kind="icon" height={32} />
        </a>
        <span className="sb-divider" aria-hidden="true" />
        <a className="sb-streamer-home" href={hrefFor("topics")} aria-label={`${name} home`}>
          <Avatar preset={preset} size={compact ? 48 : 76} ring="cream" />
          <span className="sb-streamer-name">{name}</span>
        </a>
        {live && <LivePill />}
      </div>
      <nav aria-label="Main navigation">
        {views.map((v) => (
          <a
            key={v.id}
            className="sb-nav-tab"
            href={hrefFor(v.id)}
            title={v.label}
            aria-label={compact ? v.label : undefined}
            aria-current={current === v.id ? "page" : undefined}
          >
            <Icon name={v.icon} size={20} />
            <span className="sb-nav-label">{v.label}</span>
          </a>
        ))}
      </nav>
      <div className="sb-header-end">
        <a className="sb-streamers-link sb-hide-compact" href={hrefFor("streamers")}>
          <Icon name="streamers" size={20} />
          Streamers
        </a>
        {action !== undefined ? (
          action
        ) : (
          <Button variant="gold" font="display" size="lg" icon="plus" className="sb-hide-compact">
            Suggest a topic
          </Button>
        )}
        {signedIn ? (
          <button type="button" className="sb-profile" aria-label="Account menu" onClick={onAccount}>
            <Avatar preset={avatarPreset} size={40} />
          </button>
        ) : (
          <Button icon="sign-in">Sign in</Button>
        )}
      </div>
      {ticker && (
        <div className="sb-ticker">
          <strong>
            <span className="sb-live-dot" />
            On air
          </strong>
          <span>{ticker}</span>
        </div>
      )}
    </header>
  );
}
