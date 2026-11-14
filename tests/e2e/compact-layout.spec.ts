import { close, expect, newPage, test } from "./coverage";
import { clientIp } from "./client-ips";
import { signedIn } from "./fixtures";

const widths: readonly number[] = [320, 390, 768, 1050, 1440];
for (const [languageIndex, locale] of ["en", "de"].entries()) {
  for (const [index, width] of widths.entries()) {
    test(`${locale} compact board keeps the toolbar, scrolling list and footer within ${width}px`, async ({ browser }) => {
      const context = await signedIn(browser, "viewer", clientIp("compact-layout", 220 + languageIndex * widths.length + index), {
        viewport: { width, height: 844 },
        hasTouch: true,
      });
      await context.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/" }]);
      try {
        const page = await newPage(context);
        await page.goto("/@pagination_host?view=topics&sort=newest");
        await page.evaluate(() => document.fonts.ready);
        const header = page.locator(".streamer-header");
        const headerBox = await header.boundingBox();
        expect(headerBox?.height).toBeLessThanOrEqual(160);
        const tabs = header.locator(".nav-tab");
        await expect(tabs).toHaveCount(5);
        if (width <= 1050) {
          for (const tab of await tabs.all()) {
            await expect(tab.locator(".nav-label")).toBeHidden();
            await expect(tab).toHaveAttribute("aria-label", /\S/);
          }
        }
        const toolbar = page.locator(".list-toolbar");
        const action = toolbar.locator(".suggest-topic");
        const sort = await toolbar.locator(".sort-switch").boundingBox();
        const actionBox = await action.boundingBox();
        expect(sort).not.toBeNull();
        expect(actionBox).not.toBeNull();
        expect(Math.abs((actionBox?.y ?? 0) - (sort?.y ?? 0))).toBeLessThanOrEqual(4);
        const toolbarBox = await toolbar.boundingBox();
        expect(actionBox?.x).toBeGreaterThan(sort!.x + sort!.width);
        expect(actionBox!.x + actionBox!.width).toBeCloseTo(toolbarBox!.x + toolbarBox!.width, 0);
        await expect(page.locator("button.fab")).toHaveCount(0);
        const list = page.locator("#topics");
        expect(await list.evaluate((element: HTMLElement) => element.clientHeight)).toBeGreaterThan(100);
        await list.focus();
        await list.press("End");
        await expect.poll(() => list.evaluate((element: HTMLElement) => element.scrollTop)).toBeGreaterThan(0);
        const footer = page.getByRole("contentinfo");
        const footerBox = await footer.boundingBox();
        expect(footerBox?.height).toBeLessThanOrEqual(60);
        expect(footerBox!.y + footerBox!.height).toBeCloseTo(844, 0);
        const mainBox = await page.getByRole("main").boundingBox();
        expect(mainBox!.y + mainBox!.height).toBeCloseTo(footerBox!.y, 0);
        expect(await page.evaluate(() => getComputedStyle(document.body, "::before").content)).toBe("none");
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await action.click();
        await expect(page.getByRole("dialog")).toBeVisible();
      } finally {
        await close(context);
      }
    });
  }
}

test("loaded topics switch before the route response and the latest selection wins", async ({ browser }) => {
  const context = await signedIn(browser, "viewer", clientIp("compact-layout", 230));
  const page = await newPage(context);
  let release!: () => void;
  const gate: Promise<void> = new Promise<void>((resolve) => { release = resolve; });
  let intercepted: boolean = false;
  try {
    await page.goto("/@pagination_host?view=topics&sort=newest");
    await page.route("**/*.data?*", async (route) => {
      intercepted = true;
      await gate;
      await route.continue();
    });
    await page.locator("#topics .topic", { hasText: "Archive topic 54" }).click({ noWaitAfter: true });
    await expect.poll(() => intercepted).toBe(true);
    await expect(page.locator("#detail .detail-title")).toHaveText("Archive topic 54");
    await page.locator("#topics .topic", { hasText: "Archive topic 53" }).click({ noWaitAfter: true });
    await expect(page.locator("#detail .detail-title")).toHaveText("Archive topic 53");
    release();
    await expect(page).toHaveURL(/entry=/);
    await expect(page.locator("#topics .topic.selected")).toContainText("Archive topic 53");
    await expect(page.locator("#detail .detail-title")).toHaveText("Archive topic 53");
  } finally {
    release();
    await close(context);
  }
});
