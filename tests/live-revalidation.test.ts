import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { REVALIDATE_INTERVAL_MS, useLiveRevalidation, type LiveStatus } from "../app/components/live";

/** A minimal hook runner: refs persist by call order, and effects rerun when their dependencies change. */
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  effects: [] as { deps: readonly unknown[] | undefined; cleanup: (() => void) | undefined }[],
  index: 0,
  effectIndex: 0,
  pending: [] as (() => void)[],
}));
vi.mock("react", () => ({
  useRef: <T>(value: T): { current: T } => {
    hooks.refs[hooks.index] ??= { current: value };
    return hooks.refs[hooks.index++] as { current: T };
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

const revalidate = vi.fn(async (): Promise<void> => {});

function render(status: LiveStatus, revision: number): void {
  hooks.index = 0;
  hooks.effectIndex = 0;
  useLiveRevalidation(status, revision, revalidate);
  for (const run of hooks.pending.splice(0)) run();
}

beforeEach((): void => {
  vi.useFakeTimers();
  hooks.refs.length = 0;
  hooks.effects.length = 0;
  revalidate.mockClear();
});
afterEach((): void => {
  for (const effect of hooks.effects) effect.cleanup?.();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("bounds reloads under a sustained vote burst", (): void => {
  // A new revision every 100 ms for ten minutes: 6000 live changes.
  let revision: number = 0;
  render("live", revision);
  for (let step: number = 0; step < 6000; step += 1) {
    vi.advanceTimersByTime(100);
    revision += 1;
    render("live", revision);
  }
  vi.advanceTimersByTime(10_000);
  const perMinute: number = revalidate.mock.calls.length / 10;
  expect(perMinute).toBeLessThanOrEqual(60_000 / REVALIDATE_INTERVAL_MS);
  expect(perMinute).toBeGreaterThanOrEqual(6);
});

it("reloads soon after the first change and once more for changes during the cooldown", (): void => {
  vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    if (!(array instanceof Uint32Array)) throw new Error("Expected Uint32Array jitter input");
    array.fill(0);
    return array;
  });
  render("live", 1);
  vi.advanceTimersByTime(400);
  expect(revalidate).toHaveBeenCalledTimes(1);
  render("live", 2);
  render("live", 3);
  vi.advanceTimersByTime(REVALIDATE_INTERVAL_MS - 1);
  expect(revalidate).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(revalidate).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(60_000);
  expect(revalidate).toHaveBeenCalledTimes(2);
});

it("spreads reloads with jitter so clients do not line up", (): void => {
  const delays: number[] = [];
  for (const random of [0, 0xffffffff]) {
    vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (!(array instanceof Uint32Array)) throw new Error("Expected Uint32Array jitter input");
      array.fill(random);
      return array;
    });
    for (const effect of hooks.effects) effect.cleanup?.();
    hooks.refs.length = 0;
    hooks.effects.length = 0;
    revalidate.mockClear();
    render("live", 1);
    vi.advanceTimersByTime(400);
    render("live", 2);
    let waited: number = 0;
    while (revalidate.mock.calls.length < 2) {
      vi.advanceTimersByTime(100);
      waited += 100;
    }
    delays.push(waited);
  }
  expect(delays[1] - delays[0]).toBeGreaterThanOrEqual(2000);
});
