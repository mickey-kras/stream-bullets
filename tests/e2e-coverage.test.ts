import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "@playwright/test";
import { close, newPage } from "./e2e/coverage";
import { writeFile } from "node:fs/promises";

vi.mock("@playwright/test", () => ({ test: { extend: vi.fn() }, expect: vi.fn() }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));

describe("browser coverage lifecycle", (): void => {
  afterEach((): void => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  function fixture(): { context: BrowserContext; page: Page; calls: string[] } {
    const calls: string[] = [];
    const page = {
      coverage: {
        startJSCoverage: vi.fn(async (): Promise<void> => { calls.push("start"); }),
        stopJSCoverage: vi.fn(async () => { calls.push("stop"); return []; }),
      },
      close: vi.fn(async (): Promise<void> => { calls.push("close"); }),
    } as unknown as Page;
    const context = {
      newPage: vi.fn(async (): Promise<Page> => page),
      pages: (): Page[] => [page],
      close: vi.fn(async (): Promise<void> => { calls.push("close"); }),
    } as unknown as BrowserContext;
    return { context, page, calls };
  }

  it("starts before navigation and saves coverage before closing a context", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "1");
    const { context, page, calls } = fixture();
    expect(await newPage(context)).toBe(page);
    expect(calls).toEqual(["start"]);
    expect(page.coverage.startJSCoverage).toHaveBeenCalledWith({ resetOnNavigation: false });
    await close(context);
    expect(calls).toEqual(["start", "stop", "close"]);
    expect(writeFile).toHaveBeenCalledWith(expect.stringMatching(/^coverage\/browser\/raw\/.+\.json$/), "[]");
  });

  it("leaves ordinary browser runs unchanged", async (): Promise<void> => {
    vi.stubEnv("BROWSER_COVERAGE", "0");
    const { context, page, calls } = fixture();
    await newPage(context);
    await close(page);
    expect(calls).toEqual(["close"]);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
