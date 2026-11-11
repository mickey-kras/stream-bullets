import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLivePolls } from "../app/components/live";

const hooks = vi.hoisted(() => ({
  effects: [] as (() => (() => void) | undefined)[],
  update: vi.fn(),
}));
vi.mock("react", () => ({
  useState: <T>(value: T): [T, typeof hooks.update] => [value, hooks.update],
  useEffect: (effect: () => (() => void) | undefined): void => { hooks.effects.push(effect); },
}));

class Socket {
  static readonly OPEN = 1;
  static readonly sockets: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: URL) { Socket.sockets.push(this); }
  send(_message: string): void {}
  close(): void { this.readyState = 3; this.onclose?.(); }
  snapshot(): void {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "snapshot", revision: 0, serverNow: Date.now(), polls: [] }) });
  }
}
let cleanup: (() => void) | undefined;

function current(): Socket { return Socket.sockets[Socket.sockets.length - 1]; }
function start(): void {
  useLivePolls("test_host");
  cleanup = hooks.effects[0]();
}

beforeEach((): void => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { origin: "https://streambullets.test" });
  Socket.sockets.length = 0;
  hooks.effects.length = 0;
  hooks.update.mockClear();
});
afterEach((): void => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([false, true])("stops after nine failed connections, accepted snapshot: %s", (accepted: boolean): void => {
  start();
  for (let attempt: number = 0; attempt < 9; attempt += 1) {
    if (accepted) current().snapshot();
    current().close();
    vi.advanceTimersByTime(30_000);
  }
  expect(Socket.sockets).toHaveLength(9);
  expect(hooks.update).toHaveBeenLastCalledWith("offline");
  vi.advanceTimersByTime(600_000);
  expect(Socket.sockets).toHaveLength(9);
});

it.each([0, 0xffffffff])("spreads the first retry within its bounded delay for random %s", (random: number): void => {
  vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    if (!(array instanceof Uint32Array)) throw new Error("Expected Uint32Array jitter input");
    array.fill(random);
    return array;
  });
  start();
  current().close();
  vi.advanceTimersByTime(random === 0 ? 499 : 998);
  expect(Socket.sockets).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(Socket.sockets).toHaveLength(2);
});

it("renews the budget after a sustained healthy connection", (): void => {
  start();
  for (let attempt: number = 0; attempt < 8; attempt += 1) {
    current().close();
    vi.advanceTimersByTime(30_000);
  }
  current().snapshot();
  vi.advanceTimersByTime(60_000);
  current().snapshot();
  current().close();
  vi.advanceTimersByTime(1000);
  expect(Socket.sockets).toHaveLength(10);
  expect(hooks.update).not.toHaveBeenCalledWith("offline");
});

it("cancels a pending retry when the page leaves", (): void => {
  start();
  current().close();
  cleanup?.();
  cleanup = undefined;
  vi.advanceTimersByTime(600_000);
  expect(Socket.sockets).toHaveLength(1);
});

it("exhausts the budget when each accepted connection stalls until the watchdog closes it", (): void => {
  start();
  for (let attempt: number = 0; attempt < 9; attempt += 1) {
    current().snapshot();
    vi.advanceTimersByTime(90_000);
    vi.advanceTimersByTime(30_000);
  }
  expect(Socket.sockets).toHaveLength(9);
  expect(hooks.update).toHaveBeenLastCalledWith("offline");
});
