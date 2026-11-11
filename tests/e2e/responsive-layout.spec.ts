import { type Locator, type Page } from "@playwright/test";
import { LOCALES } from "../../db/enums";
import { test, expect } from "./coverage";

async function expectContained(locator: Locator): Promise<void> {
  const overflowing: string[] = await locator.evaluateAll((elements: Element[]): string[] =>
    elements.filter((element: Element): boolean => {
      const rect: DOMRect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1);
    }).map((element: Element): string => `${element.tagName}.${element.className}`),
  );
  expect(overflowing).toEqual([]);
}

async function expectReachable(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport({ ratio: 1 });
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
  for (const width of [320, 390, 768, 1024, 1366, 1920]) {
    test(`${locale} shared layout and dialogs fit ${width}px`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 900 });
      await context.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/" }]);
      for (const route of ["/", "/streamers", "/@streambullets", "/privacy"]) {
        await page.goto(route);
        await page.evaluate(() => document.fonts.ready);
        await expectContained(page.locator("header, main, .site-footer, .page-title, #landing-title"));
      }
      await openContact(page);
      await expectContained(page.locator('[data-sheet="contact"], .contact-address, .contact-links, .sheet-head h2'));
      await expectReachable(page.locator('[data-sheet="contact"] .modal-close'));
      await page.locator('[data-sheet="contact"] .modal-close').click();
      await page.goto("/privacy?dialog=a11y");
      await expect(page.locator('[data-sheet="a11y"]')).toBeVisible();
      await expectContained(page.locator('[data-sheet="a11y"], .pref-group, .sheet-head h2'));
      await expectReachable(page.locator('[data-sheet="a11y"] .sheet-actions .gold'));
    });
  }
}

for (const locale of ["en", "de", "ja", "hi"]) {
  test(`${locale} enlarged and spaced text keeps dialog controls reachable`, async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await context.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/" }]);
    await page.goto("/privacy?dialog=a11y");
    await page.addStyleTag({ content: `html { font-size: 200% !important; } * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }` });
    await expectContained(page.locator('[data-sheet="a11y"], .pref-group, .sheet-head h2'));
    await expectReachable(page.locator('[data-sheet="a11y"] .modal-close'));
    await expectReachable(page.locator('[data-sheet="a11y"] .sheet-actions .gold'));
  });
}
