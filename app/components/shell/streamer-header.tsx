import { useRef, type ComponentProps, type ReactNode } from "react";
import { Link } from "react-router";
import { t, type MessageId } from "../../i18n";
import { paths, useShell } from "../../lib/shell";
import { StreamerLogo } from "../ui/avatar";
import { Icon, type IconName } from "../ui/icon";
import { AccountMenu } from "./account-menu";
import { useFitHeader } from "./fit-header";
import { HeaderLanguage } from "./header-language";

export type StreamerView = "topics" | "polls" | "schedule" | "about" | "community";

export const streamerViews: readonly StreamerView[] = ["topics", "polls", "schedule", "about", "community"];
/** The tabs of the official StreamBullets page. */
export const officialViews: readonly StreamerView[] = ["topics", "about", "community"];

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

// Narrow headers use icon tabs with accessible names. The owner of the page also gets the Overlay entry.
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
  ticker,
  overlayCurrent = false,
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
  // Full-width on-air strip rendered below the header bar while a stream is live.
  ticker?: ReactNode;
  /** Overlay control is the current page: its tab is marked and the other tabs lead to the streamer page. */
  overlayCurrent?: boolean;
  className?: string;
}>): ReactNode {
  const header = useRef<HTMLElement | null>(null);
  useFitHeader(header);
  const ownPage: boolean = useShell().ownStreamer?.handle === streamer.handle;
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
          <Link
            key={view}
            className="nav-tab"
            to={tabHref(view)}
            aria-label={labels[view] ?? t(viewLabel[view])}
            title={labels[view] ?? t(viewLabel[view])}
            aria-current={current === view ? "page" : undefined}
          >
            <Icon name={icons[view] ?? viewIcon[view]} size={20} />
            <span className="nav-label">{labels[view] ?? t(viewLabel[view])}</span>
          </Link>
        ))}
        {ownPage && (
          <Link
            className="nav-tab"
            to={paths.overlayControl}
            aria-label={t("nav.overlay")}
            title={t("nav.overlay")}
            aria-current={overlayCurrent ? "page" : undefined}
          >
            <Icon name="overlay" size={20} />
            <span className="nav-label">{t("nav.overlay")}</span>
          </Link>
        )}
      </nav>
      <div className="header-end">
        <Link className="header-streamers" to={paths.streamers} aria-label={t("nav.streamers")}>
          <Icon name="streamers" size={20} />
          <span className="hs-label" aria-hidden="true">
            {t("nav.streamers")}
          </span>
        </Link>
        {action}
        <HeaderLanguage />
        <AccountMenu streamerHeader />
      </div>
      {ticker && <div className="onair-ticker">{ticker}</div>}
    </header>
  );
}

/** The header look of a streamer page: the official StreamBullets page has its own tabs, labels and brand. */
export function streamerHeaderAppearance(
  streamer: Readonly<{ name: string; isOfficial: boolean }>,
): Pick<ComponentProps<typeof StreamerHeader>, "className" | "views" | "labels" | "icons" | "brand"> {
  if (!streamer.isOfficial) return { className: "", views: streamerViews, labels: {}, icons: {} };
  return {
    className: "ideas-header",
    views: officialViews,
    labels: { topics: t("ideas.tab"), about: t("ideas.aboutTab"), community: t("ideas.howEyebrow") },
    icons: { topics: "idea" },
    brand: (
      <>
        <span className="ideas-logo" aria-hidden="true">
          <img src="/assets/stream-bullets-icon.svg" alt="" width="128" height="136" />
        </span>
        <span className="streamer-name-wrap">
          <span className="streamer-name">{streamer.name}</span>
          <span className="ideas-sub">{t("ideas.subtitle")}</span>
        </span>
      </>
    ),
  };
}
