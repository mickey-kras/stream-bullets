import { readFileSync } from "node:fs";
import { newPage, close } from "./coverage";
import { expect, test, type BrowserContext, type Page } from "./coverage";
import { origin, signedIn } from "./fixtures";
import { clientIp } from "./client-ips";

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
  const page = await newPage(context);
  const response = await page.goto("/streamers");
  expect(response?.headers()["content-language"]).toBe("de");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page).toHaveTitle("Streamer · StreamBullets");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Datenschutz" })).toBeVisible();
  // Hydration loaded the same catalog: client-rendered text is German too.
  await page.getByRole("contentinfo").getByRole("link", { name: "Barrierefreiheit" }).click();
  await expect(page.getByRole("dialog", { name: "Barrierefreiheit & Anzeige" })).toBeVisible();
  await close(context);
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
  const viewer = await signedIn(browser, "prefsviewer", clientIp("i18n", 180));
  const page = await newPage(viewer);
  await page.goto("/streamers?dialog=language");
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/me/locale"));
  await page.getByRole("dialog").getByRole("button", { name: "Français" }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  // Another browser with the same account and a different cookie still gets French.
  const other = await signedIn(browser, "prefsviewer", clientIp("i18n", 181));
  await inLanguage(other, "pl");
  const second = await newPage(other);
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
  await close(other);
  await close(viewer);
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
    const page = await newPage(context);
    await page.goto("/streamers");
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const eyebrow = page.locator(".eyebrow").first();
    expect(await eyebrow.evaluate((element) => getComputedStyle(element).textTransform)).toBe(transform);
    await close(context);
  }
});

test("legal pages stay in English with a translated binding notice", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin });
  await inLanguage(context, "de");
  const page = await newPage(context);
  await page.goto("/terms");
  await expect(page.getByRole("note").filter({ hasText: "Die englische Fassung ist verbindlich." })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Automated agents and AI" })).toBeAttached();
  await close(context);
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

/**
 * What does not fit a phone: sideways page scroll, and visible text cut off sideways by its own box, a clipping
 * ancestor or the screen edge. Chip rows and tab strips scroll sideways by design, and visually hidden text is
 * for screen readers, so neither counts.
 */
async function phoneProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const sideways: number = document.documentElement.scrollWidth - window.innerWidth;
    if (sideways > 0) found.push(`the page scrolls sideways by ${sideways}px`);
    const clipper = (element: Element): Element | "scrolls" | null => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).overflowX === "visible") continue;
        if (node.matches(".filter-chips, .reason-chips, .topic-chips, .tabs, .status-tabs")) return "scrolls";
        return node;
      }
      return null;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text: string = node.textContent?.trim() ?? "";
      const element: HTMLElement | null = node.parentElement;
      if (!text || !element?.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      if (getComputedStyle(element).textOverflow === "ellipsis" || element.getBoundingClientRect().width <= 2) continue;
      const clip = clipper(element);
      if (clip === "scrolls") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect: DOMRect) => rect.width > 0 && rect.height > 0);
      if (rects.length === 0) continue;
      const box = clip?.getBoundingClientRect();
      const left: number = Math.max(0, box?.left ?? 0) - 1;
      const right: number = Math.min(window.innerWidth, box?.right ?? window.innerWidth) + 1;
      if (rects.some((rect: DOMRect) => rect.left < left || rect.right > right))
        found.push(`"${text.slice(0, 40)}" is cut off`);
    }
    return found;
  });
}

/** One phone screen: who looks at it, where, and what to open there first. */
interface PhoneScreen {
  name: string;
  path: string;
  open?: (page: Page) => Promise<void>;
}

/** Opens the tab's primary action (New poll, Add event, Add card): the header button, the FAB or the add tile. */
const headerAction = async (page: Page): Promise<void> =>
  page.locator("#suggest:visible, button.fab:visible, button.add-card-tile").first().click();

const phoneScreens: { role: string | null; ip: number; screens: PhoneScreen[] }[] = [
  {
    role: null,
    ip: clientIp("i18n", 232),
    screens: [
      { name: "home", path: "/" },
      { name: "streamers", path: "/streamers" },
      { name: "streamer", path: "/@test_host" },
      { name: "polls", path: "/@test_host?view=polls" },
      { name: "schedule", path: "/@feature_host?view=schedule" },
      { name: "community", path: "/@feature_host?view=community" },
      { name: "about", path: "/@feature_host?view=about" },
      { name: "ideas", path: "/@streambullets" },
      { name: "frozen", path: "/@frozen_host" },
      { name: "privacy", path: "/privacy" },
      { name: "terms", path: "/terms" },
      { name: "ai", path: "/ai" },
      { name: "preferences", path: "/streamers?dialog=a11y" },
      { name: "language", path: "/streamers?dialog=language" },
      { name: "sign-in", path: "/streamers?dialog=profile" },
      {
        name: "contact",
        path: "/streamers",
        open: async (page) => {
          await page.locator(".footer-compact .footer-link").click();
          await page.locator(".more-list li").first().getByRole("button").click();
        },
      },
    ],
  },
  {
    role: "reporter",
    ip: clientIp("i18n", 233),
    screens: [
      { name: "account-menu", path: "/streamers", open: (page) => page.locator("button.profile").click() },
      { name: "profile", path: "/streamers?dialog=profile" },
      { name: "data", path: "/streamers?dialog=data" },
      { name: "host", path: "/streamers?dialog=host" },
      { name: "suggest-topic", path: "/@test_host?intent=suggest" },
      { name: "suggest-idea", path: "/@streambullets?intent=suggest" },
      {
        name: "report",
        path: "/@feature_host?view=topics",
        open: async (page) => {
          await page.locator("#topics a, #topics button").filter({ hasText: "Mic shootout" }).first().click();
          await page.locator("#detail .content-actions button").last().click();
        },
      },
    ],
  },
  {
    role: "featureowner",
    ip: clientIp("i18n", 234),
    screens: [
      { name: "edit-page", path: "/@feature_host?dialog=page" },
      { name: "overlay-control", path: "/overlay-control" },
      { name: "create-poll", path: "/@feature_host?view=polls", open: headerAction },
      { name: "add-event", path: "/@feature_host?view=schedule", open: headerAction },
      { name: "add-card", path: "/@feature_host?view=community", open: headerAction },
    ],
  },
  {
    role: "admin",
    ip: clientIp("i18n", 235),
    screens: [
      { name: "admin-requests", path: "/admin" },
      { name: "admin-reports", path: "/admin?view=reports" },
      { name: "admin-keys", path: "/admin?view=keys" },
      {
        name: "admin-moderate",
        path: "/admin?view=pages",
        open: (page) => page.locator("article button.danger").first().click(),
      },
    ],
  },
];

for (const locale of ["de", "ru"])
  for (const group of phoneScreens)
    test(`${locale === "de" ? "German" : "Russian"} fits a 390 px phone: ${group.role ?? "signed out"}`, async ({
      browser,
    }) => {
      test.setTimeout(90_000);
      const options = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
      const phone = group.role
        ? await signedIn(browser, group.role, group.ip, options)
        : await browser.newContext({
            baseURL: origin,
            ...options,
            extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${group.ip}` },
          });
      await inLanguage(phone, locale);
      const page = await newPage(phone);
      for (const screen of group.screens) {
        await page.goto(screen.path);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await screen.open?.(page);
        if (screen.path.includes("dialog=") || screen.path.includes("intent=") || screen.open)
          await expect(page.locator("[role=dialog], .account-menu:not([hidden])").last()).toBeVisible();
        expect(await phoneProblems(page), `${locale} ${screen.name}`).toEqual([]);
        await shot(page, `${locale}-390-${screen.name}`);
      }
      await close(phone);
    });

for (const locale of ["en", "de", "es", "fr", "pl", "pt-BR", "ru", "uk", "hi", "zh-CN", "ja"]) {
  test(`${locale} distinguishes the official board and preserves navigation when switching`, async ({ browser }) => {
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 } });
    await inLanguage(context, locale);
    const page = await newPage(context);
    await page.goto("/@streambullets?view=about");
    const about = page.locator('.streamer-header nav a[aria-current="page"]');
    const catalog: Record<string, string> = JSON.parse(readFileSync(new URL(`../../app/i18n/${locale}.json`, import.meta.url), "utf8")) as Record<string, string>;
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(about.locator(".nav-label")).toHaveText(catalog["ideas.aboutTab"]);
    expect(await phoneProblems(page)).toEqual([]);
    await page.goto("/@streambullets?view=topics&status=planned&sort=top#main-content");
    const canonical: string | null = await page.locator('link[rel="canonical"]').getAttribute("href");
    await page.locator('footer a[href*="dialog=language"]:visible').click();
    const target: string = locale === "en" ? "Русский" : "English";
    await page.getByRole("dialog").getByRole("button", { name: target, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", locale === "en" ? "ru" : "en");
    const url = new URL(page.url());
    expect(url.pathname).toBe("/@streambullets");
    expect(url.searchParams.get("view")).toBe("topics");
    expect(url.searchParams.get("status")).toBe("planned");
    expect(url.searchParams.get("sort")).toBe("top");
    expect(url.hash).toBe("#main-content");
    expect(url.searchParams.has("dialog")).toBe(false);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonical ?? "");
    await close(context);
  });
}
