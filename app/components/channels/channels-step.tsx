import { useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { channelHealth, healthChanges, type ChannelView, type HealthChange } from "../../lib/channel-health";
import type { Provider } from "../../types";
import { announce } from "../a11y/announcer";
import { StepHeading } from "../overlay/step-heading";
import { useToast } from "../ui/toast";
import { ChannelPanel, PLATFORM_NAMES, channelProblem } from "./channel-panel";

function names(channels: readonly ChannelView[]): string {
  return channels.map((channel: ChannelView): string => PLATFORM_NAMES[channel.platform]).join(", ");
}

/** A connection that the owner can repair here: the platform is offered and its status is not healthy. */
function needsAttention(channel: ChannelView): boolean {
  return channelHealth(channel) === "attention";
}

/** The status line of the section: the connected platforms, then those that need attention. */
export function channelsSummary(channels: readonly ChannelView[]): string {
  const connected: ChannelView[] = channels.filter((channel: ChannelView): boolean => channel.connection !== null);
  if (connected.length === 0) return t("channels.summary.none");
  const attention: ChannelView[] = connected.filter(needsAttention);
  const healthy: ChannelView[] = connected.filter((channel: ChannelView): boolean => !needsAttention(channel));
  const parts: string[] = [];
  if (healthy.length > 0) parts.push(t("channels.summary.connected", { platforms: names(healthy) }));
  if (attention.length > 0) parts.push(t("channels.summary.attention", { platforms: names(attention) }));
  return parts.join(" · ");
}

/**
 * Whether the section starts open. It starts closed only when a channel is connected and nothing needs the owner:
 * no callback result to read and no connection to repair.
 */
export function channelsStartOpen(channels: readonly ChannelView[], result: string | null): boolean {
  return result !== null || channels.some(needsAttention) || channels.every((channel) => channel.connection === null);
}

/**
 * What the owner hears when the health of connected platforms changes: one message for all changes, or null
 * for none. `urgent` is false for a recovery and for a used-up quota, which is a known state.
 */
export function healthNews(changes: readonly HealthChange[]): { message: string; urgent: boolean } | null {
  if (changes.length === 0) return null;
  const parts: string[] = changes.map(({ channel, to }: HealthChange): string => {
    const platform: string = PLATFORM_NAMES[channel.platform];
    if (to === "healthy") return t("channels.news.back", { platform });
    return t("channels.news.problem", { platform, problem: channelProblem(channel) ?? "" });
  });
  const urgent: boolean = changes.some(
    ({ channel, to }: HealthChange): boolean => to === "attention" && channel.connection?.code !== "quota_exhausted",
  );
  return { message: parts.join(" "), urgent };
}

/**
 * Step 1 of Overlay control: the channel connections. The status line is a native disclosure for the full panel.
 * The heading stays outside it, so it is always a heading and the panel can move focus to it.
 */
export function ChannelsStep({
  channels,
  stale = false,
  providers,
  signInProvider,
  result,
}: Readonly<{
  /** The live list: it changes while the page is open (use-live-channels.ts). */
  channels: ChannelView[];
  stale?: boolean;
  providers: Provider[];
  signInProvider: Provider | null;
  result: string | null;
}>): ReactNode {
  // Set once: the callback result leaves the address after the first render, and the owner's choice must stay.
  const [open, setOpen] = useState<boolean>((): boolean => channelsStartOpen(channels, result));
  const details = useRef<HTMLDetailsElement | null>(null);
  const toast = useToast();
  const shown = useRef<readonly ChannelView[]>(channels);
  // A platform stopped or works again since the last list: say it once. A new problem also opens the panel.
  // A recovery does not close it. The first list is no news.
  useEffect((): void => {
    const changes: HealthChange[] = healthChanges(shown.current, channels);
    shown.current = channels;
    const news = healthNews(changes);
    if (!news) return;
    if (details.current && changes.some((change: HealthChange): boolean => change.to === "attention"))
      details.current.open = true;
    toast(news.message, { tone: news.urgent ? "error" : "status" });
    announce(news.message, { assertive: news.urgent });
  }, [channels, toast]);
  // The "Connect channels" links of the page go to the heading: open the panel for them. A click on a link whose
  // fragment is already in the address makes no hashchange event, and neither does a load with the fragment.
  useEffect((): (() => void) => {
    const reveal = (): void => {
      if (details.current) details.current.open = true;
    };
    const fragment = (): void => {
      if (globalThis.location.hash === "#channels-title") reveal();
    };
    const link = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest('a[href="#channels-title"]')) reveal();
    };
    fragment();
    globalThis.addEventListener("hashchange", fragment);
    document.addEventListener("click", link);
    return (): void => {
      globalThis.removeEventListener("hashchange", fragment);
      document.removeEventListener("click", link);
    };
  }, []);
  return (
    <section className="ov-step" aria-labelledby="channels-title" data-step="channels">
      <StepHeading step={1} id="channels-title" title={t("overlay.step.channels")} focusable />
      <details className="ch-details" ref={details} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary data-channels-summary>{channelsSummary(channels)}</summary>
        <ChannelPanel
          channels={channels}
          stale={stale}
          providers={providers}
          signInProvider={signInProvider}
          result={result}
        />
      </details>
    </section>
  );
}
