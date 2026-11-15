import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Disposable, Frame, Page } from "@playwright/test";
import { writeUiSnapshot, type UiCoverage } from "../scripts/ui-coverage.ts";
import { COVERAGE_TRANSPORT, close, installBrowserCoverage, newPage } from "./e2e/coverage";

vi.mock("@playwright/test", () => ({ test: { extend: vi.fn() }, expect: vi.fn() }));
vi.mock("../scripts/ui-coverage.ts", async (original) => ({
  ...await original<typeof import("../scripts/ui-coverage.ts")>(), writeUiSnapshot: vi.fn(),
}));

afterEach((): void => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

function counters(): UiCoverage {
  const range = { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } };
  return { path: "app/components/probe.tsx", statementMap: { "0": range },
    fnMap: { "0": { name: "handler", decl: range, loc: range, line: 1 } },
    branchMap: { "0": { type: "if", loc: range, line: 1, locations: [range, range] } },
    s: { "0": 3 }, f: { "0": 2 }, b: { "0": [1, 0] } };
}
function snapshot(documentId: string, sequence: number = 1): string {
  const coverage: UiCoverage = counters();
  return JSON.stringify({ version: 1, id: `${documentId}:${sequence}`, documentId, sequence, final: true,
    files: { [coverage.path]: { sourceHash: "a".repeat(64), coverage } } });
}
function fixture(): {
  page: Page; context: BrowserContext; frame: Frame; resources: Disposable[]; send: (message: string) => Promise<void>;
} {
  const resources: Disposable[] = [0, 1].map(() => ({ dispose: vi.fn(async (): Promise<void> => undefined) } as unknown as Disposable));
  let receive: ((payload: unknown) => Promise<void>) | undefined;
  const frame = { url: (): string => "http://localhost:5173/streamers", evaluate: vi.fn(async (): Promise<void> => undefined) } as unknown as Frame;
  const page = {
    exposeBinding: vi.fn(async (_name: string, callback: (_source: unknown, payload: unknown) => Promise<void>): Promise<Disposable> => {
      receive = (payload: unknown): Promise<void> => callback({}, payload);
      return resources[0];
    }),
    addInitScript: vi.fn(async (): Promise<Disposable> => resources[1]),
    evaluate: vi.fn(async (): Promise<void> => undefined), frames: (): Frame[] => [frame],
    close: vi.fn(async (): Promise<void> => undefined),
  } as unknown as Page;
  const context = { newPage: vi.fn(async (): Promise<Page> => page), pages: (): Page[] => [page],
    close: vi.fn(async (): Promise<void> => undefined) } as unknown as BrowserContext;
  return { page, context, frame, resources, send: async (message: string): Promise<void> => {
    if (!receive) throw new Error("Coverage binding was not installed.");
    await receive(message);
  } };
}

describe("browser coverage lifecycle", (): void => {
  it("installs the by-value binding and init script without touching profiler or navigation routes", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, resources } = fixture();
    expect(await newPage(context)).toBe(page);
    expect(page.exposeBinding).toHaveBeenCalledWith(COVERAGE_TRANSPORT.binding, expect.any(Function));
    expect(page.addInitScript).toHaveBeenCalledWith(installBrowserCoverage, COVERAGE_TRANSPORT);
    await close(context);
    expect(resources.every((resource): boolean => vi.mocked(resource.dispose).mock.calls.length === 1)).toBe(true);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(writeUiSnapshot).not.toHaveBeenCalled();
  });

  it("persists each immutable delta once even when delivery is replayed concurrently", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, send } = fixture();
    const id: string = randomUUID();
    await newPage(context);
    await send(JSON.stringify({ kind: "start", documentId: id, sequence: 0 }));
    await Promise.all([send(snapshot(id)), send(snapshot(id))]);
    await close(context);
    expect(writeUiSnapshot).toHaveBeenCalledTimes(1);
    expect(writeUiSnapshot).toHaveBeenCalledWith("coverage/browser/raw", expect.objectContaining({
      id: `${id}:1`, files: expect.objectContaining({ "app/components/probe.tsx": expect.objectContaining({ coverage: expect.objectContaining({ f: { "0": 2 }, b: { "0": [1, 0] } }) }) }),
    }));
  });

  it("awaits final active-frame delivery and disk writes before closing", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, frame, send } = fixture();
    const id: string = randomUUID();
    let release: (() => void) | undefined;
    const held: Promise<void> = new Promise<void>((resolve): void => { release = resolve; });
    vi.mocked(writeUiSnapshot).mockImplementationOnce(async (): Promise<void> => { await held; });
    await newPage(context);
    await send(JSON.stringify({ kind: "start", documentId: id, sequence: 0 }));
    vi.mocked(frame.evaluate).mockImplementationOnce(async (): Promise<void> => { await send(snapshot(id)); });
    const closing: Promise<void> = close(context);
    await Promise.resolve();
    expect(context.close).not.toHaveBeenCalled();
    release?.();
    await closing;
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("fails when a known document never delivers its final snapshot", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, send } = fixture();
    await newPage(context);
    await send(JSON.stringify({ kind: "start", documentId: randomUUID(), sequence: 0 }));
    await expect(close(context)).rejects.toThrow("missing a document's final snapshot");
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("harvests active application frames and does not evaluate unrelated provider frames", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, frame, send } = fixture();
    const childId: string = randomUUID();
    const child = { url: (): string => "http://localhost:5173/embedded", evaluate: vi.fn(async (): Promise<void> => { await send(snapshot(childId)); }) } as unknown as Frame;
    const external = { url: (): string => "https://provider.example/embed", evaluate: vi.fn(async (): Promise<void> => { throw new Error("Script execution is prohibited"); }) } as unknown as Frame;
    page.frames = (): Frame[] => [frame, child, external];
    await newPage(context);
    await send(JSON.stringify({ kind: "start", documentId: childId, sequence: 0 }));
    await close(context);
    expect(child.evaluate).toHaveBeenCalledTimes(1);
    expect(external.evaluate).not.toHaveBeenCalled();
    expect(writeUiSnapshot).toHaveBeenCalledTimes(1);
  });

  it("requires a new final snapshot after BFCache restores an already completed document", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, send } = fixture();
    const id: string = randomUUID();
    await newPage(context);
    await send(JSON.stringify({ kind: "start", documentId: id, sequence: 0 }));
    await send(snapshot(id));
    await send(JSON.stringify({ kind: "start", documentId: id, sequence: 1 }));
    await expect(close(context)).rejects.toThrow("missing a document's final snapshot");
    expect(writeUiSnapshot).toHaveBeenCalledTimes(1);
  });

  it("propagates queued write failures even if the old document cannot receive rejection", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, resources, send } = fixture();
    const error: Error = new Error("Coverage write failed");
    vi.mocked(writeUiSnapshot).mockRejectedValueOnce(error);
    await newPage(context);
    await expect(send(snapshot(randomUUID()))).rejects.toBe(error);
    await expect(close(context)).rejects.toBe(error);
    expect(context.close).toHaveBeenCalledTimes(1);
    await close(page);
    expect(writeUiSnapshot).toHaveBeenCalledTimes(1);
    expect(resources.every((resource): boolean => vi.mocked(resource.dispose).mock.calls.length === 1)).toBe(true);
  });

  it("rejects malformed payloads and browser-side storage failures through the tracked queue", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const first = fixture();
    await newPage(first.context);
    await expect(first.send("not JSON")).rejects.toThrow();
    await expect(close(first.context)).rejects.toThrow();
    const second = fixture();
    await newPage(second.context);
    await expect(second.send(JSON.stringify({ kind: "failure", documentId: randomUUID(), message: "Browser coverage storage failed." }))).rejects.toThrow("Browser coverage storage failed");
    await expect(close(second.context)).rejects.toThrow("Browser coverage storage failed");
    expect(writeUiSnapshot).not.toHaveBeenCalled();
  });

  it("skips only prohibited JavaScript execution and releases setup resources", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, resources } = fixture();
    vi.mocked(page.evaluate).mockRejectedValueOnce(new Error("Script execution is prohibited"));
    await newPage(context);
    await close(context);
    expect(resources.every((resource): boolean => vi.mocked(resource.dispose).mock.calls.length === 1)).toBe(true);
    expect(writeUiSnapshot).not.toHaveBeenCalled();
  });

  it("propagates other setup failures and leaves ordinary runs unchanged", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const first = fixture();
    const error: Error = new Error("Page closed during setup");
    vi.mocked(first.page.evaluate).mockRejectedValueOnce(error);
    await expect(newPage(first.context)).rejects.toBe(error);
    await close(first.context);
    vi.stubEnv("BROWSER_COVERAGE", "0");
    const second = fixture();
    await newPage(second.context);
    await close(second.page);
    expect(second.page.exposeBinding).not.toHaveBeenCalled();
    expect(second.page.evaluate).not.toHaveBeenCalled();
  });
});

function browserFixture(): {
  native: UiCoverage; storage: Map<string, string>; setItem: ReturnType<typeof vi.fn>;
  messages: string[]; emit: (type: string, persisted?: boolean) => void; flush: () => Promise<void>; restart: () => void;
} {
  const storage: Map<string, string> = new Map();
  const listeners: Map<string, EventListener[]> = new Map();
  const native: UiCoverage = counters();
  const messages: string[] = [];
  const setItem = vi.fn((key: string, value: string): void => { storage.set(key, value); });
  vi.stubGlobal("location", { origin: "http://localhost:5173" });
  vi.stubGlobal("sessionStorage", {
    get length(): number { return storage.size; }, key: (index: number): string | null => [...storage.keys()][index] ?? null,
    setItem, getItem: (key: string): string | null => storage.get(key) ?? null,
    removeItem: (key: string): void => { storage.delete(key); },
  });
  vi.stubGlobal("addEventListener", (type: string, listener: EventListener): void => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  });
  vi.stubGlobal("removeEventListener", (type: string, listener: EventListener): void => {
    listeners.set(type, (listeners.get(type) ?? []).filter((value): boolean => value !== listener));
  });
  vi.stubGlobal(COVERAGE_TRANSPORT.flush, undefined);
  vi.stubGlobal(COVERAGE_TRANSPORT.binding, async (payload: string): Promise<void> => { messages.push(payload); });
  vi.stubGlobal(`${COVERAGE_TRANSPORT.prefix}${"a".repeat(64)}`, { [native.path]: native });
  const flush = async (): Promise<void> => {
    const callback = Reflect.get(globalThis, COVERAGE_TRANSPORT.flush) as () => Promise<void>;
    await callback();
  };
  return { native, storage, setItem, messages, flush,
    emit: (type: string, persisted: boolean = false): void => {
      for (const callback of listeners.get(type) ?? []) callback(Object.assign(new Event(type), { persisted }));
    },
    restart: (): void => {
      listeners.clear(); Reflect.set(globalThis, COVERAGE_TRANSPORT.flush, undefined);
      installBrowserCoverage(COVERAGE_TRANSPORT);
    },
  };
}

describe("in-document coverage delivery", (): void => {
  it("backs up immutable deltas synchronously and resets existing counter objects in place", async (): Promise<void> => {
    const browser = browserFixture();
    const statements = browser.native.s;
    const branches = browser.native.b["0"];
    installBrowserCoverage(COVERAGE_TRANSPORT);
    browser.emit("pagehide");
    const payload: string | undefined = [...browser.storage.values()].find((value: string): boolean => "version" in JSON.parse(value));
    expect(payload).toBeDefined();
    expect(JSON.parse(payload as string).files[browser.native.path].coverage).toMatchObject({ s: { "0": 3 }, f: { "0": 2 }, b: { "0": [1, 0] } });
    expect(browser.native.s).toBe(statements);
    expect(browser.native.b["0"]).toBe(branches);
    expect(statements["0"]).toBe(0);
    expect(branches).toEqual([0, 0]);
    await browser.flush();
    expect(browser.storage.size).toBe(0);
  });

  it("replays lost acknowledgements on each new document and prunes backups", async (): Promise<void> => {
    const browser = browserFixture();
    vi.stubGlobal(COVERAGE_TRANSPORT.binding, async (): Promise<void> => { throw new Error("Old context destroyed"); });
    installBrowserCoverage(COVERAGE_TRANSPORT);
    browser.emit("pagehide");
    const backup: string = [...browser.storage.values()].find((value: string): boolean => "version" in JSON.parse(value)) as string;
    vi.stubGlobal(COVERAGE_TRANSPORT.binding, async (payload: string): Promise<void> => { browser.messages.push(payload); });
    browser.restart();
    await vi.waitFor((): void => { expect(browser.storage.size).toBe(0); });
    expect(browser.messages).toContain(backup);
    expect(browser.storage.size).toBe(0);
    browser.native.f["0"] = 4;
    browser.emit("pagehide");
    const second: string = [...browser.storage.values()].find((value: string): boolean => "version" in JSON.parse(value)) as string;
    browser.restart();
    await browser.flush();
    expect(browser.messages).toContain(second);
    expect(JSON.parse(second).files[browser.native.path].coverage.f["0"]).toBe(4);
    expect(browser.storage.size).toBe(0);
  });

  it("does not reset counters when backup storage fails and reports the failure", async (): Promise<void> => {
    const browser = browserFixture();
    installBrowserCoverage(COVERAGE_TRANSPORT);
    browser.setItem.mockImplementationOnce((): void => { throw new Error("Quota exceeded"); });
    expect(() => browser.emit("pagehide")).toThrow("Browser coverage snapshot could not be stored");
    expect(browser.native.f["0"]).toBe(2);
    await expect(browser.flush()).rejects.toThrow("Browser coverage snapshot could not be stored");
    expect(browser.messages.some((message: string): boolean => JSON.parse(message).kind === "failure")).toBe(true);
  });

  it("announces a fresh generation on BFCache restoration", async (): Promise<void> => {
    const browser = browserFixture();
    installBrowserCoverage(COVERAGE_TRANSPORT);
    browser.emit("pagehide");
    browser.emit("pageshow", true);
    await browser.flush();
    const starts = browser.messages.map((message: string) => JSON.parse(message) as Record<string, unknown>)
      .filter((message): boolean => message.kind === "start");
    expect(starts.some((message): boolean => message.sequence === 0)).toBe(true);
    expect(starts.some((message): boolean => message.sequence === 1)).toBe(true);
  });
});
