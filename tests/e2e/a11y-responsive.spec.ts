import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { applyMigrations, migrationFiles } from "../helpers/database";
import { type Locator, type Page } from "@playwright/test";
import { LOCALES } from "../../db/enums";
import { test, expect } from "./coverage";

const WIDTHS = [320, 390, 430, 768, 1024, 1366, 1920] as const;
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
      const verticalBox: DOMRect = (element.matches("h2") ? element.closest('[role="dialog"]') : null)?.getBoundingClientRect() ?? box;
      const range: Range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()].some((text: DOMRect): boolean =>
        text.width > 0 && (text.left < box.left - 1 || text.right > box.right + 1 ||
          text.top < verticalBox.top - 1 || text.bottom > verticalBox.bottom + 1),
      );
    }).map((element: Element): string => element.textContent ?? element.tagName),
  );
  expect(clipped).toEqual([]);
}

async function expectHeaderFits(page: Page): Promise<void> {
  const controls: Locator = page.locator("header nav > a, header nav > button, header .header-end > .gold, header .header-end .profile, header .landing-brand");
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
    test.setTimeout(90_000);
    for (const route of ["/", "/streamers", "/@streambullets", "/privacy", "/terms", "/ai"]) {
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
          expect(await page.evaluate((): boolean => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
          await expectContained(page.locator("header, main, .site-footer, .page-title, #landing-title"));
          await expectHeaderFits(page);
          if (route === "/") {
            const headerOverlapsTitle: boolean = await page.locator(".landing-header").evaluate((header: HTMLElement): boolean =>
              header.getBoundingClientRect().bottom > document.querySelector("#landing-title")!.getBoundingClientRect().top + 1,
            );
            expect(headerOverlapsTitle).toBe(false);
            const brand: Locator = page.locator(".landing-brand img:visible");
            await expect(brand).toHaveCount(1);
            await expect(brand).toBeInViewport({ ratio: 1 });
            const size = await brand.boundingBox();
            expect(size?.width).toBeGreaterThanOrEqual(32);
            expect(size?.height).toBeGreaterThanOrEqual(32);
            const actions: Locator = page.locator(".landing-actions .button-link");
            await expect(actions).toHaveCount(2);
            await expectLabelsFit(actions);
          }
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

test.describe("configured-provider mobile dialogs", () => {
  const origin: string = "http://localhost:5175";
  let runtime: Miniflare;
  test.setTimeout(90_000);

  test.beforeAll(async (): Promise<void> => {
    runtime = new Miniflare({
      modulesRoot: resolve("build/server"),
      modules: [
        { type: "ESModule", path: resolve("build/server/index.js") },
        ...(await readdir("build/server/assets"))
          .filter((file: string): boolean => file.endsWith(".js"))
          .map((file: string) => ({ type: "ESModule" as const, path: resolve("build/server/assets", file) })),
      ],
      compatibilityDate: "2026-07-01",
      compatibilityFlags: ["nodejs_compat"],
      host: "127.0.0.1",
      port: 5175,
      assets: { directory: resolve("build/client"), routerConfig: { has_user_worker: true } },
      bindings: {
        APP_ORIGIN: origin,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        GOOGLE_CLIENT_ID: "layout-test-client",
        GOOGLE_CLIENT_SECRET: "layout-test-secret",
        TWITCH_CLIENT_ID: "layout-test-client",
        TWITCH_CLIENT_SECRET: "layout-test-secret",
        TIKTOK_CLIENT_KEY: "layout-test-client",
        TIKTOK_CLIENT_SECRET: "layout-test-secret",
        INSTAGRAM_CLIENT_ID: "layout-test-client",
        INSTAGRAM_CLIENT_SECRET: "layout-test-secret",
      },
      d1Databases: ["DB"],
      r2Buckets: ["IMAGES"],
      durableObjects: { POLL_ROOMS: { className: "PollRoom", useSQLite: true } },
      ratelimits: { REQUEST_LIMITER: { namespace_id: "616", simple: { limit: 120, period: 60 } } },
      outboundService: (): never => {
        throw new Error("Mobile layout tests must not contact external services.");
      },
    });
    await applyMigrations((await runtime.getD1Database("DB")) as unknown as D1Database, await migrationFiles());
    await runtime.ready;
  });

  test.afterAll(async (): Promise<void> => {
    await runtime?.dispose();
  });

  for (const locale of LOCALES) {
    test(`${locale} signed-out dialogs remain reachable in portrait and landscape`, async ({ page, context }) => {
      await context.setExtraHTTPHeaders({ "CF-Connecting-IP": `203.0.113.${LOCALES.indexOf(locale) + 1}` });
      await context.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/" }]);
      await page.goto(`${origin}/streamers`);
      for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 768, height: 320 }]) {
        await test.step(`${viewport.width}x${viewport.height}`, async (): Promise<void> => {
          await page.setViewportSize(viewport);
          for (const name of ["language", "a11y"] as const) {
            await page.locator(`.site-footer a[href*="dialog=${name}"]:visible`).click();
            const dialog: Locator = page.locator(`[data-sheet="${name}"]`);
            await expect(dialog).toBeVisible();
            await expectContained(dialog);
            const lastControl: Locator = name === "language" ? dialog.locator(".lang-option").last() : dialog.locator(".sheet-actions .gold");
            await expectReachable(lastControl);
            await expectReachable(dialog.locator(".modal-close"));
            await dialog.locator(".modal-close").click();
            await expect(dialog).toHaveCount(0);
          }
          await openContact(page);
          await expectContained(page.locator('[data-sheet="contact"], .contact-address, .contact-links'));
          await expectReachable(page.locator('[data-sheet="contact"] .modal-close'));
          await page.locator('[data-sheet="contact"] .modal-close').click();
          await page.locator("header .header-signin").click();
          const signIn: Locator = page.getByRole("dialog");
          await expect(signIn).toBeVisible();
          await expectContained(signIn);
          const providers: Locator = signIn.locator(".sign-in-options button");
          await expect(providers).toHaveCount(4);
          await expectLabelsFit(signIn.locator("h2"));
          await expectLabelsFit(providers);
          const consent: Locator = signIn.getByRole("checkbox");
          await consent.scrollIntoViewIfNeeded();
          await expect(consent).toBeInViewport({ ratio: 1 });
          await consent.check();
          for (const provider of await providers.all()) {
            await provider.evaluate((element: Element): void => {
              element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
            });
            await expectReachable(provider);
          }
          await expectReachable(signIn.locator(".modal-close"));
          await signIn.locator(".modal-close").click();
        });
      }
    });

  }
});

for (const locale of LOCALES) {
  test(`${locale} directory search survives a reduced viewport and restores the footer`, async ({ page, context }) => {
    await context.setExtraHTTPHeaders({ "CF-Connecting-IP": `203.0.113.${LOCALES.indexOf(locale) + 30}` });
    await context.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/" }]);
    for (const width of [320, 390, 430, 768]) {
      await test.step(`${width}px reduced-height search`, async (): Promise<void> => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto("/streamers");
        const search: Locator = page.getByRole("searchbox");
        await search.focus();
        await page.setViewportSize({ width, height: 300 });
        await expect(search).toBeInViewport({ ratio: 1 });
        await search.fill("no_matching_mobile_page");
        await search.press("Enter");
        await expect(page).toHaveURL(/query=no_matching_mobile_page/);
        await expect(search).toBeFocused();
        await expect(search).toBeInViewport({ ratio: 1 });
        await expectContained(page.locator("header, main, .site-footer, .directory-search"));
        await page.setViewportSize({ width, height: 844 });
        const language: Locator = page.locator('.site-footer a[href*="dialog=language"]:visible');
        await language.scrollIntoViewIfNeeded();
        await expect(language).toBeInViewport({ ratio: 1 });
      });
    }
  });
}
