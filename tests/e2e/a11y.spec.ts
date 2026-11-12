import { newPage, close } from "./coverage";
import { expect, test, type Page } from "./coverage";
import { signedIn } from "./fixtures";
import { clientIp } from "./client-ips";

/*
 * Accessibility checks on every page route. @axe-core/playwright is not a dependency, so these are structural
 * checks: landmarks, one h1, the skip link, named controls, alt text, unique ids and <html lang>.
 */
/* The landing page and its WebGL station have their own keyboard checks in landing.spec.ts. */
const ROUTES: readonly string[] = [
  "/",
  "/streamers",
  "/@test_host",
  "/@test_host?view=polls",
  "/@test_host?view=schedule",
  "/@test_host?view=about",
  "/@test_host?view=community",
  "/@streambullets",
  "/privacy",
  "/terms",
  "/ai",
  "/no-such-page-here",
];

interface Problems {
  unnamed: string[];
  noAlt: number;
  duplicateIds: string[];
}

async function problems(page: Page): Promise<Problems> {
  return page.evaluate((): Problems => {
    const visible = (element: Element): boolean => {
      const box = (element as HTMLElement).getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const name = (element: Element): string =>
      (
        element.getAttribute("aria-label") ??
        (element.getAttribute("aria-labelledby") ?? "")
          .split(" ")
          .map((id: string) => document.getElementById(id)?.textContent ?? "")
          .join(" ") ??
        ""
      ).trim() ||
      (element.textContent ?? "").trim() ||
      (element.getAttribute("title") ?? "").trim();
    const controls = [...document.querySelectorAll("a[href], button, [role=button], [role=link]")].filter(visible);
    const unnamed = controls.filter((element: Element) => !name(element)).map((element: Element) => element.outerHTML);
    const noAlt = [...document.querySelectorAll("img")].filter((image) => !image.hasAttribute("alt")).length;
    const seen = new Set<string>();
    const duplicateIds: string[] = [];
    for (const element of document.querySelectorAll("[id]")) {
      if (seen.has(element.id)) duplicateIds.push(element.id);
      seen.add(element.id);
    }
    return { unnamed: unnamed.slice(0, 5), noAlt, duplicateIds };
  });
}

for (const route of ROUTES) {
  test(`landmarks, names and keyboard entry on ${route}`, async ({ page }) => {
    await page.goto(route);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("main#main-content")).toHaveCount(1);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveCount(1);
    expect(await problems(page)).toEqual({ unnamed: [], noAlt: 0, duplicateIds: [] });
    // The first Tab reaches the skip link, and it moves focus into the page.
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await skip.press("Enter");
    await expect(page).toHaveURL(/#main-content$/);
    await expect(page.getByRole("main")).toBeFocused();
  });
}

test("display preferences apply before the first paint and persist", async ({ page, context }) => {
  // Record <html>'s attributes the moment <body> appears, before anything can paint.
  await page.addInitScript(() => {
    new MutationObserver((_records, observer) => {
      if (!document.body) return;
      const root = document.documentElement;
      (globalThis as unknown as { firstPaintPrefs: Record<string, string | null> }).firstPaintPrefs = {
        text: root.getAttribute("data-text"),
        contrast: root.getAttribute("data-contrast"),
        cvd: root.getAttribute("data-cvd"),
      };
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto("/streamers");
  await page.getByRole("contentinfo").getByRole("link", { name: "Accessibility" }).click();
  const dialog = page.getByRole("dialog", { name: "Accessibility & display" });
  await dialog.getByRole("radio", { name: "130%" }).check();
  await dialog.getByRole("radio", { name: "High contrast" }).check();
  await dialog.getByRole("radio", { name: /Red-green safe/ }).check();
  await expect(page.locator("html")).toHaveAttribute("data-text", "130");
  await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
  await expect(page.locator("html")).toHaveAttribute("data-underline", "true");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  const cookie = (await context.cookies()).find((item) => item.name === "sb_prefs");
  expect(JSON.parse(decodeURIComponent(cookie?.value ?? "{}"))).toMatchObject({ text: "130", contrast: "high" });
  await page.reload();
  expect(await page.evaluate(() => (globalThis as unknown as { firstPaintPrefs: unknown }).firstPaintPrefs)).toEqual({
    text: "130",
    contrast: "high",
    cvd: "pd",
  });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("20.8px");
  // Reset to defaults puts everything back.
  await page.getByRole("contentinfo").getByRole("link", { name: "Accessibility" }).click();
  await page.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-text", "100");
});

test("signed in, display preferences save to the account", async ({ browser }) => {
  const viewer = await signedIn(browser, "prefsviewer", clientIp("a11y", 177));
  const page = await newPage(viewer);
  await page.goto("/streamers?dialog=a11y");
  const dialog = page.getByRole("dialog", { name: "Accessibility & display" });
  await expect(dialog).toContainText("saved to your account");
  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/api/me/preferences") && response.request().method() === "PATCH",
  );
  await dialog.getByRole("checkbox", { name: "Underline all links" }).check();
  expect((await saved).status()).toBe(200);
  // A fresh browser with only the session (no preference cookie) gets the saved settings.
  const other = await signedIn(browser, "prefsviewer", clientIp("a11y", 178));
  const second = await newPage(other);
  await second.goto("/streamers");
  await expect(second.locator("html")).toHaveAttribute("data-underline", "true");
  await second.goto("/streamers?dialog=a11y");
  await second.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(second.locator("html")).toHaveAttribute("data-underline", "false");
  await second.waitForResponse((response) => response.url().endsWith("/api/me/preferences"));
  await close(other);
  await close(viewer);
});

test("the overlay control page enlarges a monitor and collapses Position and size on phones", async ({ browser }) => {
  const owner = await signedIn(browser, "owner", clientIp("a11y", 179));
  const page = await newPage(owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/overlay-control");
  await expect(page.locator(".ov-layout-wrap")).not.toHaveAttribute("open", "");
  const enlarge = page.getByRole("button", { name: "Enlarge the on-air monitor" });
  await enlarge.click();
  await expect(enlarge).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".ov-grid")).toHaveClass(/enlarge-air/);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(page.locator(".ov-layout-wrap")).toHaveAttribute("open", "");
  await close(owner);
});

for (const width of [1363, 390]) {
  test(`language switching keeps the Ideas filter and restores focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 936 });
    await page.goto("/@streambullets?view=topics&status=planned&dialog=language");
    await page.getByRole("dialog").getByRole("button", { name: "Русский" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page).toHaveURL(/\/@streambullets\?view=topics&status=planned$/);
    const language = page.locator('a[href*="dialog=language"]:visible');
    await expect(language).toBeFocused();
    await language.press("Enter");
    await page.getByRole("dialog").getByRole("button", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(language).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Planned", exact: true })).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("link", { name: "StreamBullets home", exact: true })).toHaveAttribute("href", "/");
    await expect(page.getByRole("link", { name: "Ideas for StreamBullets", exact: true })).toHaveAttribute(
      "href",
      "/@streambullets",
    );
  });
}

for (const width of [1363, 390]) {
  test(`account language switching restores the header opener at ${width}px`, async ({ browser }) => {
    const viewer = await signedIn(browser, "prefsviewer", clientIp("a11y", width === 390 ? 175 : 176), {
      viewport: { width, height: 936 },
    });
    const page = await newPage(viewer);
    await page.goto("/@streambullets?view=topics&status=planned");
    const avatar = page.locator(".account-menu-wrap > button.profile");
    for (const [language, locale] of [
      ["Русский", "ru"],
      ["English", "en"],
    ] as const) {
      await avatar.click();
      await page.locator('.account-menu a[href*="dialog=language"]').click();
      await page.getByRole("dialog").getByRole("button", { name: language }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page).toHaveURL(/status=planned$/);
      await expect(avatar).toBeFocused();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    const footerLanguage = page.locator('.site-footer a[href*="dialog=language"]:visible');
    for (const [language, locale] of [
      ["Русский", "ru"],
      ["English", "en"],
    ] as const) {
      await footerLanguage.click();
      await page.getByRole("dialog").getByRole("button", { name: language }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(footerLanguage).toBeFocused();
    }
    await close(viewer);
  });
}

test("display dialog contains keyboard focus and restores its opener", async ({ page }) => {
  await page.goto("/streamers");
  const opener = page.getByRole("contentinfo").getByRole("link", { name: "Accessibility", exact: true });
  await opener.focus();
  await opener.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Accessibility & display" });
  await expect(dialog).toBeVisible();
  for (let index: number = 0; index < 35; index++) {
    await page.keyboard.press("Tab");
    await expect(dialog.locator(":focus")).toHaveCount(1);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  const outline = await opener.evaluate((link: HTMLElement): { style: string; width: number } => {
    const style: CSSStyleDeclaration = getComputedStyle(link);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(2);
});

for (const failure of ["read", "write"] as const) {
  test(`blocked focus storage ${failure} does not break the page or language switching`, async ({ page }) => {
    await page.addInitScript((mode: "read" | "write"): void => {
      if (mode === "read") {
        const getItem = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key: string): string | null {
          if (key === "sb-language-focus") throw new DOMException("Blocked", "SecurityError");
          return getItem.call(this, key);
        };
      } else {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string): void {
          if (key === "sb-language-focus") throw new DOMException("Full", "QuotaExceededError");
          setItem.call(this, key, value);
        };
      }
    }, failure);
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto("/streamers");
    await expect(page.getByRole("heading", { name: "Streamers", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Language: English" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Русский" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.getByRole("main")).toBeVisible();
    expect(errors).toEqual([]);
  });
}
