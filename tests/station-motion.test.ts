import { afterEach, describe, expect, it, vi } from "vitest";
import { motionReduced, watchMotion } from "../app/components/station/motion";

type Observed = { callback: MutationCallback; options: MutationObserverInit | undefined; disconnected: boolean };

type Page = { root: { dataset: DOMStringMap }; observers: Observed[] };

function stubPage(reduced: string | undefined, osReduce: boolean = false): Page {
  const root: { dataset: DOMStringMap } = { dataset: reduced === undefined ? {} : { reduced } };
  const observers: Observed[] = [];
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("matchMedia", (query: string): { matches: boolean } => ({
    matches: osReduce && query === "(prefers-reduced-motion: reduce)",
  }));
  vi.stubGlobal(
    "MutationObserver",
    class {
      private readonly entry: Observed;
      constructor(callback: MutationCallback) {
        this.entry = { callback, options: undefined, disconnected: false };
        observers.push(this.entry);
      }
      observe(_target: Node, options?: MutationObserverInit): void {
        this.entry.options = options;
      }
      disconnect(): void {
        this.entry.disconnected = true;
      }
    },
  );
  return { root, observers };
}

function fire(observer: Observed): void {
  observer.callback([], {} as MutationObserver);
}

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe("station motion", () => {
  it("follows the app setting over the OS query", () => {
    stubPage("false", true);
    expect(motionReduced()).toBe(false);
    stubPage("true", false);
    expect(motionReduced()).toBe(true);
  });

  it("falls back to the OS query without the head script", () => {
    stubPage(undefined, true);
    expect(motionReduced()).toBe(true);
    stubPage(undefined, false);
    expect(motionReduced()).toBe(false);
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("matchMedia", undefined);
    expect(motionReduced()).toBe(false);
  });

  it("reports changes to data-reduced in both directions until aborted", () => {
    const { root, observers } = stubPage("false", true);
    const seen: boolean[] = [];
    const lifecycle = new AbortController();
    watchMotion((reduced: boolean): void => {
      seen.push(reduced);
    }, lifecycle.signal);
    expect(observers[0].options).toEqual({ attributes: true, attributeFilter: ["data-reduced"] });
    root.dataset.reduced = "true";
    fire(observers[0]);
    fire(observers[0]);
    root.dataset.reduced = "false";
    fire(observers[0]);
    expect(seen).toEqual([true, false]);
    lifecycle.abort();
    expect(observers[0].disconnected).toBe(true);
  });

  it("does nothing without a document", () => {
    vi.stubGlobal("document", undefined);
    const listener = vi.fn<(reduced: boolean) => void>();
    watchMotion(listener, new AbortController().signal);
    expect(listener).not.toHaveBeenCalled();
  });
});
