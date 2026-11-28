import { memo, useState, type CSSProperties, type ReactNode } from "react";
import { t } from "../../i18n";
import type { ActivityPlatform } from "../../lib/activity";
import { SAMPLE_ALERT, alertFace, type AlertFace } from "../../lib/alert-feed";
import { alertShownOn, type AlertKind, type AlertView } from "../../lib/alerts";
import { supportText } from "../../lib/support-line";
import { Icon, type IconName } from "../ui/icon";
import type { ActivityFeed } from "./activity-feed";
import { FitStage } from "./fit-stage";
import { useAlerts, type AlertsView } from "./use-alerts";
import { useMotionReduced } from "./use-motion-reduced";
import { PLATFORM_NAMES } from "./wasteland/theme";

/** The fade of a banner that goes, in milliseconds (`ov-alert-out` in wasteland.css). */
export const ALERT_LEAVE_MS = 300;

/** The icon of each kind. It is decoration: the line tells what the alert is. */
export const ALERT_ICONS: Readonly<Record<AlertKind, IconName>> = {
  follow: "heart",
  subscription: "star",
  membership: "star",
  gift: "gift",
  raid: "live",
  bits: "zap",
  kicks: "zap",
  super_chat: "megaphone",
  super_sticker: "megaphone",
  topic: "topics",
};

/**
 * Who an alert is from, as the banner and the mark in chat show it. An anonymous alert shows the word for
 * "Anonymous" and never a name. An alert without a name shows the same word: the platform did not give one.
 */
export function alertWho(alert: Pick<AlertFace, "name" | "anonymous">): string {
  return alert.anonymous || !alert.name ? t("overlay.alerts.anonymous") : alert.name;
}

/** The line below the title: the platform and the thanks. A topic credit is not from a platform. */
function alertMeta(alert: Pick<AlertFace, "platform">): string {
  const thanks: string = t("overlay.alerts.thanks");
  return alert.platform === "direct" ? thanks : `${PLATFORM_NAMES[alert.platform]} · ${thanks}`;
}

/**
 * The banner of one alert: who and what with the amount, and the platform. The text of the supporter is not a prop:
 * it never shows on stream. A test has a small TEST mark, and a replay looks as a live alert does.
 *
 * `showMs` is how long the banner shows from its first render: its fade starts ALERT_LEAVE_MS before that end.
 * Without it the banner has no end (the sample of the editor). With `still` (reduced motion) the banner appears and
 * goes with no transition. The name is untrusted text: it renders as text, in its own direction.
 */
export function AlertBanner({
  alert,
  showMs,
  still = false,
}: Readonly<{ alert: AlertFace; showMs?: number; still?: boolean }>): ReactNode {
  // The time of the first render: a later change of the clock offset must not start the fade again.
  const [shown] = useState<number | undefined>(showMs);
  const leaves: boolean = !still && shown !== undefined;
  const style: CSSProperties | undefined = leaves
    ? ({ "--ov-alert-out": `${Math.max(0, (shown ?? 0) - ALERT_LEAVE_MS)}ms` } as CSSProperties)
    : undefined;
  return (
    <article
      className="ov-card ov-alert"
      data-overlay-alert={alert.kind}
      data-alert-origin={alert.origin}
      data-platform={alert.platform}
      data-still={still || undefined}
      data-leaves={leaves || undefined}
      style={style}
    >
      <Icon name={ALERT_ICONS[alert.kind]} size={40} className="ov-alert-icon" />
      <div className="ov-alert-text">
        <h1 data-alert-title>
          <bdi>{alertWho(alert)}</bdi> {supportText(alert)}
        </h1>
        <p className="ov-meta" data-alert-meta>
          {alertMeta(alert)}
        </p>
      </div>
      {alert.origin === "test" && (
        <span className="wl-test" data-alert-test>
          {t("overlay.alerts.test")}
        </span>
      )}
    </article>
  );
}

/**
 * The alert that the banner of an output shows, or null: the alert on stream when its rule has the banner on and
 * the output shows it. An output that shows only `platform` shows the alerts of that platform and each topic credit
 * (`alertShownOn`).
 */
export function bannerAlert(current: AlertView | null, platform: ActivityPlatform | null): AlertFace | null {
  return current?.banner && alertShownOn(current, platform) ? alertFace(current) : null;
}

/**
 * The alerts layer: the banner of the alert on stream, in the cell of the layer, for the time of the alert. Between
 * alerts the layer is empty. `sample` shows a sample banner with no end: the editor preview, which reads no feed.
 * Memoised, so a page re-render (like the 1 s server clock tick) does not re-render the banner.
 */
export const AlertsLayer = memo(function AlertsLayer({
  feed,
  serverOffset = 0,
  platform = null,
  sample = false,
}: Readonly<{
  /** The activity feed of the page, or null for none. */
  feed: ActivityFeed | null;
  /** Server time minus local time. */
  serverOffset?: number;
  /** The one platform whose alerts the output shows, or null for all platforms. */
  platform?: ActivityPlatform | null;
  sample?: boolean;
}>): ReactNode {
  const alerts: AlertsView = useAlerts(feed, serverOffset);
  const still: boolean = useMotionReduced();
  const shown: AlertFace | null = bannerAlert(alerts.current, platform);
  if (sample)
    return (
      <FitStage type="alerts">
        <AlertBanner alert={SAMPLE_ALERT} still />
      </FitStage>
    );
  return (
    <FitStage type="alerts">
      {/* The key is the play of the alert: the next alert is a new banner with its own time. */}
      {shown && <AlertBanner key={shown.id} alert={shown} showMs={alerts.showMs} still={still} />}
    </FitStage>
  );
});
