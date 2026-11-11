import { type Locator, type Page } from "@playwright/test";
import { LOCALES } from "../../db/enums";
import { test, expect } from "./coverage";

const WIDTHS = [320, 390, 768, 1024, 1366, 1920] as const;
const ENLARGED_WIDTHS = [320, 390] as const;

async function expectContained(locator: Locator): Promise<void> {
  expect(await locator.count()).toBeGreaterThan(0);
  const overflowing: string[] = await locator.evaluateAll((elements: Element[]): string[] =>
    elements
      .filter((element: Element): boolean => {
        const rect: DOMRect = element.getBoundingClientRect();
        return rect.width > 0 &&
          (rect.left < -1 || rect.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1);
      })
      .map((element: Element): string => `${element.tagName}#${element.id}.${element.className}: ${element.scrollWidth}/${element.clientWidth}`),
  );
  expect(overflowing).toEqual([]);
}

async function expectLabelsFit(locator: Locator): Promise<void> {
  const clipped: string[] = await locator.evaluateAll((elements: Element[]): string[] =>
    elements.filter((element: Element): boolean => {
      const box: DOMRect = element.getBoundingClientRect();
      if (!box.width || !box.height) return false;
      const range: Range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()].some((text: DOMRect): boolean =>
        text.width > 0 && (text.left < box.left - 1 || text.right > box.right + 1 ||
          text.top < box.top - 1 || text.bottom > box.bottom + 1),
      );
    }).map((element: Element): string => element.textContent ?? element.tagName),
  );
  expect(clipped).toEqual([]);
}

async function expectHeaderFits(page: Page): Promise<void> {
  const controls: Locator = page.locator("header nav > a, header nav > button, header .header-end > .gold, header .header-end .profile");
  await expectLabelsFit(page.locator("header nav > a, header nav > button, header .header-end > .gold"));
  const overlaps: boolean = await controls.evaluateAll((elements: Element[]): boolean => {
    const boxes: DOMRect[] = elements.map((element: Element): DOMRect => element.getBoundingClientRect())
      .filter((box: DOMRect): boolean => box.width > 0 && box.height > 0);
    return boxes.some((box: DOMRect, index: number): boolean => boxes.slice(index + 1).some((other: DOMRect): boolean =>
      box.left < other.right - 1 && box.right > other.left + 1 && box.top < other.bottom - 1 && box.bottom > other.top + 1,
    ));
  });
  expect(overlaps).toBe(false);
}

async function expectReachable(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport({ ratio: 1 });
  await locator.click({ trial: true });
  const size = await locator.boundingBox();
  expect(size?.width).toBeGreaterThanOrEqual(44);
  expect(size?.height).toBeGreaterThanOrEqual(44);
}

async function openContact(page: Page): Promise<void> {
  const more: Locator = page.locator(".footer-compact .footer-link");
  if (await more.isVisible()) {
    await more.click();
    await page.locator('[data-sheet="more"] .more-list button').click();
  } else {
    await page.locator(".footer-full .footer-link").click();
  }
}

for (const locale of LOCALES) {
  test(`${locale} shared fallback layout and dialogs fit every viewport`, async ({ page, context }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        value: function (this: HTMLCanvasElement, contextId: string, options?: unknown): RenderingContext | null {
          return contextId.startsWith("webgl") ? null : original.call(this, contextId, options);
        },
      });
    });
    await page.setViewportSize({ width: WIDTHS[0], height: 900 });
    await context.setExtraHTTPHeaders({
      "CF-Connecting-IP": `198.51.100.${1 + LOCALES.indexOf(locale) * 8}`,
    });
    await context.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/" }]);
    for (const route of ["/", "/streamers", "/@streambullets", "/privacy"]) {
      const response = await page.goto(route);
      expect(response?.ok(), `${route}: ${response?.status()}`).toBe(true);
      await expect(page.locator("main")).toBeVisible();
      if (route === "/") await expect(page.locator('.landing-station[data-status="unavailable"]')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      for (const width of WIDTHS) {
        await test.step(`${route} at ${width}px`, async () => {
          console.info(`Responsive layout: ${locale} ${route} ${width}px`);
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(() => new Promise<void>((resolve): void => {
            requestAnimationFrame((): void => {
              requestAnimationFrame((): void => resolve());
            });
          }));
          await expectContained(page.locator("header, main, .site-footer, .page-title, #landing-title"));
          await expectHeaderFits(page);
        });
      }
    }
    for (const width of WIDTHS) {
      await test.step(`dialogs at ${width}px`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await openContact(page);
        await expectContained(page.locator('[data-sheet="contact"], .contact-address, .contact-links, .sheet-head h2'));
        await expectReachable(page.locator('[data-sheet="contact"] .modal-close'));
        await page.locator('[data-sheet="contact"] .modal-close').click();
        const displayLink: Locator = page.locator('.site-footer a[href*="dialog=a11y"]:visible');
        await expectReachable(displayLink);
        await displayLink.click();
        await expect(page.locator('[data-sheet="a11y"]')).toBeVisible();
        await expectContained(page.locator('[data-sheet="a11y"], .pref-group, .sheet-head h2'));
        await expectReachable(page.locator('[data-sheet="a11y"] .sheet-actions .gold'));
        await page.locator('[data-sheet="a11y"] .sheet-actions .gold').click();
        await expect(page.locator('[data-sheet="a11y"]')).toHaveCount(0);
      });
    }
  });
}

for (const locale of LOCALES) {
  for (const width of ENLARGED_WIDTHS) {
  test(`${locale} ${width}px enlarged and spaced text keeps dialog controls reachable`, async ({ page, context }) => {
    await context.setExtraHTTPHeaders({
      "CF-Connecting-IP": `198.51.100.${7 + LOCALES.indexOf(locale) * 8 + ENLARGED_WIDTHS.indexOf(width)}`,
    });
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await context.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/" }]);
    await page.goto("/privacy");
    await page.addStyleTag({ content: `html { font-size: 200% !important; } html:root:root * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }` });
    await expectContained(page.locator("header, main, .site-footer"));
    await expectHeaderFits(page);
    await openContact(page);
    await expectContained(page.locator('[data-sheet="contact"], .contact-address, .contact-links'));
    await expectLabelsFit(page.locator('[data-sheet="contact"] .sheet-head h2, .contact-links a'));
    await expectReachable(page.locator('[data-sheet="contact"] .modal-close'));
    await page.locator('[data-sheet="contact"] .modal-close').click();
    await page.locator('.site-footer a[href*="dialog=a11y"]:visible').click();
    const lastOption: Locator = page.locator("#pref-live .choice").last();
    await lastOption.scrollIntoViewIfNeeded();
    await lastOption.click();
    await expect(lastOption.locator("input")).toBeChecked();
    const spacing = await lastOption.evaluate((element: HTMLElement): number => {
      const style: CSSStyleDeclaration = getComputedStyle(element);
      return Number.parseFloat(style.letterSpacing) / Number.parseFloat(style.fontSize);
    });
    expect(spacing).toBeCloseTo(0.12, 2);
    await expectContained(page.locator('[data-sheet="a11y"], .pref-group, .sheet-head h2'));
    const close: Locator = page.locator('[data-sheet="a11y"] .modal-close');
    await expectReachable(close);
    await close.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    const focus = await close.evaluate((element: HTMLElement) => {
      const style: CSSStyleDeclaration = getComputedStyle(element);
      return { width: Number.parseFloat(style.outlineWidth), style: style.outlineStyle };
    });
    expect(focus.width).toBeGreaterThanOrEqual(2);
    expect(focus.style).not.toBe("none");
    const transition: number = await page.locator("#pref-live .cselect-trigger svg").evaluate((element: SVGElement): number =>
      Number.parseFloat(getComputedStyle(element).transitionDuration),
    );
    expect(transition).toBeLessThanOrEqual(0.00001);
    await expectReachable(page.locator('[data-sheet="a11y"] .sheet-actions .gold'));
  });
}
}
