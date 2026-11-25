import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ActivityChat, ActivityEvent, ActivityMessage, ActivityPlatform } from "../../lib/activity";
import {
  chatReducer,
  initialChatState,
  nextWakeAt,
  type ChatAction,
  type ChatOptions,
  type ChatState,
} from "../../lib/chat-feed";
import { chatTestScript } from "../../lib/chat-test";
import type { ChatView } from "../../lib/fading-rows";
import { motionReduced, watchMotion } from "../station/motion";
import type { ActivityFeed } from "./activity-feed";

/** The editor preview and the chat test add one sample event this often. */
export const SAMPLE_INTERVAL_MS = 2_400;

export interface UseChatOptions {
  /** The page's activity feed, or null when the chat layer is off. */
  feed: ActivityFeed | null;
  /** Editor preview: these messages play on a loop and no socket is read. */
  samples?: readonly ActivityChat[];
  hideCommands: boolean;
  /** Server time minus local time, when known. */
  serverOffset?: number;
  /** A chat test runs: show the test chat (CHAT_TEST_SCRIPT). The real chat keeps its state and shows again after. */
  test?: boolean;
  /** The one platform that the output shows: the test chat has only its events. Null: each platform. */
  platform?: ActivityPlatform | null;
}

const STILL_LIMITS: ChatOptions["limits"] = { lifetimeMs: Number.POSITIVE_INFINITY };

/**
 * A sample as a fresh event: a new message id each round, so the dedupe never hides the loop, and a delete of the
 * same round matches it. The `until` of a sample ban is the length of the timeout.
 */
function sampleEvent(sample: ActivityEvent, round: number, now: number): ActivityEvent {
  if (sample.kind === "chat") {
    const messageId = `${sample.messageId}-${round}`;
    return { ...sample, messageId, id: `${sample.platform}:${messageId}`, receivedAt: now, sentAt: null, live: false };
  }
  if (sample.kind === "delete") return { ...sample, messageId: `${sample.messageId}-${round}`, receivedAt: now };
  if (sample.kind === "ban")
    return { ...sample, until: sample.until === null ? null : now + sample.until, receivedAt: now };
  return sample;
}

function subscribeMotion(onChange: () => void): () => void {
  const stop = new AbortController();
  watchMotion((): void => onChange(), stop.signal);
  return (): void => stop.abort();
}

/**
 * The page's effective reduced-motion setting (the site's Motion preference, or the OS setting), kept current.
 * False on the server and before the first effect.
 */
function useMotionReduced(): boolean {
  return useSyncExternalStore(subscribeMotion, motionReduced, (): boolean => false);
}

/** Where a chat state gets its events: the activity feed, or samples (shown at once if `prefill`, then on a loop). */
interface ChatSource {
  feed: ActivityFeed | null;
  samples?: readonly ActivityEvent[];
  prefill: boolean;
}

/**
 * One chat state: it feeds the activity feed (or the samples) through `chatReducer` and wakes once at `nextWakeAt` to
 * move animations and lifetimes forward. A changed `hideCommands` applies to the rows on screen.
 *
 * Prefilled samples play on a loop, except with reduced motion: then they show once, as a still snapshot.
 */
function useChatState(
  { feed, samples, prefill }: ChatSource,
  hideCommands: boolean,
  serverOffset: number | undefined,
): ChatState {
  const [state, setState] = useState<ChatState>(initialChatState);
  // A still sample snapshot never expires, so the preview never empties.
  const still: boolean = useMotionReduced() && samples !== undefined && prefill;
  const options: ChatOptions = still ? { hideCommands, limits: STILL_LIMITS } : { hideCommands };
  const optionsRef = useRef<ChatOptions>(options);
  const offsetRef = useRef<number | undefined>(serverOffset);
  const dispatch = useCallback((action: ChatAction): void => {
    setState((current: ChatState): ChatState => chatReducer(current, action, optionsRef.current));
  }, []);
  const appliedHide = useRef<boolean>(hideCommands);
  useEffect(() => {
    optionsRef.current = still ? { hideCommands, limits: STILL_LIMITS } : { hideCommands };
    offsetRef.current = serverOffset;
    if (appliedHide.current === hideCommands) return;
    appliedHide.current = hideCommands;
    dispatch({ type: "filter", hideCommands, now: Date.now() });
  }, [hideCommands, serverOffset, still, dispatch]);

  const subscribe = feed?.subscribe ?? null;
  useEffect(() => {
    dispatch({ type: "reset" });
    if (samples) {
      if (samples.length === 0) return;
      let index = 0;
      let round = 1;
      if (prefill) {
        const now: number = Date.now();
        dispatch({
          type: "message",
          message: {
            type: "snapshot",
            replay: true,
            events: samples.map((s, i) => sampleEvent(s, 0, now - (samples.length - i) * 1000)),
          },
          now,
        });
        if (still) return;
      }
      const play = (): void => {
        const at: number = Date.now();
        dispatch({
          type: "message",
          message: { type: "event", event: sampleEvent(samples[index], round, at) },
          now: at,
        });
        index += 1;
        if (index === samples.length) {
          index = 0;
          round += 1;
        }
      };
      // Without a prefill the first event comes at once, so the chat does not wait empty.
      if (!prefill) play();
      const timer = setInterval(play, SAMPLE_INTERVAL_MS);
      return (): void => clearInterval(timer);
    }
    if (!subscribe) return;
    return subscribe((message: ActivityMessage): void => {
      dispatch({ type: "message", message, now: Date.now(), serverOffset: offsetRef.current });
    });
  }, [subscribe, samples, prefill, dispatch, still]);

  const wakeAt: number | null = nextWakeAt(state, options);
  useEffect(() => {
    if (wakeAt === null) return;
    // A timer may fire a little early: tick at least at the wake time, so the state always moves on.
    const timer = setTimeout(
      () => dispatch({ type: "tick", now: Math.max(Date.now(), wakeAt) }),
      Math.max(0, wakeAt - Date.now()),
    );
    return (): void => clearTimeout(timer);
  }, [wakeAt, dispatch]);

  return state;
}

/**
 * The merged chat: its rows, reset epoch and latest change time (see ChatView), from the activity feed or the editor
 * samples. During a chat test it returns the test chat instead. The real chat keeps reading the feed underneath, so
 * it is current when the test ends.
 */
export function useChat({
  feed,
  samples,
  hideCommands,
  serverOffset,
  test = false,
  platform = null,
}: UseChatOptions): ChatView {
  const chat: ChatState = useChatState({ feed, samples, prefill: true }, hideCommands, serverOffset);
  const script: readonly ActivityEvent[] = useMemo(() => chatTestScript(platform), [platform]);
  const trial: ChatState = useChatState(
    { feed: null, samples: test ? script : undefined, prefill: false },
    hideCommands,
    serverOffset,
  );
  return test ? trial : chat;
}
