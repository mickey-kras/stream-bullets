import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ActivityChat, ActivityMessage } from "../../lib/activity";
import {
  chatReducer,
  initialChatState,
  nextWakeAt,
  type ChatAction,
  type ChatOptions,
  type ChatRow,
  type ChatState,
} from "../../lib/chat-feed";
import { motionReduced, watchMotion } from "../station/motion";
import type { ActivityFeed } from "./activity-feed";

/** The editor preview adds one sample message this often. */
export const SAMPLE_INTERVAL_MS = 2_400;

export interface UseChatOptions {
  /** The page's activity feed, or null when the chat layer is off. */
  feed: ActivityFeed | null;
  /** Editor preview: these messages play on a loop and no socket is read. */
  samples?: readonly ActivityChat[];
  hideCommands: boolean;
  /** Server time minus local time, when known. */
  serverOffset?: number;
}

const STILL_LIMITS: ChatOptions["limits"] = { lifetimeMs: Number.POSITIVE_INFINITY };

/** A sample as a fresh message: a new id each round, so the dedupe never hides the loop. */
function sampleEvent(sample: ActivityChat, round: number, now: number): ActivityChat {
  const messageId = `${sample.messageId}-${round}`;
  return { ...sample, messageId, id: `${sample.platform}:${messageId}`, receivedAt: now, sentAt: null, live: false };
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

/**
 * The rows of the merged chat. It feeds the activity feed (or the samples) through `chatReducer` and wakes once at
 * `nextWakeAt` to move animations and lifetimes forward. A changed `hideCommands` applies to the rows on screen.
 *
 * Samples play on a loop, except with reduced motion: then they show once, as a still snapshot.
 */
export function useChat({ feed, samples, hideCommands, serverOffset }: UseChatOptions): ChatRow[] {
  const [state, setState] = useState<ChatState>(initialChatState);
  // A still sample snapshot never expires, so the preview never empties.
  const still: boolean = useMotionReduced() && samples !== undefined;
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
      let index = 0;
      let round = 1;
      const timer = setInterval(() => {
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
      }, SAMPLE_INTERVAL_MS);
      return (): void => clearInterval(timer);
    }
    if (!subscribe) return;
    return subscribe((message: ActivityMessage): void => {
      dispatch({ type: "message", message, now: Date.now(), serverOffset: offsetRef.current });
    });
  }, [subscribe, samples, dispatch, still]);

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

  return state.rows;
}
