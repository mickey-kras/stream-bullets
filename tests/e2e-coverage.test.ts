import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, CDPSession, Frame, Page, Route } from "@playwright/test";
import { CDPClient, type CoverageClient } from "monocart-coverage-reports";
import { checkpointNavigation, close, newPage } from "./e2e/coverage";
import { rename, writeFile } from "node:fs/promises";

vi.mock("@playwright/test", () => ({ test: { extend: vi.fn() }, expect: vi.fn() }));
vi.mock("monocart-coverage-reports", () => ({ CDPClient: vi.fn() }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), rename: vi.fn(), writeFile: vi.fn() }));

describe("browser coverage lifecycle", (): void => {
  afterEach((): void => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  function fixture(): { context: BrowserContext; page: Page; client: CoverageClient; session: CDPSession; calls: string[]; navigate: (commit?: () => void) => Promise<void> } {
    const calls: string[] = [];
    const frame = {} as Frame;
    let handler: ((route: Route) => Promise<void>) | undefined;
    const session = {
      detach: vi.fn(async (): Promise<void> => { calls.push("detach"); }),
    } as unknown as CDPSession;
    const client = {
      startJSCoverage: vi.fn(async (): Promise<void> => { calls.push("start"); }),
      stopJSCoverage: vi.fn(async () => { calls.push("stop"); return []; }),
      close: vi.fn(async (): Promise<void> => { await session.detach(); }),
    } as unknown as CoverageClient;
    vi.mocked(CDPClient).mockResolvedValue(client);
    const page = {
      coverage: { startJSCoverage: vi.fn(), stopJSCoverage: vi.fn() },
      context: (): BrowserContext => context,
      close: vi.fn(async (): Promise<void> => {
        calls.push("close");
      }),
      mainFrame: (): Frame => frame,
      url: vi.fn((): string => "http://localhost:5173/"),
      route: vi.fn(async (_url: string, value: (route: Route) => Promise<void>): Promise<void> => {
        handler = value;
      }),
      unroute: vi.fn(async (): Promise<void> => undefined),
    } as unknown as Page;
    const context = {
      newCDPSession: vi.fn(async (): Promise<CDPSession> => session),
      newPage: vi.fn(async (): Promise<Page> => page),
      pages: (): Page[] => [page],
      close: vi.fn(async (): Promise<void> => {
        calls.push("close");
      }),
    } as unknown as BrowserContext;
    return { context, page, client, session, calls, navigate: async (commit?: () => void): Promise<void> => {
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
    const { context, page, client, session, calls } = fixture();
    expect(await newPage(context)).toBe(page);
    expect(context.newCDPSession).toHaveBeenCalledWith(page);
    expect(CDPClient).toHaveBeenCalledWith({ session });
    expect(page.coverage.startJSCoverage).not.toHaveBeenCalled();
    expect(calls).toEqual(["start"]);
    expect(client.startJSCoverage).toHaveBeenCalledWith();
    expect(page.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    await close(context);
    expect(calls).toEqual(["start", "stop", "detach", "close"]);
    expect(writeFile).toHaveBeenCalledWith(expect.stringMatching(/^coverage\/browser\/raw\/.+\.json\.tmp$/), "[]");
    const file: string = vi.mocked(writeFile).mock.calls[0][0] as string;
    expect(rename).toHaveBeenCalledWith(file, file.slice(0, -4));
    expect(vi.mocked(writeFile).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(rename).mock.invocationCallOrder[0]);
    expect(page.unroute).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(session.detach).toHaveBeenCalledTimes(1);
    expect(page.coverage.stopJSCoverage).not.toHaveBeenCalled();
  });

  it("saves executed and unexecuted ranges before navigation destroys the old context", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, client, calls, navigate } = fixture();
    const entries: Awaited<ReturnType<Page["coverage"]["stopJSCoverage"]>> = [{
      url: "http://localhost:5173/assets/coverage-probe.js", scriptId: "probe", source: "function probe() {}",
      functions: [{ functionName: "probe", isBlockCoverage: true, ranges: [
        { startOffset: 0, endOffset: 19, count: 1 },
        { startOffset: 17, endOffset: 18, count: 0 },
      ] }],
    }];
    vi.mocked(client.stopJSCoverage).mockImplementationOnce(async () => {
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
    expect(calls).toEqual(["start", "stop", "start", "fallback", "stop", "detach", "close"]);
  });

  it("does not profile the empty target during its first document navigation", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, client, calls, navigate } = fixture();
    vi.mocked(page.url).mockReturnValue("about:blank");
    await newPage(context);
    await navigate((): void => { vi.mocked(page.url).mockReturnValue("http://localhost:5173/"); });
    expect(calls).toEqual(["start", "fallback"]);
    expect(client.stopJSCoverage).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    await navigate();
    expect(calls).toEqual(["start", "fallback", "stop", "start", "fallback"]);
    await close(context);
    expect(writeFile).toHaveBeenCalledTimes(2);
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
    expect(calls).toEqual(["start", "stop", "start", "fulfill", "stop", "detach", "close"]);
  });

  it("serializes overlapping navigation flushes and final collection before close", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, client, calls, navigate } = fixture();
    let release: (() => void) | undefined;
    const held: Promise<void> = new Promise<void>((resolve): void => { release = resolve; });
    vi.mocked(client.stopJSCoverage).mockImplementationOnce(async () => {
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
    expect(calls).toEqual(["start", "stop", "start", "fallback", "stop", "start", "fallback", "stop", "detach", "close"]);
    expect(writeFile).toHaveBeenCalledTimes(3);
    expect(page.unroute).toHaveBeenCalledTimes(1);
  });

  it("skips collection when the context prohibits script execution", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, client, session, calls } = fixture();
    vi.mocked(client.startJSCoverage).mockRejectedValueOnce(
      new Error("coverage.startJSCoverage: Protocol error (Debugger.enable): Script execution is prohibited"),
    );
    expect(await newPage(context)).toBe(page);
    await close(context);
    expect(client.stopJSCoverage).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(calls).toEqual(["detach", "close"]);
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it("propagates other coverage startup errors", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, client, session } = fixture();
    const error: Error = new Error("Target page has been closed");
    vi.mocked(client.startJSCoverage).mockRejectedValueOnce(error);
    await expect(newPage(context)).rejects.toBe(error);
    expect(session.detach).toHaveBeenCalledTimes(1);
    await close(context);
    expect(client.stopJSCoverage).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("detaches its session if the coverage client cannot be created", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, client, session } = fixture();
    vi.mocked(CDPClient).mockResolvedValueOnce(undefined);
    await expect(newPage(context)).rejects.toThrow("Browser coverage client could not be created.");
    expect(session.detach).toHaveBeenCalledTimes(1);
    expect(client.startJSCoverage).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    await close(context);
  });

  it("detaches its session when final collection fails", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, client, session } = fixture();
    const error: Error = new Error("Coverage collection failed");
    vi.mocked(client.stopJSCoverage).mockRejectedValueOnce(error);
    await newPage(context);
    await expect(close(context)).rejects.toBe(error);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(session.detach).toHaveBeenCalledTimes(1);
    expect(writeFile).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("rejects missing source for nonempty application scripts before publishing coverage", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, client, session } = fixture();
    vi.mocked(client.stopJSCoverage).mockResolvedValueOnce([{
      url: "https://localhost:5174/assets/application.js", source: "",
      functions: [{ functionName: "uncovered", ranges: [{ startOffset: 0, endOffset: 20, count: 0 }] }],
    }]);
    await newPage(context);
    await expect(close(context)).rejects.toThrow("Browser coverage is missing application script source.");
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it("keeps empty scripts and source-less entries outside application assets unchanged", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, client } = fixture();
    const entries: Awaited<ReturnType<CoverageClient["stopJSCoverage"]>> = [
      { url: "http://localhost:5173/assets/empty.js", source: "", functions: [{ ranges: [{ startOffset: 0, endOffset: 0, count: 0 }] }] },
      { url: "https://vendor.example/library.js", functions: [{ ranges: [{ startOffset: 0, endOffset: 20, count: 0 }] }] },
      { url: "", functions: [{ ranges: [{ startOffset: 0, endOffset: 20, count: 1 }] }] },
    ];
    vi.mocked(client.stopJSCoverage).mockResolvedValueOnce(entries);
    await newPage(context);
    await close(context);
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), JSON.stringify(entries));
  });

  it.each(["stop", "restart"] as const)("cleans up after a checkpoint %s failure without collecting again", async (phase: "stop" | "restart"): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, client, session, navigate } = fixture();
    const error: Error = new Error(`Coverage checkpoint ${phase} failed`);
    await newPage(context);
    if (phase === "stop") vi.mocked(client.stopJSCoverage).mockRejectedValueOnce(error);
    else vi.mocked(client.startJSCoverage).mockRejectedValueOnce(error);
    await expect(navigate()).rejects.toBe(error);
    await expect(close(context)).rejects.toBe(error);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(page.unroute).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(session.detach).toHaveBeenCalledTimes(1);
    expect(client.stopJSCoverage).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledTimes(phase === "stop" ? 0 : 1);
    await close(page);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.stopJSCoverage).toHaveBeenCalledTimes(1);
  });

  it("leaves ordinary browser runs unchanged", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "0");
    const { context, page, calls } = fixture();
    await newPage(context);
    await checkpointNavigation(page, async (): Promise<void> => { calls.push("fulfill"); });
    await close(page);
    expect(calls).toEqual(["fulfill", "close"]);
    expect(context.newCDPSession).not.toHaveBeenCalled();
    expect(page.route).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
