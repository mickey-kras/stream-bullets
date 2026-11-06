import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";

const origin: string = "http://localhost:5173";
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));

async function signedIn(browser: Browser, role: string, options: { width?: number } = {}): Promise<BrowserContext> {
  const sessions = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
  const session = sessions[role];
  if (!session) throw new Error("Unknown test account.");
  const context = await browser.newContext({
    baseURL: origin,
    viewport: options.width ? { width: options.width, height: 844 } : undefined,
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${60 + role.length}` },
  });
  await context.addCookies([
    {
      name: "stream-bullets.session_token",
      value: session.cookie,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return context;
}

/** Every visible text label in the header sits on one line (a label never breaks mid-way). */
async function headerLabelsDoNotWrap(page: Page): Promise<void> {
  const wrapped: string[] = await page.locator("header").evaluate((header: Element) => {
    const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
    const found: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text: string = node.textContent?.trim() ?? "";
      if (!text || !node.parentElement || node.parentElement.closest("[hidden]")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect: DOMRect) => rect.width > 0);
      if (new Set(rects.map((rect: DOMRect) => Math.round(rect.top))).size > 1) found.push(text);
    }
    return found;
  });
  expect(wrapped).toEqual([]);
}

test("the account menu is a keyboard-operable disclosure of links", async ({ browser }) => {
  const context = await signedIn(browser, "owner");
  const page = await context.newPage();
  await page.goto("/streamers");
  const toggle = page.getByRole("button", { name: "Account menu for owner" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const menu = page.getByRole("navigation", { name: "Account" });
  await expect(menu).toBeHidden();

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toBeVisible();
  // Focus moves to the first link; the owner's own page comes first, then the account rows.
  const links = menu.getByRole("link");
  await expect(links.first()).toBeFocused();
  await expect(links).toHaveText(["Your page", "Edit your page", "Your profile", "Your data"]);
  await expect(menu.getByRole("link", { name: "Your page", exact: true })).toHaveAttribute("href", "/@test_host");
  // Account rows open dialogs over the current page (item 17).
  await expect(menu.getByRole("link", { name: "Your profile" })).toHaveAttribute("href", "/streamers?dialog=profile");
  await expect(menu.getByRole("link", { name: "Edit your page" })).toHaveAttribute("aria-haspopup", "dialog");
  await expect(menu.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.locator(".account-id")).toContainText("Streamer · @test_host");

  // Tab walks the rows; Escape closes and returns focus to the avatar.
  await page.keyboard.press("Tab");
  await expect(links.nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeHidden();
  await expect(toggle).toBeFocused();

  // A click outside closes it; following a row navigates and closes it.
  await toggle.click();
  await expect(menu).toBeVisible();
  await page.locator("main h1").click();
  await expect(menu).toBeHidden();
  // A dialog row opens the dialog; closing it goes back to the page and the avatar gets focus.
  await toggle.click();
  await menu.getByRole("link", { name: "Your profile" }).click();
  const profile = page.getByRole("dialog", { name: "Your profile" });
  await expect(profile).toBeVisible();
  await expect(page).toHaveURL(/\/streamers\?dialog=profile$/);
  await profile.getByRole("button", { name: "Close dialog" }).click();
  await expect(profile).toBeHidden();
  await expect(page).toHaveURL(/\/streamers$/);
  await expect(toggle).toBeFocused();
  await toggle.click();
  await menu.getByRole("link", { name: "Your page", exact: true }).click();
  await expect(page).toHaveURL(/\/@test_host$/);
  await expect(page.getByRole("navigation", { name: "Account" })).toBeHidden();

  // On a streamer page the menu also offers Streamers.
  await page.getByRole("button", { name: "Account menu for owner" }).click();
  await expect(
    page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Streamers" }),
  ).toBeVisible();
  await context.close();
});

test("logos go home, the streamer picture goes to its topics, and navigation marks the current page", async ({
  browser,
}) => {
  const context = await signedIn(browser, "admin");
  const page = await context.newPage();
  await page.goto("/@test_host?view=polls");
  const banner = page.getByRole("banner");
  await expect(banner.getByRole("link", { name: "StreamBullets home" })).toHaveAttribute("href", "/");
  await expect(banner.getByRole("link", { name: "Test host home" })).toHaveAttribute("href", "/@test_host");
  const tabs = banner.getByRole("navigation", { name: "Main navigation" });
  await expect(tabs.getByRole("link", { name: "Polls" })).toHaveAttribute("aria-current", "page");
  await expect(tabs.locator('[aria-current="page"]')).toHaveCount(1);
  await tabs.getByRole("link", { name: "About" }).click();
  await expect(page).toHaveURL(/view=about/);
  await expect(tabs.getByRole("link", { name: "About" })).toHaveAttribute("aria-current", "page");

  // The generic header: logo home, Streamers and Admin, with Admin current on the admin page.
  await page.goto("/admin");
  const generic = page.getByRole("banner");
  await expect(generic.getByRole("link", { name: "StreamBullets home" })).toHaveAttribute("href", "/");
  const main = generic.getByRole("navigation", { name: "Main navigation" });
  await expect(main.getByRole("link", { name: "Admin" })).toHaveAttribute("aria-current", "page");
  await expect(main.getByRole("link", { name: "Streamers" })).not.toHaveAttribute("aria-current", "page");
  // The back link returns to the last streamer page.
  await expect(page.getByRole("link", { name: "Back to Test host" })).toHaveAttribute("href", "/@test_host");
  await context.close();
});

test("headers keep every label on one line at 390px", async ({ browser }) => {
  const context = await signedIn(browser, "admin", { width: 390 });
  const page = await context.newPage();
  for (const path of ["/@test_host", "/streamers", "/admin", "/privacy", "/missing/page"]) {
    await page.goto(path);
    await expect(page.getByRole("banner")).toBeVisible();
    await headerLabelsDoNotWrap(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
  await context.close();
});

test("the footer sits on the gold frame band: 42px on desktop, 34px on phones", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/@test_host");
  const footer = page.getByRole("contentinfo");
  const desktop = (await footer.boundingBox())!;
  expect(Math.round(desktop.height)).toBe(42);
  expect(Math.round(desktop.y + desktop.height)).toBe(900);
  await expect(footer.getByRole("link", { name: "Streamers" })).toBeVisible();
  await expect(footer.getByRole("button", { name: "Contact" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const phone = (await footer.boundingBox())!;
  expect(Math.round(phone.height)).toBe(34);
  expect(Math.round(phone.y + phone.height)).toBe(844);
  // Phones show Privacy, Terms and More; More holds the rest.
  await footer.getByRole("button", { name: "More" }).click();
  const more = page.getByRole("dialog", { name: "More" });
  await expect(more.getByRole("link", { name: "Report content" })).toHaveAttribute("href", "/terms#reporting");
  await more.getByRole("button", { name: "Contact" }).click();
  await expect(page.getByRole("dialog", { name: "Contact us" })).toBeVisible();
});

test("the 404 page has the site header, a back link and a way on", async ({ page }) => {
  const response = await page.goto("/no/such/page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("banner").getByRole("link", { name: "StreamBullets home" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Streamers" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: "Browse streamers" })).toHaveAttribute(
    "href",
    "/streamers",
  );
  await expect(page.getByRole("contentinfo")).toBeVisible();
});

test("the Contact dialog copies the support address", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.goto("/privacy");
  const opener = page.getByRole("contentinfo").getByRole("button", { name: "Contact" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Contact us" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("support@streambullets.com");
  await dialog.getByRole("button", { name: "Copy address" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("support@streambullets.com");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // Without clipboard access the address is selected so it can be copied by hand.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });
  await opener.click();
  await dialog.getByRole("button", { name: "Copy address" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Press Ctrl+C or ⌘C to copy.");
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("support@streambullets.com");
  await context.close();
});
