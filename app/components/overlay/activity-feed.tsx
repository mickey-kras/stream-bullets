import { useEffect, useMemo, useState } from "react";
import type { ActivityMessage } from "../../lib/activity";
import {
  activityUrl,
  openActivitySocket,
  type ActivitySocket,
  type ActivitySocketStatus,
} from "../../lib/activity-socket";

export type ActivityFeedStatus = ActivitySocketStatus | "off";

export interface ActivityFeed {
  /** Every parsed message of the page's activity socket. Returns the unsubscribe function. */
  subscribe(listener: (message: ActivityMessage) => void): () => void;
  status: ActivityFeedStatus;
}

type Listener = (message: ActivityMessage) => void;

/**
 * One activity socket per page and URL, shared by every layer that reads it (chat now, characters later). Each
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
        for (const listener of [...listeners]) listener(message);
      },
      onStatus: (status: ActivitySocketStatus): void => {
        created.status = status;
        for (const listener of [...statusListeners]) listener(status);
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

/**
 * The activity feed of a page for its overlay layers. It connects only while `enabled` and a key is present, and
 * closes the socket when disabled, so hiding the chat layer stops the feed.
 */
export function useActivityFeed(handle: string, key: string | null, enabled: boolean): ActivityFeed {
  const on: boolean = enabled && Boolean(key);
  const [status, setStatus] = useState<ActivityFeedStatus>(on ? "connecting" : "off");
  const listeners = useMemo<Set<Listener>>(() => new Set<Listener>(), []);
  const [session, setSession] = useState<string>(`${handle}:${key}:${on}`);
  const current = `${handle}:${key}:${on}`;
  if (session !== current) {
    setSession(current);
    setStatus(on ? "connecting" : "off");
  }
  useEffect(() => {
    if (!on || !key) return;
    const url: string = activityUrl(globalThis.location.origin, handle, key);
    return acquire(
      url,
      (message: ActivityMessage): void => {
        for (const listener of [...listeners]) listener(message);
      },
      setStatus,
    );
  }, [handle, key, on, listeners]);
  const subscribe = useMemo(
    () =>
      (listener: Listener): (() => void) => {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    [listeners],
  );
  return useMemo<ActivityFeed>(() => ({ subscribe, status }), [subscribe, status]);
}
