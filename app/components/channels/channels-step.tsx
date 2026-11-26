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
 * Says once that a platform stopped or works again since the last list, in each section of Streamer tools. The
 * first list is no news.
 */
export function useChannelNews(channels: readonly ChannelView[]): void {
  const toast = useToast();
  const shown = useRef<readonly ChannelView[]>(channels);
  useEffect((): void => {
    const news = healthNews(healthChanges(shown.current, channels));
    shown.current = channels;
    if (!news) return;
    toast(news.message, { tone: news.urgent ? "error" : "status" });
    announce(news.message, { assertive: news.urgent });
  }, [channels, toast]);
}

/**
 * The Channels section of Streamer tools: the channel connections. The status line is a native disclosure for the full panel.
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
  const shown = useRef<readonly ChannelView[]>(channels);
  // A new problem since the last list opens the panel. A recovery does not close it. The page says the news
  // (useChannelNews).
  useEffect((): void => {
    const changes: HealthChange[] = healthChanges(shown.current, channels);
    shown.current = channels;
    if (details.current && changes.some((change: HealthChange): boolean => change.to === "attention"))
      details.current.open = true;
  }, [channels]);
  // The "Connect channels" links of the Overlay section open this section at the heading: open the panel for them.
  useEffect((): (() => void) => {
    const fragment = (): void => {
      if (globalThis.location.hash === "#channels-title" && details.current) details.current.open = true;
    };
    fragment();
    globalThis.addEventListener("hashchange", fragment);
    return (): void => globalThis.removeEventListener("hashchange", fragment);
  }, []);
  return (
    <section className="ov-step" aria-labelledby="channels-title" data-step="channels">
      <StepHeading id="channels-title" title={t("overlay.step.channels")} focusable />
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
