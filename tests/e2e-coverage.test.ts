import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Frame, Page, Route } from "@playwright/test";
import { checkpointNavigation, close, newPage } from "./e2e/coverage";
import { rename, writeFile } from "node:fs/promises";

vi.mock("@playwright/test", () => ({ test: { extend: vi.fn() }, expect: vi.fn() }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), rename: vi.fn(), writeFile: vi.fn() }));

describe("browser coverage lifecycle", (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  function fixture(): { context: BrowserContext; page: Page; calls: string[]; navigate: (commit?: () => void) => Promise<void> } {
    const calls: string[] = [];
    const frame = {} as Frame;
    let handler: ((route: Route) => Promise<void>) | undefined;
    const page = {
      coverage: {
        startJSCoverage: vi.fn(async (): Promise<void> => {
          calls.push("start");
        }),
        stopJSCoverage: vi.fn(async () => {
          calls.push("stop");
          return [];
        }),
      },
      close: vi.fn(async (): Promise<void> => {
        calls.push("close");
      }),
      mainFrame: (): Frame => frame,
      route: vi.fn(async (_url: string, value: (route: Route) => Promise<void>): Promise<void> => {
        handler = value;
      }),
      unroute: vi.fn(async (): Promise<void> => undefined),
    } as unknown as Page;
    const context = {
      newPage: vi.fn(async (): Promise<Page> => page),
      pages: (): Page[] => [page],
      close: vi.fn(async (): Promise<void> => {
        calls.push("close");
      }),
    } as unknown as BrowserContext;
    return { context, page, calls, navigate: async (commit?: () => void): Promise<void> => {
      if (!handler) throw new Error("Coverage navigation handler is not installed.");
      await handler({
        request: () => ({ isNavigationRequest: (): boolean => true, frame: (): Frame => frame }),
        fallback: async (): Promise<void> => {
          calls.push("fallback");
          commit?.();
        },
      } as unknown as Route);
    } };
  }

  it("starts before navigation and saves coverage before closing a context", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, calls } = fixture();
    expect(await newPage(context)).toBe(page);
    expect(calls).toEqual(["start"]);
    expect(page.coverage.startJSCoverage).toHaveBeenCalledWith({ resetOnNavigation: true });
    expect(page.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    await close(context);
    expect(calls).toEqual(["start", "stop", "close"]);
    expect(writeFile).toHaveBeenCalledWith(expect.stringMatching(/^coverage\/browser\/raw\/.+\.json\.tmp$/), "[]");
    const file: string = vi.mocked(writeFile).mock.calls[0][0] as string;
    expect(rename).toHaveBeenCalledWith(file, file.slice(0, -4));
    expect(vi.mocked(writeFile).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(rename).mock.invocationCallOrder[0]);
    expect(page.unroute).toHaveBeenCalledWith("**/*", expect.any(Function));
  });

  it("saves executed and unexecuted ranges before navigation destroys the old context", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, calls, navigate } = fixture();
    const entries: Awaited<ReturnType<Page["coverage"]["stopJSCoverage"]>> = [{
      url: "http://localhost:5173/assets/coverage-probe.js", scriptId: "probe", source: "function probe() {}",
      functions: [{ functionName: "probe", isBlockCoverage: true, ranges: [
        { startOffset: 0, endOffset: 19, count: 1 },
        { startOffset: 17, endOffset: 18, count: 0 },
      ] }],
    }];
    vi.mocked(page.coverage.stopJSCoverage).mockImplementationOnce(async () => {
      calls.push("stop");
      return entries;
    });
    await newPage(context);
    await navigate((): void => {
      expect(writeFile).toHaveBeenCalledWith(expect.any(String), JSON.stringify(entries));
      expect(calls).toEqual(["start", "stop", "start", "fallback"]);
      entries.length = 0;
    });
    await close(context);
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(writeFile).mock.calls[0][1]).toContain('"count":1');
    expect(vi.mocked(writeFile).mock.calls[0][1]).toContain('"count":0');
    expect(calls).toEqual(["start", "stop", "start", "fallback", "stop", "close"]);
  });

  it("checkpoints a document mock that bypasses the installed route", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, calls } = fixture();
    await newPage(context);
    await checkpointNavigation(page, async (): Promise<void> => {
      calls.push("fulfill");
      expect(rename).toHaveBeenCalledTimes(1);
    });
    expect(calls).toEqual(["start", "stop", "start", "fulfill"]);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(1);
    await close(context);
    expect(calls).toEqual(["start", "stop", "start", "fulfill", "stop", "close"]);
  });

  it("serializes overlapping navigation flushes and final collection before close", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, calls, navigate } = fixture();
    let release: (() => void) | undefined;
    const held: Promise<void> = new Promise<void>((resolve): void => { release = resolve; });
    vi.mocked(page.coverage.stopJSCoverage).mockImplementationOnce(async () => {
      calls.push("stop");
      await held;
      return [];
    });
    await newPage(context);
    const first: Promise<void> = navigate();
    const second: Promise<void> = navigate();
    const closing: Promise<void> = close(context);
    await Promise.resolve();
    expect(calls).toEqual(["start", "stop"]);
    release?.();
    await Promise.all([first, second, closing]);
    expect(calls).toEqual(["start", "stop", "start", "fallback", "stop", "start", "fallback", "stop", "close"]);
    expect(writeFile).toHaveBeenCalledTimes(3);
    expect(page.unroute).toHaveBeenCalledTimes(1);
  });

  it("skips collection when the context prohibits script execution", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, calls } = fixture();
    vi.mocked(page.coverage.startJSCoverage).mockRejectedValueOnce(
      new Error("coverage.startJSCoverage: Protocol error (Debugger.enable): Script execution is prohibited"),
    );
    expect(await newPage(context)).toBe(page);
    await close(context);
    expect(page.coverage.stopJSCoverage).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(calls).toEqual(["close"]);
  });

  it("propagates other coverage startup errors", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page } = fixture();
    const error: Error = new Error("Target page has been closed");
    vi.mocked(page.coverage.startJSCoverage).mockRejectedValueOnce(error);
    await expect(newPage(context)).rejects.toBe(error);
    await close(context);
    expect(page.coverage.stopJSCoverage).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("leaves ordinary browser runs unchanged", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "0");
    const { context, page, calls } = fixture();
    await newPage(context);
    await checkpointNavigation(page, async (): Promise<void> => { calls.push("fulfill"); });
    await close(page);
    expect(calls).toEqual(["fulfill", "close"]);
    expect(page.route).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
