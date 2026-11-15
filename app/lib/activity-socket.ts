import { parseActivityMessage, type ActivityMessage } from "./activity";

/**
 * The client of the activity socket (docs/channel-connections.md, "Rules for consumers"). It never gives up: an
 * unattended OBS source has nobody to press Reconnect. The WebSocket, the timers and the randomness are injected,
 * so tests drive it without a network or a real clock.
 */

export const PING_INTERVAL_MS = 20_000;
/** No snapshot, event or pong for this long: the socket is taken as dead and replaced. */
export const WATCHDOG_MS = 90_000;
export const BACKOFF_START_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

const OPEN = 1;

export type ActivitySocketStatus = "connecting" | "live" | "reconnecting";

/** The part of the browser WebSocket that the client uses. */
export interface ActivityWebSocket {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type ActivityWebSocketConstructor = new (url: string) => ActivityWebSocket;

export interface ActivitySocketOptions {
  url: string;
  /** Each message the parser accepts. Malformed frames never reach it. */
  onMessage: (message: ActivityMessage) => void;
  onStatus: (status: ActivitySocketStatus) => void;
  WebSocketImpl?: ActivityWebSocketConstructor;
  /** A number in [0, 1). */
  random?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ActivitySocket {
  /** Stops for good: no more messages, statuses or reconnects. */
  close(): void;
  /** The network or the tab came back: retry now instead of waiting out the backoff. */
  wake(): void;
}

/** The socket URL of a page's activity feed: `ws(s)://origin/api/activity/:handle?key=K`. */
export function activityUrl(origin: string, handle: string, key: string | null): string {
  const url = new URL(`/api/activity/${encodeURIComponent(handle)}`, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (key) url.searchParams.set("key", key);
  return url.toString();
}

/**
 * The wait before reconnect try `attempt` (1 for the first): 1 s, doubling to at most 60 s, with jitter that keeps
 * it between half of that and all of it, so many sources never reconnect in step.
 */
export function backoffMs(attempt: number, random: number): number {
  const step: number = Math.min(Math.max(1, Math.floor(attempt)), 16);
  const ceiling: number = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (step - 1));
  const jitter: number = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0;
  return Math.round(ceiling * (0.5 + jitter * 0.5));
}

export function openActivitySocket(options: ActivitySocketOptions): ActivitySocket {
  const Impl: ActivityWebSocketConstructor = options.WebSocketImpl ?? WebSocket;
  // Jitter only spreads reconnects; it needs no cryptographic source.
  const random: () => number = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number): unknown => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let closed = false;
  let socket: ActivityWebSocket | null = null;
  let attempts = 0;
  let retry: unknown = null;
  let watchdog: unknown = null;
  let pinger: unknown = null;

  function stop(handle: unknown): null {
    if (handle !== null) clearTimer(handle);
    return null;
  }

  function detach(current: ActivityWebSocket): void {
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    watchdog = stop(watchdog);
    pinger = stop(pinger);
    socket = null;
  }

  /** Ends this socket and schedules the next try. The backoff grows until a snapshot arrives. */
  function drop(current: ActivityWebSocket): void {
    detach(current);
    try {
      current.close();
    } catch {
      // Already closed.
    }
    if (closed) return;
    attempts += 1;
    options.onStatus("reconnecting");
    retry = setTimer(connect, backoffMs(attempts, random()));
  }

  function armWatchdog(current: ActivityWebSocket): void {
    watchdog = stop(watchdog);
    watchdog = setTimer((): void => drop(current), WATCHDOG_MS);
  }

  function armPing(current: ActivityWebSocket): void {
    pinger = stop(pinger);
    pinger = setTimer((): void => {
      pinger = null;
      if (current.readyState === OPEN) current.send("ping");
      armPing(current);
    }, PING_INTERVAL_MS);
  }

  function receive(current: ActivityWebSocket, data: unknown): void {
    if (data === "pong") {
      armWatchdog(current);
      return;
    }
    const message: ActivityMessage | null = parseActivityMessage(data);
    if (!message) return;
    if (message.type === "unavailable") {
      // The key changed or the page is suspended: clear the screen, then keep trying with a growing wait.
      options.onMessage(message);
      drop(current);
      return;
    }
    armWatchdog(current);
    if (message.type === "snapshot") {
      attempts = 0;
      options.onStatus("live");
    }
    options.onMessage(message);
  }

  function connect(): void {
    retry = null;
    options.onStatus(attempts === 0 ? "connecting" : "reconnecting");
    let current: ActivityWebSocket;
    try {
      current = new Impl(options.url);
    } catch {
      attempts += 1;
      options.onStatus("reconnecting");
      retry = setTimer(connect, backoffMs(attempts, random()));
      return;
    }
    socket = current;
    armWatchdog(current);
    current.onopen = (): void => armPing(current);
    current.onmessage = (event: MessageEvent): void => {
      receive(current, event.data);
    };
    current.onerror = (): void => drop(current);
    current.onclose = (): void => drop(current);
  }

  connect();
  return {
    close(): void {
      if (closed) return;
      closed = true;
      retry = stop(retry);
      if (socket) drop(socket);
    },
    wake(): void {
      if (closed || retry === null) return;
      retry = stop(retry);
      connect();
    },
  };
}
