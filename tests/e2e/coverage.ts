import { test as base, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export { expect } from "@playwright/test";
export type { APIRequestContext, Browser, BrowserContext, CDPSession, Page } from "@playwright/test";

const pages: Set<Page> = new Set();


async function start(page: Page): Promise<void> {
  if (process.env.BROWSER_COVERAGE !== "1") return;
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  pages.add(page);
}

async function collect(page: Page): Promise<void> {
  if (!pages.has(page)) return;
  const entries = await page.coverage.stopJSCoverage();
  await mkdir("coverage/browser/raw", { recursive: true });
  await writeFile(`coverage/browser/raw/${randomUUID()}.json`, JSON.stringify(entries));
  pages.delete(page);
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
  page: async ({ page }, use): Promise<void> => {
    await start(page);
    await use(page);
    await collect(page);
  },
  coverage: [async ({ browser: _browser }, use): Promise<void> => {
    await use();
    for (const page of pages) await collect(page);
  }, { auto: true }],
});
