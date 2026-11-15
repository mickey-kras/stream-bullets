import { useRef, type ReactNode } from "react";
import { Link } from "react-router";
import { t, type MessageId } from "../../i18n";
import { paths } from "../../lib/shell";
import { StreamerLogo } from "../ui/avatar";
import { Icon, type IconName } from "../ui/icon";
import { AccountMenu } from "./account-menu";
import { useFitHeader } from "./fit-header";

export type StreamerView = "topics" | "polls" | "schedule" | "about" | "community";

export const streamerViews: readonly StreamerView[] = ["topics", "polls", "schedule", "about", "community"];

const viewIcon: Record<StreamerView, IconName> = {
  topics: "topics",
  polls: "polls",
  schedule: "schedule",
  about: "about",
  community: "community",
};
const viewLabel: Record<StreamerView, MessageId> = {
  topics: "streamer.nav.topics",
  polls: "streamer.nav.polls",
  schedule: "streamer.nav.schedule",
  about: "streamer.nav.about",
  community: "streamer.nav.community",
};

// Header: home/streamer identity, active tab links, page action and account. Phones use two rows without
// label wrapping.
export function StreamerHeader({
  streamer,
  current,
  action,
  tabHref = (view: StreamerView): string => `?view=${view}`,
  views = streamerViews,
  labels = {},
  icons = {},
  brand,
  badge,
  className = "",
}: Readonly<{
  streamer: {
    handle: string;
    name: string;
    avatar: string | null;
    logo?: string | null;
    ownerAvatarPreset?: number | null;
  };
  current: StreamerView | null;
  action?: ReactNode;
  tabHref?: (view: StreamerView) => string;
  views?: readonly StreamerView[];
  labels?: Partial<Record<StreamerView, string>>;
  icons?: Partial<Record<StreamerView, IconName>>;
  brand?: ReactNode;
  badge?: ReactNode;
  className?: string;
}>): ReactNode {
  const header = useRef<HTMLElement | null>(null);
  useFitHeader(header);
  return (
    <header className={`site-header streamer-header ${className}`.trim()} ref={header}>
      <div className="brand streamer-brand">
        <Link className="sb-mark" to={paths.home} aria-label={t("nav.home")}>
          <img src="/assets/stream-bullets-icon.svg" alt="" width="128" height="136" />
        </Link>
        <span className="brand-divider" aria-hidden="true" />
        <Link
          className="streamer-home"
          to={paths.streamer(streamer.handle)}
          aria-label={
            streamer.handle === "streambullets" ? t("ideas.heading") : t("streamer.home", { name: streamer.name })
          }
        >
          {brand ?? (
            <>
              <StreamerLogo className="brand-avatar" streamer={streamer} />
              <span className="streamer-name" aria-hidden="true">
                {streamer.name}
              </span>
            </>
          )}
        </Link>
        {badge}
      </div>
      <nav aria-label={t("nav.main")}>
        {views.map((view: StreamerView) => (
          <Link key={view} className="nav-tab" to={tabHref(view)} aria-current={current === view ? "page" : undefined}>
            <Icon name={icons[view] ?? viewIcon[view]} size={20} />
            <span className="nav-label">{labels[view] ?? t(viewLabel[view])}</span>
            <span className="compact-nav-label">{labels[view] ?? t(viewLabel[view])}</span>
          </Link>
        ))}
      </nav>
      <div className="header-end">
        <Link className="header-streamers" to={paths.streamers} aria-label={t("nav.streamers")}>
          <Icon name="streamers" size={20} />
          <span className="hs-label" aria-hidden="true">
            {t("nav.streamers")}
          </span>
        </Link>
        {action}
        <AccountMenu streamerHeader />
      </div>
    </header>
  );
}
