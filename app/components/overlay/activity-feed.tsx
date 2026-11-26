import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityMessage } from "../../lib/activity";
import { emptyHistory, historySnapshot, keepHistory, type ActivityHistory } from "../../lib/activity-history";
import {
  activityUrl,
  openActivitySocket,
  type ActivitySocket,
  type ActivitySocketStatus,
} from "../../lib/activity-socket";

export type ActivityFeedStatus = ActivitySocketStatus | "off";

export interface ActivityFeed {
  /**
   * Every parsed message of the page's activity socket. Returns the unsubscribe function. A reader that subscribes
   * after the snapshot of the socket gets a snapshot of the chat that the feed has (see `ActivityHistory`).
   */
  subscribe(this: void, listener: (message: ActivityMessage) => void): () => void;
  status: ActivityFeedStatus;
}

type Listener = (message: ActivityMessage) => void;

/**
 * One activity socket per page and URL, shared by every layer that reads it (chat and characters). Each
 * socket costs provider quota (YouTube is polled only while one is open), so a second reader never opens another.
 */
interface SharedSocket {
  socket: ActivitySocket;
  listeners: Set<Listener>;
  statusListeners: Set<(status: ActivitySocketStatus) => void>;
  status: ActivitySocketStatus;
  release: () => void;
}

const shared = new Map<string, SharedSocket>();

function acquire(url: string, onMessage: Listener, onStatus: (status: ActivitySocketStatus) => void): () => void {
  let entry: SharedSocket | undefined = shared.get(url);
  if (!entry) {
    const listeners = new Set<Listener>();
    const statusListeners = new Set<(status: ActivitySocketStatus) => void>();
    const created: SharedSocket = {
      listeners,
      statusListeners,
      status: "connecting",
      socket: { close: (): void => undefined, wake: (): void => undefined },
      release: (): void => undefined,
    };
    created.socket = openActivitySocket({
      url,
      onMessage: (message: ActivityMessage): void => {
        for (const listener of Array.from(listeners)) listener(message);
      },
      onStatus: (status: ActivitySocketStatus): void => {
        created.status = status;
        for (const listener of Array.from(statusListeners)) listener(status);
      },
    });
    const wake = (): void => {
      if (document.visibilityState !== "hidden") created.socket.wake();
    };
    globalThis.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    created.release = (): void => {
      globalThis.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      created.socket.close();
    };
    shared.set(url, created);
    entry = created;
  }
  const current: SharedSocket = entry;
  current.listeners.add(onMessage);
  current.statusListeners.add(onStatus);
  onStatus(current.status);
  return (): void => {
    current.listeners.delete(onMessage);
    current.statusListeners.delete(onStatus);
    if (current.listeners.size === 0 && shared.get(url) === current) {
      shared.delete(url);
      current.release();
    }
  };
}

/** `characters` adds the playground frames. `owner` connects without a key: the signed-in owner's editor. */
export interface ActivityFeedOptions {
  characters?: boolean;
  owner?: boolean;
}

/**
 * The activity feed of a page for its overlay layers. It connects only while `enabled` and a key is present (or
 * `owner` is set), and closes the socket when disabled, so hiding the chat layer stops the feed. A feed with
 * characters is its own socket, so the playground runs only while a characters layer listens.
 */
export function useActivityFeed(
  handle: string,
  key: string | null,
  enabled: boolean,
  options: ActivityFeedOptions = {},
): ActivityFeed {
  const characters: boolean = options.characters === true;
  const on: boolean = enabled && (Boolean(key) || options.owner === true);
  const [status, setStatus] = useState<ActivityFeedStatus>(on ? "connecting" : "off");
  const listenersRef = useRef<Set<Listener>>(new Set<Listener>());
  const historyRef = useRef<ActivityHistory>(emptyHistory());
  const [session, setSession] = useState<string>(`${handle}:${key}:${on}:${characters}`);
  const current = `${handle}:${key}:${on}:${characters}`;
  if (session !== current) {
    setSession(current);
    setStatus(on ? "connecting" : "off");
  }
  useEffect(() => {
    if (!on) return;
    const url: string = activityUrl(globalThis.location.origin, handle, key, { characters });
    const listeners: Set<Listener> = listenersRef.current;
    const release = acquire(
      url,
      (message: ActivityMessage): void => {
        historyRef.current = keepHistory(historyRef.current, message);
        for (const listener of Array.from(listeners)) listener(message);
      },
      (next: ActivitySocketStatus): void => {
        // A socket that is not live misses moderation. Its history is thus not the truth for a late reader, and
        // the next snapshot of the socket starts a new history.
        if (next !== "live") historyRef.current = emptyHistory();
        setStatus(next);
      },
    );
    // The history goes with its socket, in the cleanup. React runs each cleanup of a change before the effects of
    // the readers that mount in that change, so a new reader never gets the chat of a closed socket.
    return (): void => {
      release();
      historyRef.current = emptyHistory();
    };
  }, [handle, key, on, characters]);
  const subscribe = useMemo(
    () =>
      (listener: Listener): (() => void) => {
        listenersRef.current.add(listener);
        // The socket sent its snapshot before this reader came: give the reader the chat that the feed has.
        const kept: ActivityMessage | null = historySnapshot(historyRef.current);
        if (kept) listener(kept);
        return (): void => {
          listenersRef.current.delete(listener);
        };
      },
    [],
  );
  return useMemo<ActivityFeed>(() => ({ subscribe, status }), [subscribe, status]);
}
