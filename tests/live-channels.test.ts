import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHANNEL_REFRESH_MS, useLiveChannels } from "../app/components/channels/use-live-channels";
import type { ChannelView } from "../app/lib/channel-health";

/** A minimal hook runner: state and refs persist by call order, and effects rerun when their dependencies change. */
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  effects: [] as { deps: readonly unknown[] | undefined; cleanup: (() => void) | undefined }[],
  stateIndex: 0,
  refIndex: 0,
  effectIndex: 0,
  pending: [] as (() => void)[],
}));
vi.mock("react", () => ({
  createContext: <T>(value: T): { value: T } => ({ value }),
  useState: <T>(initial: T): [T, (next: T) => void] => {
    const slot: number = hooks.stateIndex++;
    if (!(slot in hooks.states)) hooks.states[slot] = initial;
    return [
      hooks.states[slot] as T,
      (next: T): void => {
        hooks.states[slot] = next;
      },
    ];
  },
  useRef: <T>(value: T): { current: T } => {
    hooks.refs[hooks.refIndex] ??= { current: value };
    return hooks.refs[hooks.refIndex++] as { current: T };
  },
  useEffect: (effect: () => (() => void) | undefined, deps?: readonly unknown[]): void => {
    const slot: number = hooks.effectIndex++;
    const previous = hooks.effects[slot];
    if (previous && deps && previous.deps?.every((value: unknown, index: number) => Object.is(value, deps[index])))
      return;
    hooks.pending.push((): void => {
      previous?.cleanup?.();
      hooks.effects[slot] = { deps, cleanup: effect() ?? undefined };
    });
  },
}));

function channel(status: "active" | "error"): ChannelView {
  const connection = { displayName: "Host", status, code: null, connectedAt: 1, lastEventAt: null, updatedAt: 1 };
  return { platform: "kick", available: true, connection, support: false, supportScopes: [] };
}

const loaded: ChannelView[] = [channel("active")];
const broken: ChannelView[] = [channel("error")];
const fetched = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function render(list: ChannelView[]): { channels: ChannelView[]; stale: boolean } {
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
  hooks.effectIndex = 0;
  const result = useLiveChannels(list);
  for (const run of hooks.pending.splice(0)) run();
  return result;
}

function unmount(): void {
  for (const effect of hooks.effects) effect.cleanup?.();
  hooks.effects.length = 0;
}

/** A response whose body resolves without the real event loop, so the fake timers can wait for it. */
function response(body: () => Promise<unknown>, status: number): Response {
  return { ok: status < 400, status, json: body } as Response;
}

function answer(body: unknown, status: number = 200): void {
  fetched.mockImplementation(
    (): Promise<Response> => Promise.resolve(response((): Promise<unknown> => Promise.resolve(body), status)),
  );
}

/** One interval, then the promise steps between the response and the report. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CHANNEL_REFRESH_MS);
  for (let step: number = 0; step < 5; step += 1) await vi.advanceTimersByTimeAsync(0);
}

beforeEach((): void => {
  vi.useFakeTimers();
  hooks.states.length = 0;
  hooks.refs.length = 0;
  const browser = new EventTarget();
  // The message catalog reads the language of the document.
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false, documentElement: { lang: "en" } }));
  vi.stubGlobal("addEventListener", browser.addEventListener.bind(browser));
  vi.stubGlobal("removeEventListener", browser.removeEventListener.bind(browser));
  vi.stubGlobal("fetch", fetched);
  fetched.mockReset();
  answer({ channels: broken });
});
afterEach((): void => {
  unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("starts with the loader's list and reads GET /api/channels only after the interval", async (): Promise<void> => {
  expect(render(loaded)).toEqual({ channels: loaded, stale: false });
  expect(fetched).not.toHaveBeenCalled();
  await tick();
  expect(fetched).toHaveBeenCalledTimes(1);
  expect(fetched).toHaveBeenLastCalledWith("/api/channels", { credentials: "same-origin" });
  expect(render(loaded)).toEqual({ channels: broken, stale: false });
});

it("shows a newer loader list in place of an older read", async (): Promise<void> => {
  render(loaded);
  await tick();
  expect(render(loaded).channels).toEqual(broken);
  const reloaded: ChannelView[] = [channel("active")];
  expect(render(reloaded).channels).toBe(reloaded);
  // The next read belongs to the new loader list.
  await tick();
  expect(render(reloaded).channels).toEqual(broken);
});

it("drops a read that started before a newer loader list", async (): Promise<void> => {
  let finish: (body: unknown) => void = (): void => {};
  fetched.mockImplementation(
    (): Promise<Response> =>
      Promise.resolve(
        response((): Promise<unknown> => new Promise<unknown>((resolve): void => void (finish = resolve)), 200),
      ),
  );
  render(loaded);
  await tick();
  const reloaded: ChannelView[] = [channel("active")];
  render(reloaded);
  finish({ channels: broken });
  for (let step: number = 0; step < 5; step += 1) await vi.advanceTimersByTimeAsync(0);
  expect(render(reloaded).channels).toBe(reloaded);
});

it("keeps the last list while reads fail, and is stale from the third failure to the next success", async (): Promise<void> => {
  render(loaded);
  await tick();
  // A refused read, a body that is no JSON and a body of another shape all count.
  answer({ error: "Sign in to continue." }, 401);
  await tick();
  expect(render(loaded)).toEqual({ channels: broken, stale: false });
  fetched.mockImplementation(
    (): Promise<Response> =>
      Promise.resolve(response((): Promise<unknown> => Promise.reject(new SyntaxError("Unexpected token")), 200)),
  );
  await tick();
  expect(render(loaded)).toEqual({ channels: broken, stale: false });
  answer({ channels: [{ platform: "kick" }] });
  await tick();
  expect(render(loaded)).toEqual({ channels: broken, stale: true });
  fetched.mockImplementation((): Promise<Response> => Promise.reject(new TypeError("Failed to fetch")));
  await tick();
  expect(render(loaded)).toEqual({ channels: broken, stale: true });
  answer({ channels: loaded });
  await tick();
  expect(render(loaded)).toEqual({ channels: loaded, stale: false });
});

it("stops the timer when the page goes away", async (): Promise<void> => {
  render(loaded);
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  await tick();
  expect(fetched).not.toHaveBeenCalled();
});
