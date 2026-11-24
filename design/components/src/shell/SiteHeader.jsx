import { Icon } from "../core/Icon.jsx";
import { Logo } from "../core/Logo.jsx";
import { Avatar } from "../core/Avatar.jsx";
import { Button } from "../core/Button.jsx";

export function SiteHeader({
  current = "streamers",
  links = [{ id: "streamers", label: "Streamers", icon: "streamers", href: "/streamers" }],
  homeHref = "/",
  signedIn = true,
  avatarPreset = 1,
  onSignIn,
  onAccount,
  className = "",
}) {
  return (
    <header
      className={`sb-header ${className}`.trim()}
      style={{ gridTemplateColumns: "auto minmax(0,1fr) auto", minHeight: 76 }}
    >
      <a className="sb-header-brand" href={homeHref} aria-label="StreamBullets home">
        <Logo />
      </a>
      <nav aria-label="Main navigation">
        {links.map((l) => (
          <a
            key={l.id}
            className="sb-nav-link"
            href={l.href ?? `#${l.id}`}
            aria-current={current === l.id ? "page" : undefined}
          >
            {l.icon && <Icon name={l.icon} size={18} />}
            {l.label}
          </a>
        ))}
      </nav>
      <div className="sb-header-end">
        {signedIn ? (
          <button type="button" className="sb-profile" aria-label="Account menu" onClick={onAccount}>
            <Avatar preset={avatarPreset} size={40} />
          </button>
        ) : (
          <Button icon="sign-in" onClick={onSignIn}>
            Sign in
          </Button>
        )}
      </div>
    </header>
  );
}
