import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ActivityMessage } from "../../lib/activity";
import { INITIAL_ALERTS, alertsAfter, bannerMs, type AlertsSeen } from "../../lib/alert-feed";
import type { AlertsState } from "../../lib/alerts";
import type { ActivityFeed } from "./activity-feed";

/**
 * The alerts of a page as a reader shows them: the state of the newest `alerts` message of the activity socket.
 * `current` is the alert on stream only while its time runs on this page, then null. Before the first message the
 * page has no alert, no line, and no count of the goal (`NO_ALERTS`).
 */
export interface AlertsView extends AlertsState {
  /**
   * How long this page shows `current`, from the time when the page got it, in milliseconds. A page that connects
   * during an alert has only the time that is left. 0 without an alert.
   */
  showMs: number;
}

/**
 * Whether the local time `until` is still to come. A local timer ends the time, also without a new server message.
 * False on the server and during hydration, so the page hydrates without a mismatch.
 */
function useBefore(until: number): boolean {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // A timer can fire a little early: wait again until no time is left.
      const wait = (): void => {
        const ms: number = until - Date.now();
        if (ms > 0)
          timer = setTimeout((): void => {
            onChange();
            wait();
          }, ms);
      };
      wait();
      return (): void => clearTimeout(timer);
    },
    [until],
  );
  return useSyncExternalStore(
    subscribe,
    (): boolean => Date.now() < until,
    (): boolean => false,
  );
}

/**
 * The alerts and the goal of the activity feed of a page (issue #1043). It reads the `alerts` messages of `feed` and
 * opens no socket of its own: `useActivityFeed` has the one socket of the page. A null feed has no alerts.
 *
 * `serverOffset` is server time minus local time, as the chat uses it. The alert on stream ends by a timer of this
 * page at its end time, so a late or lost server message never leaves a banner on stream. The two outputs get the
 * same state from the server, so they show the same alert at the same time.
 */
export function useAlerts(feed: ActivityFeed | null, serverOffset: number = 0): AlertsView {
  const subscribe = feed?.subscribe ?? null;
  const [seen, setSeen] = useState<AlertsSeen>(INITIAL_ALERTS);
  // A new feed starts without a state: the feed gives a late reader the last state of its socket.
  const [source, setSource] = useState<ActivityFeed["subscribe"] | null>(() => subscribe);
  if (source !== subscribe) {
    setSource(() => subscribe);
    setSeen(INITIAL_ALERTS);
  }
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((message: ActivityMessage): void => {
      setSeen((current: AlertsSeen): AlertsSeen => alertsAfter(current, message, Date.now()));
    });
  }, [subscribe]);
  const showMs: number = bannerMs(seen, serverOffset);
  const running: boolean = useBefore(seen.seenAt + showMs);
  return running ? { ...seen.state, showMs } : { ...seen.state, current: null, showMs: 0 };
}
