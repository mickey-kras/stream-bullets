import { readFileSync } from "node:fs";
import { LOCALES } from "../../db/enums";
import { test, expect } from "./coverage";

for (const locale of LOCALES) {
  const messages: Record<string, string> = JSON.parse(
    readFileSync(new URL(`../../app/i18n/${locale}.json`, import.meta.url), "utf8"),
  ) as Record<string, string>;

  for (const width of [1280, 1363, 1920]) {
    test(`${locale} desktop board keeps text, navigation and empty borders inside their frames at ${width}px`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: 1080 });
      await context.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/" }]);
      await page.goto("/@streambullets?view=topics&status=shipped");
      await expect(page.locator("#detail .empty-state")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const geometry = await page.evaluate(() => {
        const box = (selector: string): DOMRect => document.querySelector(selector)!.getBoundingClientRect();
        const header: DOMRect = box(".ideas-header");
        const nav: DOMRect = box(".ideas-header > nav");
        const panel: DOMRect = box("#detail");
        const card: DOMRect = box("#detail .empty-state");
        const subtitle: HTMLElement = document.querySelector(".ideas-sub")!;
        const lastTab: DOMRect = document.querySelector(".ideas-header > nav > a:last-child")!.getBoundingClientRect();
        const actions: DOMRect[] = [...document.querySelectorAll(".ideas-header > .header-end > *")]
          .filter((element: Element) => element.getClientRects().length > 0)
          .map((element: Element) => element.getBoundingClientRect());
        const range: Range = document.createRange();
        range.selectNodeContents(subtitle);
        const text: DOMRect[] = [...range.getClientRects()];
        const bounds: DOMRect[] = [];
        for (let node: HTMLElement | null = subtitle; node && node !== document.body; node = node.parentElement) {
          if (getComputedStyle(node).overflowX !== "visible") bounds.push(node.getBoundingClientRect());
        }
        return {
          navOffset: Math.abs(nav.x + nav.width / 2 - header.x - header.width / 2),
          leftInset: card.left - panel.left,
          rightInset: panel.right - card.right,
          clipped: bounds.some((clip: DOMRect) =>
            text.some((rect: DOMRect) => rect.left < clip.left - 1 || rect.right > clip.right + 1),
          ),
          actionsOverlap: actions.some(
            (rect: DOMRect) => lastTab.top < rect.bottom && lastTab.bottom > rect.top && lastTab.right > rect.left - 4,
          ),
        };
      });
      expect(geometry.clipped, "the complete subtitle must remain visible").toBe(false);
      expect(geometry.navOffset, "tabs must stay centered in the header").toBeLessThanOrEqual(2);
      expect(geometry.actionsOverlap, "account actions must not overlap the tabs").toBe(false);
      expect(geometry.leftInset).toBeGreaterThanOrEqual(20);
      expect(geometry.rightInset).toBeGreaterThanOrEqual(20);
      expect(
        Math.abs(geometry.leftInset - geometry.rightInset),
        "the complete card border must have equal insets",
      ).toBeLessThanOrEqual(2);
    });
  }

  test(`${locale} desktop landing fallback and disabled sign-in use the page language`, async ({ page, context }) => {
    await page.setViewportSize({ width: 1363, height: 936 });
    await context.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/" }]);
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        value: function (this: HTMLCanvasElement, contextId: string, options?: unknown): RenderingContext | null {
          return contextId.startsWith("webgl") ? null : original.call(this, contextId, options);
        },
      });
    });
    await page.goto("/");
    await expect(page.locator(".station-status")).toHaveText(messages["landing.unavailable"]);
    await expect(page.locator(".station-fallback")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const headingFits: boolean = await page
      .locator("#landing-title")
      .evaluate((heading: HTMLElement): boolean => heading.scrollWidth <= heading.clientWidth + 1);
    expect(headingFits, "the hero heading must fit its column").toBe(true);
    await page.locator(".landing-header button").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(messages["signIn.off"]);
    await expect(dialog).not.toContainText(messages["signIn.description"]);
  });
}
