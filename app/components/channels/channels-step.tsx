import { useEffect, useRef, type ReactNode } from "react";
import { t } from "../../i18n";
import { healthChanges, type ChannelView, type HealthChange } from "../../lib/channel-health";
import type { Provider } from "../../types";
import { announce } from "../a11y/announcer";
import { StepHeading } from "../overlay/step-heading";
import { useToast } from "../ui/toast";
import { ChannelPanel, PLATFORM_NAMES, channelProblem } from "./channel-panel";

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
 * first list is no news. A connection that reads no support events is no news: its card shows that state.
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
 * The Channels section of Streamer tools: the heading and the channel cards. The cards always show. The heading is
 * the target of the "Connect channels" links (`#channels-title`), and the panel moves focus to it.
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
  return (
    <section className="ov-step" aria-labelledby="channels-title" data-step="channels">
      <StepHeading id="channels-title" title={t("overlay.step.channels")} focusable />
      <ChannelPanel
        channels={channels}
        stale={stale}
        providers={providers}
        signInProvider={signInProvider}
        result={result}
      />
    </section>
  );
}
