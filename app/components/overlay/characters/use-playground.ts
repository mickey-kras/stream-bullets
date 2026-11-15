import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityMessage } from "../../../lib/activity";
import type { ModeView, RosterEntry } from "../../../lib/playground/protocol";
import { motionReduced } from "../../station/motion";
import type { ActivityFeed } from "../activity-feed";
import { type FrameState, mergeFrame, toView } from "./adapter";
import { pushFrame, sampleView, type TimedView } from "./interpolate";
import type { PlaygroundView } from "./view";

/**
 * The view source of a characters layer: it keeps the playground frames of `feed` and gives the view to draw at a
 * performance.now() time. Without a feed or before the first full frame it gives null.
 */
export function usePlaygroundSource(feed: ActivityFeed | null): (now: number) => PlaygroundView | null {
  const state = useRef<FrameState | null>(null);
  const buffer = useRef<TimedView[]>([]);
  const subscribe = feed?.subscribe ?? null;
  useEffect(() => {
    if (!subscribe) return;
    state.current = null;
    buffer.current = [];
    return subscribe((message: ActivityMessage): void => {
      // The feed closed for good (channels off, a revoked key): the layer goes blank instead of freezing.
      if (message.type === "unavailable") {
        state.current = null;
        buffer.current = [];
        return;
      }
      if (message.type !== "playground") return;
      const next: FrameState | null = mergeFrame(state.current, message);
      state.current = next;
      if (next) buffer.current = pushFrame(buffer.current, toView(next, message.chars), performance.now());
    });
  }, [subscribe]);
  return useCallback(
    (now: number): PlaygroundView | null => (subscribe ? sampleView(buffer.current, now, motionReduced()) : null),
    [subscribe],
  );
}

/** What the owner's controls show: the characters on the playground and its mode. */
export interface PlaygroundSummary {
  roster: readonly RosterEntry[];
  mode: ModeView;
}

/** The roster and mode of the newest frame of `feed`, or null before the first full frame. */
export function usePlaygroundSummary(feed: ActivityFeed | null): PlaygroundSummary | null {
  const [summary, setSummary] = useState<PlaygroundSummary | null>(null);
  const state = useRef<FrameState | null>(null);
  const subscribe = feed?.subscribe ?? null;
  useEffect(() => {
    if (!subscribe) return;
    state.current = null;
    return subscribe((message: ActivityMessage): void => {
      if (message.type === "unavailable") {
        state.current = null;
        setSummary(null);
        return;
      }
      if (message.type !== "playground") return;
      const before: FrameState | null = state.current;
      const next: FrameState | null = mergeFrame(before, message);
      state.current = next;
      // Tick frames repeat the roster and mode only when they change, so most frames change nothing here.
      if (next && (next.roster !== before?.roster || next.mode !== before?.mode))
        setSummary({ roster: next.roster, mode: next.mode });
    });
  }, [subscribe]);
  return subscribe ? summary : null;
}
