import { useRef, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { t } from "../../i18n";
import { paths, useShell, type ShellData } from "../../lib/shell";
import { Icon } from "../ui/icon";
import { AccountMenu } from "./account-menu";
import { useFitHeader } from "./fit-header";

// Home link uses the wordmark, or icon on phones.
export function SiteLogo(): ReactNode {
  return (
    <Link className="brand site-logo" to={paths.home} aria-label={t("nav.home")}>
      <img className="logo-full" src="/assets/stream-bullets.svg" alt="" width="305" height="84" />
      <img className="logo-icon" src="/assets/stream-bullets-icon.svg" alt="" width="128" height="136" />
    </Link>
  );
}

// Shared header with active route, role-specific links and account control.
export function SiteHeader(): ReactNode {
  const shell: ShellData = useShell();
  const { pathname } = useLocation();
  const header = useRef<HTMLElement | null>(null);
  useFitHeader(header);
  const current = (path: string): "page" | undefined => (pathname === path ? "page" : undefined);
  return (
    <header className="site-header generic-header" ref={header}>
      <SiteLogo />
      <nav aria-label={t("nav.main")}>
        <Link to={paths.streamers} aria-current={current(paths.streamers)}>
          <Icon name="streamers" size={18} />
          {t("nav.streamers")}
        </Link>
        {shell.ownStreamer && (
          <Link className="nav-optional" to={paths.streamer(shell.ownStreamer.handle)}>
            <Icon name="your-page" size={18} />
            {t("nav.yourPage")}
          </Link>
        )}
        {shell.admin && (
          <Link to={paths.admin} aria-current={pathname.startsWith(paths.admin) ? "page" : undefined}>
            <Icon name="admin" size={18} />
            {t("nav.admin")}
          </Link>
        )}
      </nav>
      <div className="header-end">
        <AccountMenu />
      </div>
    </header>
  );
}
