import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { origin, signedIn } from "./fixtures";

const shots: string | undefined = process.env.P7_SCREENSHOTS;

async function inLanguage(context: BrowserContext, locale: string): Promise<void> {
  await context.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/", sameSite: "Lax" }]);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  // Wait for the page to settle; a capture during a layout change can fail in headless Chromium.
  await page.waitForLoadState("networkidle");
  // Screenshots are review artefacts, not assertions: a second try covers a busy GPU process.
  await page
    .screenshot({ path: `${shots}/${name}.png`, animations: "disabled" })
    .catch(() => page.screenshot({ path: `${shots}/${name}.png`, animations: "disabled", timeout: 10_000 }));
}

test("Accept-Language picks the page language and Intl follows it", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: origin,
    locale: "de-DE",
    extraHTTPHeaders: { "Accept-Language": "de-AT,de;q=0.9" },
  });
  const page = await context.newPage();
  const response = await page.goto("/streamers");
  expect(response?.headers()["content-language"]).toBe("de");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page).toHaveTitle("Streamer · StreamBullets");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Datenschutz" })).toBeVisible();
  // Hydration loaded the same catalog: client-rendered text is German too.
  await page.getByRole("contentinfo").getByRole("link", { name: "Barrierefreiheit" }).click();
  await expect(page.getByRole("dialog", { name: "Barrierefreiheit & Anzeige" })).toBeVisible();
  await context.close();
});

test("the language switcher saves the choice and reloads in it", async ({ page, context }) => {
  await page.goto("/streamers");
  await page.getByRole("contentinfo").getByRole("link", { name: "Language: English" }).click();
  const dialog = page.getByRole("dialog", { name: "Language" });
  await expect(dialog.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Русский" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect((await context.cookies()).find((cookie) => cookie.name === "sb_locale")?.value).toBe("ru");
  // Back to English through the same switcher.
  await page.getByRole("contentinfo").getByRole("link", { name: "Язык: Русский" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("a signed-in choice is saved to the account and wins over the cookie", async ({ browser }) => {
  const viewer = await signedIn(browser, "prefsviewer", 180);
  const page = await viewer.newPage();
  await page.goto("/streamers?dialog=language");
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/me/locale"));
  await page.getByRole("dialog").getByRole("button", { name: "Français" }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  // Another browser with the same account and a different cookie still gets French.
  const other = await signedIn(browser, "prefsviewer", 181);
  await inLanguage(other, "pl");
  const second = await other.newPage();
  await second.goto("/streamers");
  await expect(second.locator("html")).toHaveAttribute("lang", "fr");
  // Forget the saved language again so other specs see English.
  await second.evaluate(() =>
    fetch("/api/me/locale", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: null }),
    }),
  );
  await other.close();
  await viewer.close();
});

test("Japanese, Chinese and Hindi never use an uppercase transform", async ({ browser }) => {
  for (const [locale, transform] of [
    ["en", "uppercase"],
    ["ja", "none"],
    ["zh-CN", "none"],
    ["hi", "none"],
  ] as const) {
    const context = await browser.newContext({ baseURL: origin });
    await inLanguage(context, locale);
    const page = await context.newPage();
    await page.goto("/streamers");
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const eyebrow = page.locator(".eyebrow").first();
    expect(await eyebrow.evaluate((element) => getComputedStyle(element).textTransform)).toBe(transform);
    await context.close();
  }
});

test("legal pages stay in English with a translated binding notice", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin });
  await inLanguage(context, "de");
  const page = await context.newPage();
  await page.goto("/terms");
  await expect(page.getByRole("note").filter({ hasText: "Die englische Fassung ist verbindlich." })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Automated agents and AI" })).toBeAttached();
  await context.close();
});

test("the For AI agents page counts one vote per visitor per day", async ({ page, request }) => {
  await page.goto("/ai");
  await expect(page.getByRole("heading", { level: 1, name: "For AI agents" })).toBeVisible();
  const interest = page.getByRole("region", { name: "Should AI agents take part?" });
  const before = await (await request.get("/api/ai-interest")).json();
  await interest.getByRole("button", { name: "Agent vote: in favor" }).click();
  await expect(interest.getByRole("button", { name: "Agent vote: in favor" })).toBeDisabled();
  await expect(interest).toContainText(String(before.totals.up + 1));
  await interest.getByRole("button", { name: "Agents: vote via API" }).click();
  await expect(interest.locator("#ai-api")).toContainText("POST /api/ai-interest");
  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toContain("Disallow: /api/");
  expect(await (await request.get("/llms.txt")).text()).toContain("# StreamBullets");
});

test("streamer pages carry JSON-LD for search engines and agents", async ({ page }) => {
  await page.goto("/@test_host");
  const blocks: unknown[] = (await page.locator('script[type="application/ld+json"]').allTextContents()).map(
    (text: string) => JSON.parse(text),
  );
  expect(blocks).toContainEqual(expect.objectContaining({ "@type": "Person", alternateName: "@test_host" }));
  await page.goto("/");
  const site = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent()) ?? "{}");
  expect(site["@graph"].map((node: { "@type": string }) => node["@type"])).toEqual(["WebSite", "Organization"]);
});

test("German and Russian fit a 390 px phone", async ({ browser }) => {
  for (const locale of ["de", "ru"]) {
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 } });
    await inLanguage(context, locale);
    const page = await context.newPage();
    for (const [name, path] of [
      ["streamers", "/streamers"],
      ["streamer", "/@test_host"],
      ["polls", "/@test_host?view=polls"],
      ["ai", "/ai"],
    ] as const) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${locale} ${path}`).toBeLessThanOrEqual(0);
      await shot(page, `${locale}-390-${name}`);
    }
    await page.goto("/streamers?dialog=a11y");
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, `${locale}-390-preferences`);
    await context.close();
  }
});
