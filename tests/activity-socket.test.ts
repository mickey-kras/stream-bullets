import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityChat, ActivityMessage } from "../app/lib/activity";
import {
  BACKOFF_MAX_MS,
  PING_INTERVAL_MS,
  WATCHDOG_MS,
  activityUrl,
  backoffMs,
  openActivitySocket,
  type ActivitySocketOptions,
  type ActivitySocketStatus,
  type ActivityWebSocket,
} from "../app/lib/activity-socket";

class FakeSocket implements ActivityWebSocket {
  static instances: FakeSocket[] = [];
  static failNext = 0;
  readyState = 0;
  sent: string[] = [];
  closed = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly url: string) {
    if (FakeSocket.failNext > 0) {
      FakeSocket.failNext -= 1;
      throw new Error("blocked");
    }
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed += 1;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  serverClose(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

const chat: ActivityChat = {
  kind: "chat",
  id: "twitch:m1",
  platform: "twitch",
  channelId: "c",
  messageId: "m1",
  user: { id: "u", displayName: "U" },
  text: "hi",
  fragments: [{ type: "text", text: "hi" }],
  badges: [],
  sentAt: null,
  receivedAt: 1,
  live: true,
};
const SNAPSHOT = JSON.stringify({ type: "snapshot", events: [], replay: true });
const EVENT = JSON.stringify({ type: "event", event: chat });
const UNAVAILABLE = JSON.stringify({ type: "unavailable" });

function latest(): FakeSocket {
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("no socket");
  return socket;
}

function open(extra: Partial<ActivitySocketOptions> = {}): {
  messages: ActivityMessage[];
  statuses: ActivitySocketStatus[];
  socket: ReturnType<typeof openActivitySocket>;
} {
  const messages: ActivityMessage[] = [];
  const statuses: ActivitySocketStatus[] = [];
  const socket = openActivitySocket({
    url: "wss://example.test/api/activity/h?key=k",
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    WebSocketImpl: FakeSocket,
    random: () => 0.5,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...extra,
  });
  return { messages, statuses, socket };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  FakeSocket.failNext = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("activityUrl", () => {
  it("builds the socket URL with the key", () => {
    expect(activityUrl("https://sb.test", "my_handle", "k/1")).toBe("wss://sb.test/api/activity/my_handle?key=k%2F1");
    expect(activityUrl("http://localhost:5173", "h", null)).toBe("ws://localhost:5173/api/activity/h");
  });
});

describe("backoffMs", () => {
  it("starts at 1 s, doubles to 60 s and keeps jitter within half of the step", () => {
    expect(backoffMs(1, 0.999999)).toBe(1000);
    expect(backoffMs(1, 0)).toBe(500);
    expect(backoffMs(2, 0.999999)).toBe(2000);
    expect(backoffMs(3, 0)).toBe(2000);
    expect(backoffMs(7, 0.999999)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(100, 0)).toBe(BACKOFF_MAX_MS / 2);
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      for (const random of [0, 0.25, 0.5, 0.75, 0.999]) {
        const wait = backoffMs(attempt, random);
        const ceiling = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** (attempt - 1));
        expect(wait).toBeGreaterThanOrEqual(ceiling / 2);
        expect(wait).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("clamps bad input", () => {
    expect(backoffMs(0, 0.5)).toBe(750);
    expect(backoffMs(-5, 2)).toBe(1000);
    expect(backoffMs(1, Number.NaN)).toBe(500);
    expect(backoffMs(1, -1)).toBe(500);
  });
});

describe("openActivitySocket", () => {
  it("connects, goes live on the snapshot and passes events on", () => {
    const { messages, statuses } = open();
    expect(latest().url).toBe("wss://example.test/api/activity/h?key=k");
    expect(statuses).toEqual(["connecting"]);
    latest().open();
    latest().receive(SNAPSHOT);
    latest().receive(EVENT);
    expect(statuses).toEqual(["connecting", "live"]);
    expect(messages.map((message) => message.type)).toEqual(["snapshot", "event"]);
  });

  it("ignores invalid frames, pongs and non-text data", () => {
    const { messages } = open();
    latest().open();
    for (const frame of ["not json", "{}", '{"type":"event","event":{"kind":"nope"}}', "pong", 42, new ArrayBuffer(2), "x".repeat(600_000)]) {
      latest().receive(frame);
    }
    expect(messages).toEqual([]);
    expect(latest().closed).toBe(0);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("pings every 20 s while open", () => {
    open();
    const socket = latest();
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(socket.sent).toEqual([]);
    socket.open();
    vi.advanceTimersByTime(PING_INTERVAL_MS - 1);
    expect(socket.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(socket.sent).toEqual(["ping"]);
    socket.receive("pong");
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(socket.sent).toEqual(["ping", "ping"]);
    socket.readyState = 2;
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(socket.sent).toEqual(["ping", "ping"]);
  });

  it("keeps a quiet socket alive with pongs", () => {
    open();
    const socket = latest();
    socket.open();
    socket.receive(SNAPSHOT);
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(PING_INTERVAL_MS);
      socket.receive("pong");
    }
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.closed).toBe(0);
  });

  it("replaces a silent socket after the 90 s watchdog", () => {
    const { statuses } = open();
    const socket = latest();
    socket.open();
    socket.receive(SNAPSHOT);
    vi.advanceTimersByTime(WATCHDOG_MS - 1);
    socket.receive("garbage");
    vi.advanceTimersByTime(1);
    expect(socket.closed).toBe(1);
    expect(statuses.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(backoffMs(1, 0.5));
    expect(FakeSocket.instances).toHaveLength(2);
    // The dead socket no longer reaches the consumer.
    expect(socket.onmessage).toBeNull();
  });

  it("backs off with growing waits and resets after a snapshot", () => {
    const { statuses } = open();
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      latest().serverClose();
      const before = FakeSocket.instances.length;
      vi.advanceTimersByTime(backoffMs(attempt, 0.5) - 1);
      expect(FakeSocket.instances).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(before + 1);
      waits.push(backoffMs(attempt, 0.5));
    }
    expect(waits).toEqual([750, 1500, 3000, 6000]);
    expect(statuses.at(-1)).toBe("reconnecting");
    latest().open();
    latest().receive(SNAPSHOT);
    expect(statuses.at(-1)).toBe("live");
    latest().serverClose();
    vi.advanceTimersByTime(backoffMs(1, 0.5));
    expect(FakeSocket.instances).toHaveLength(6);
    expect(statuses.at(-1)).toBe("reconnecting");
  });

  it("reconnects after a socket error", () => {
    open();
    latest().onerror?.({} as Event);
    expect(latest().closed).toBe(1);
    vi.advanceTimersByTime(backoffMs(1, 0.5));
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("passes unavailable on, closes and keeps backing off", () => {
    const { messages, statuses } = open();
    latest().open();
    latest().receive(SNAPSHOT);
    latest().receive(UNAVAILABLE);
    expect(messages.map((message) => message.type)).toEqual(["snapshot", "unavailable"]);
    expect(latest().closed).toBe(1);
    expect(statuses.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(backoffMs(1, 0.5));
    expect(FakeSocket.instances).toHaveLength(2);
    latest().open();
    latest().receive(UNAVAILABLE);
    vi.advanceTimersByTime(backoffMs(2, 0.5) - 1);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
    expect(statuses).not.toContain("offline");
  });

  it("retries when the constructor throws", () => {
    FakeSocket.failNext = 1;
    const { statuses } = open();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(statuses).toEqual(["connecting", "reconnecting"]);
    vi.advanceTimersByTime(backoffMs(1, 0.5));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("wakes up early only while waiting to reconnect", () => {
    const { socket } = open();
    socket.wake();
    expect(FakeSocket.instances).toHaveLength(1);
    latest().serverClose();
    socket.wake();
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(BACKOFF_MAX_MS);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("stops for good on close", () => {
    const { socket, messages, statuses } = open();
    const current = latest();
    current.open();
    socket.close();
    expect(current.closed).toBe(1);
    socket.close();
    socket.wake();
    current.receive(EVENT);
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(messages).toEqual([]);
    expect(statuses).toEqual(["connecting"]);
  });

  it("stops while waiting to reconnect, and ignores a close that throws", () => {
    const { socket } = open();
    const current = latest();
    current.close = (): void => {
      throw new Error("already closed");
    };
    current.serverClose();
    socket.close();
    vi.advanceTimersByTime(BACKOFF_MAX_MS);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("uses the global WebSocket, timers and crypto by default", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const statuses: ActivitySocketStatus[] = [];
    const socket = openActivitySocket({ url: "wss://x.test/a", onMessage: () => undefined, onStatus: (s) => statuses.push(s) });
    expect(FakeSocket.instances).toHaveLength(1);
    latest().serverClose();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    socket.close();
    expect(statuses).toEqual(["connecting", "reconnecting", "reconnecting"]);
  });
});
