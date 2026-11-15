import {
  test as base,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Route,
} from "@playwright/test";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export { expect } from "@playwright/test";
export type { APIRequestContext, Browser, BrowserContext, CDPSession, Page } from "@playwright/test";

interface PageCoverage {
  pending: Promise<void>;
  closing: boolean;
  route: (route: Route) => Promise<void>;
}

const pages: Map<Page, PageCoverage> = new Map();

async function save(page: Page): Promise<void> {
  const entries: Awaited<ReturnType<Page["coverage"]["stopJSCoverage"]>> = await page.coverage.stopJSCoverage();
  await mkdir("coverage/browser/raw", { recursive: true });
  const file: string = `coverage/browser/raw/${randomUUID()}.json`;
  await writeFile(`${file}.tmp`, JSON.stringify(entries));
  await rename(`${file}.tmp`, file);
}

// Document mocks must checkpoint before fulfilling or continuing past the collector's route.
export async function checkpointNavigation(page: Page, resume: () => Promise<void>): Promise<void> {
  const state: PageCoverage | undefined = pages.get(page);
  if (!state || state.closing) {
    await resume();
    return;
  }
  state.pending = state.pending.then(async (): Promise<void> => {
    try {
      await save(page);
      await page.coverage.startJSCoverage({ resetOnNavigation: true });
    } finally {
      await resume();
    }
  });
  await state.pending;
}

async function start(page: Page): Promise<void> {
  if (process.env.BROWSER_COVERAGE !== "1") return;
  try {
    await page.coverage.startJSCoverage({ resetOnNavigation: true });
  } catch (error: unknown) {
    // JavaScript-disabled contexts have no script execution to measure.
    if (error instanceof Error && error.message.includes("Script execution is prohibited")) return;
    throw error;
  }
  const state: PageCoverage = {
    pending: Promise.resolve(),
    closing: false,
    route: async (route: Route): Promise<void> => {
      const request = route.request();
      // The first blank target has no product code; profiling it while its navigation is paused can stall.
      if (!state.closing && request.isNavigationRequest() && request.frame() === page.mainFrame() && page.url() !== "about:blank") {
        // Flush before the document unloads: Chromium can discard old-context execution counts.
        await checkpointNavigation(page, () => route.fallback());
      } else await route.fallback();
    },
  };
  await page.route("**/*", state.route);
  pages.set(page, state);
}

async function collect(page: Page): Promise<void> {
  const state: PageCoverage | undefined = pages.get(page);
  if (!state) return;
  if (!state.closing) {
    state.closing = true;
    state.pending = state.pending.then(async (): Promise<void> => {
      await page.unroute("**/*", state.route);
      await save(page);
      pages.delete(page);
    });
  }
  await state.pending;
}

export async function newPage(context: BrowserContext | Browser, options?: BrowserContextOptions): Promise<Page> {
  const page: Page = await context.newPage(options);
  await start(page);
  return page;
}

export async function close(target: BrowserContext | Page): Promise<void> {
  const targets: Page[] = "pages" in target ? target.pages() : [target];
  for (const page of targets) await collect(page);
  await target.close();
}

export const test = base.extend<{ coverage: void }>({
  page: async ({ page }, use, testInfo): Promise<void> => {
    await start(page);
    await use(page);
    for (const error of testInfo.errors) console.error(error.message ?? error.value);
    await collect(page);
  },
  coverage: [
    async ({ browser: _browser }, use): Promise<void> => {
      await use();
      for (const page of pages.keys()) await collect(page);
    },
    { auto: true },
  ],
});
