import { newPage, close } from "./coverage";
import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext, type Page } from "./coverage";
import { z } from "zod";
import { clientAddress } from "./client-ips";

const origin: string = "http://localhost:5173";
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));

async function signedIn(browser: Browser, role: string, options: { width?: number } = {}): Promise<BrowserContext> {
  const sessions = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
  const session = sessions[role];
  if (!session) throw new Error("Unknown test account.");
  const context = await browser.newContext({
    baseURL: origin,
    viewport: options.width ? { width: options.width, height: 844 } : undefined,
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("shell", role === "admin" ? 67 : 66) },
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

// Header labels must remain on one line.
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
  const page = await newPage(context);
  await page.goto("/streamers");
  const toggle = page.getByRole("button", { name: "Account menu for owner" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const menu = page.getByRole("navigation", { name: "Account" });
  await expect(menu).toBeHidden();

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toBeVisible();
  const links = menu.getByRole("link");
  await expect(links.first()).toBeFocused();
  await expect(links).toHaveText([
    "Your page",
    "Streamer tools",
    "Edit your page",
    "Your profile",
    "Your data",
    "Language",
    "Accessibility & display",
    "Suggest an improvement",
  ]);
  await expect(menu.getByRole("link", { name: "Suggest an improvement" })).toHaveAttribute(
    "href",
    "/@streambullets?intent=suggest",
  );
  await expect(menu.getByRole("link", { name: "Your page", exact: true })).toHaveAttribute("href", "/@test_host");
  await expect(menu.getByRole("link", { name: "Your profile" })).toHaveAttribute("href", "/streamers?dialog=profile");
  await expect(menu.getByRole("link", { name: "Edit your page" })).toHaveAttribute("aria-haspopup", "dialog");
  await expect(menu.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.locator(".account-id")).toContainText("Streamer · @test_host");

  await page.keyboard.press("Tab");
  await expect(links.nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeHidden();
  await expect(toggle).toBeFocused();

  await toggle.click();
  await expect(menu).toBeVisible();
  await page.locator("main h1").click();
  await expect(menu).toBeHidden();
  // Closing an account dialog restores the page and avatar focus.
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

  await page.getByRole("button", { name: "Account menu for owner" }).click();
  await expect(
    page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Streamers" }),
  ).toBeVisible();
  await close(context);
});

test("logos go home, the streamer picture goes to its topics, and navigation marks the current page", async ({
  browser,
}) => {
  const context = await signedIn(browser, "admin");
  const page = await newPage(context);
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

  await page.goto("/admin");
  const generic = page.getByRole("banner");
  await expect(generic.getByRole("link", { name: "StreamBullets home" })).toHaveAttribute("href", "/");
  const main = generic.getByRole("navigation", { name: "Main navigation" });
  // The Admin link is in the account menu only.
  await expect(main.getByRole("link", { name: "Admin" })).toHaveCount(0);
  await page.locator("button.profile").click();
  await expect(page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Admin" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.keyboard.press("Escape");
  await expect(main.getByRole("link", { name: "Streamers" })).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "Back to Test host" })).toHaveAttribute("href", "/@test_host");
  await close(context);
});

test("the streamer header offers Tools to the owner of the page only, and the site header has no Tools entry", async ({
  browser,
}) => {
  const owner = await signedIn(browser, "owner");
  const page = await newPage(owner);
  await page.goto("/@test_host");
  const nav = page.getByRole("banner").getByRole("navigation", { name: "Main navigation" });
  // After the page views, with the icon and the label of the other tabs.
  await expect(nav.getByRole("link")).toHaveText(["Topics", "Polls", "Schedule", "About", "Community", "Tools"]);
  const overlay = nav.getByRole("link", { name: "Tools", exact: true });
  await expect(overlay).toHaveAttribute("href", "/tools");
  await expect(overlay).toHaveClass(/nav-tab/);
  await expect(overlay).not.toHaveAttribute("aria-current", "page");
  await expect(overlay.locator("svg")).toBeVisible();
  // The account menu keeps its entry.
  await page.getByRole("button", { name: /^Account menu/ }).click();
  await expect(
    page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Streamer tools" }),
  ).toHaveAttribute("href", "/tools");
  await page.keyboard.press("Escape");
  // On a phone the six tabs are icons in one row. Each is a touch target, without sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/@test_host");
  await expect(overlay).toBeVisible();
  const boxes = await nav.getByRole("link").evaluateAll((links: Element[]) =>
    links.map((link: Element) => {
      const { x, y, width, height } = link.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
  expect(boxes).toHaveLength(6);
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.y).toBe(boxes[0].y);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 720 });
  await overlay.click();
  await expect(page.getByRole("heading", { level: 1, name: "Streamer tools" })).toBeVisible();
  // Streamer tools keeps the streamer header: Tools is the current tab and the other tabs lead to the page.
  await expect(nav.getByRole("link")).toHaveText(["Topics", "Polls", "Schedule", "About", "Community", "Tools"]);
  await expect(overlay).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Polls", exact: true })).toHaveAttribute("href", "/@test_host?view=polls");
  // The site header has no Tools entry. "Your page" stays, also on a phone.
  const site = page.getByRole("banner").getByRole("navigation", { name: "Main navigation" });
  await page.goto("/streamers");
  await expect(site.getByRole("link")).toHaveText(["Streamers", "Your page"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(site.getByRole("link", { name: "Your page", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // The page of another streamer has no Tools entry for this owner.
  await page.goto("/@feature_host");
  await expect(nav.getByRole("link", { name: "Topics", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Tools", exact: true })).toHaveCount(0);
  await close(owner);

  // A signed-in viewer without a page and a guest get no Tools entry.
  const viewer = await signedIn(browser, "viewer");
  const guest = await browser.newContext({ baseURL: origin });
  for (const context of [viewer, guest]) {
    const other = await newPage(context);
    await other.goto("/@test_host");
    const tabs = other.getByRole("banner").getByRole("navigation", { name: "Main navigation" });
    await expect(tabs.getByRole("link")).toHaveText(["Topics", "Polls", "Schedule", "About", "Community"]);
    await close(context);
  }
});

interface TabBox {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  color: string;
  icon: number;
  label: boolean;
}

test("Streamer tools has icon tabs below the header on a phone and text tabs on a desktop, with one title", async ({
  browser,
}) => {
  const owner = await signedIn(browser, "owner", { width: 390 });
  const page = await newPage(owner);
  const sections = page.getByRole("navigation", { name: "Streamer tools sections" });
  const tabs = (): Promise<TabBox[]> =>
    sections.getByRole("link").evaluateAll((links: Element[]): TabBox[] =>
      links.map((link: Element): TabBox => {
        const { x, y, width, height } = link.getBoundingClientRect();
        const style: CSSStyleDeclaration = getComputedStyle(link);
        return {
          x,
          y,
          width,
          height,
          fill: style.backgroundImage,
          color: style.color,
          icon: link.querySelector("svg")?.getBoundingClientRect().width ?? 0,
          label: (link.querySelector(".tools-tab-label")?.getClientRects().length ?? 0) > 0,
        };
      }),
    );
  const bottom = (selector: string): Promise<number> =>
    page.locator(selector).evaluate((element: Element): number => element.getBoundingClientRect().bottom);
  const tokens = (): Promise<{ onGold: string; cream: string }> =>
    page.evaluate((): { onGold: string; cream: string } => {
      const probe: HTMLElement = document.body.appendChild(document.createElement("span"));
      const read = (token: string): string => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color;
      };
      const colors = { onGold: read("--on-gold"), cream: read("--cream") };
      probe.remove();
      return colors;
    });

  await page.goto("/tools");
  await expect(page).toHaveTitle("Streamer tools · StreamBullets");
  // The tabs are one line of equal columns at the full width, directly below the site header.
  const phone: TabBox[] = await tabs();
  expect(phone).toHaveLength(3);
  expect(phone[0].x).toBe(0);
  expect(phone[2].x + phone[2].width).toBeCloseTo(390, 0);
  expect(phone[0].y).toBeCloseTo(await bottom("header.site-header"), 0);
  for (const tab of phone) {
    expect(tab.y).toBe(phone[0].y);
    expect(tab.width).toBeCloseTo(130, 0);
    expect(tab.height).toBeGreaterThanOrEqual(48);
    // Only the icon shows, at 24 px.
    expect(tab.icon).toBe(24);
    expect(tab.label).toBe(false);
  }
  // Each tab has its name for a screen reader and as a tooltip.
  for (const name of ["Live", "Overlay", "Channels"]) {
    const tab = sections.getByRole("link", { name, exact: true });
    await expect(tab).toHaveAttribute("title", name);
    await expect(tab).toBeVisible();
  }
  // The open tab has the gold fill and the dark icon. The other tabs have no fill.
  const colors = await tokens();
  await expect(sections.getByRole("link", { name: "Live" })).toHaveAttribute("aria-current", "page");
  expect(phone[0].fill).toContain("linear-gradient");
  expect(phone[0].color).toBe(colors.onGold);
  expect(phone[1].fill).toBe("none");
  expect(phone[1].color).toBe(colors.cream);
  // The title is the name of the open section. The name of the page and the line above it do not show. The head
  // has one title at each width. A card of the overlay in a preview has its own heading, so look in the head.
  const title = page.locator(".ov-head").getByRole("heading", { level: 1 });
  await expect(title).toHaveCount(1);
  await expect(title).toHaveAccessibleName("Live");
  await expect(page.locator(".ov-head .eyebrow")).toBeHidden();
  await expect(page.locator("h1 .tools-page-name")).toBeHidden();
  expect(await title.evaluate((element: Element): number => element.getBoundingClientRect().top)).toBeGreaterThan(
    phone[0].y + phone[0].height,
  );
  expect(await page.evaluate((): number => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // The keyboard reaches each tab, and the focus ring shows inside the tab.
  const overlay = sections.getByRole("link", { name: "Overlay" });
  await sections.getByRole("link", { name: "Live" }).focus();
  await page.keyboard.press("Tab");
  await expect(overlay).toBeFocused();
  expect(
    await overlay.evaluate((element: Element): string[] => {
      const style: CSSStyleDeclaration = getComputedStyle(element);
      return [style.outlineStyle, style.outlineWidth];
    }),
  ).toEqual(["solid", "2px"]);
  // A different section: its tab is the open tab and its name is the title. The document does not load again.
  let documents = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest()) documents += 1;
  });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/tools\?view=overlay$/);
  await expect(overlay).toHaveAttribute("aria-current", "page");
  await expect(sections.getByRole("link", { name: "Live" })).not.toHaveAttribute("aria-current", "page");
  await expect(title).toHaveAccessibleName("Overlay");
  await expect(title).toHaveCount(1);
  await expect(page).toHaveTitle("Streamer tools · StreamBullets");
  expect(documents).toBe(0);
  // The tabs stay below the header while the page scrolls.
  const pinned: number = (await tabs())[0].y;
  await page.locator("main").evaluate((main: Element): void => main.scrollTo(0, 600));
  await expect.poll(() => page.locator("main").evaluate((main: Element): number => main.scrollTop)).toBeGreaterThan(0);
  expect((await tabs())[0].y).toBe(pinned);
  // A phone on its side has little height: there the tabs scroll with the page.
  await page.setViewportSize({ width: 640, height: 360 });
  await page.locator("main").evaluate((main: Element): void => main.scrollTo(0, 0));
  const start: number = (await tabs())[0].y;
  await page.locator("main").evaluate((main: Element): void => main.scrollTo(0, 300));
  await expect.poll(async (): Promise<number> => (await tabs())[0].y).toBeLessThan(start);

  // A desktop has the text tabs and the name of the page as the title.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/tools?view=channels");
  await expect(title).toHaveAccessibleName("Streamer tools");
  await expect(title).toHaveCount(1);
  await expect(page.locator(".ov-head .eyebrow")).toBeVisible();
  await expect(sections.getByRole("link")).toHaveText(["Live", "Overlay", "Channels"]);
  const desktop: TabBox[] = await tabs();
  for (const tab of desktop) {
    expect(tab.label).toBe(true);
    expect(tab.icon).toBe(0);
    expect(tab.height).toBeGreaterThanOrEqual(44);
    expect(tab.y).toBe(desktop[0].y);
  }
  // The tabs are below the title, as before.
  expect(desktop[0].y).toBeGreaterThan(await bottom(".ov-head h1"));
  await expect(sections.getByRole("link", { name: "Channels" })).toHaveAttribute("aria-current", "page");
  await close(owner);
});

test("the old Overlay control address opens Streamer tools", async ({ browser }) => {
  const owner = await signedIn(browser, "owner");
  const page = await newPage(owner);
  await page.goto("/overlay-control");
  await expect(page).toHaveURL(/\/tools\?view=overlay$/);
  await expect(page.getByRole("heading", { level: 1, name: "Streamer tools" })).toBeVisible();
  // An old channel callback link opens the Channels section.
  await page.goto("/overlay-control?channel=kick&result=denied");
  await expect(page.getByRole("region", { name: "Connect channels" })).toBeVisible();
  await expect(page).toHaveURL(/\/tools\?view=channels$/);
  await close(owner);
});

test("the Streamers, language and notification controls of the header have equal visible gaps", async ({ browser }) => {
  // The gap of the controls is 8px up to a width of 1800px, and 16px above it.
  for (const width of [1440, 1920]) {
    const owner = await signedIn(browser, "owner", { width });
    const page = await newPage(owner);
    await page.goto("/@test_host");
    const end = page.getByRole("banner").locator(".header-end");
    const edge = async (selector: string, side: "left" | "right"): Promise<number> => {
      const box = (await end.locator(selector).boundingBox())!;
      return side === "left" ? box.x : box.x + box.width;
    };
    // From visible edge to visible edge: the border of Streamers, the globe and the code of the language button,
    // the notification icon, and the avatar.
    const gaps: number[] = [
      (await edge("button.header-language svg", "left")) - (await edge("a.header-streamers", "right")),
      (await edge("button.notification-nav svg", "left")) - (await edge(".header-language-code", "right")),
      (await edge(".account-menu-wrap > button .user-avatar", "left")) - (await edge("button.notification-nav svg", "right")),
    ];
    for (const gap of gaps) {
      expect(gap, `${width}px: ${gaps.join(", ")}`).toBeGreaterThan(0);
      expect(Math.abs(gap - gaps[0]), `${width}px: ${gaps.join(", ")}`).toBeLessThanOrEqual(2);
    }
    await close(owner);
  }
});

test("headers keep every label on one line at 390px", async ({ browser }) => {
  const context = await signedIn(browser, "admin", { width: 390 });
  const page = await newPage(context);
  for (const path of ["/@test_host", "/streamers", "/admin", "/privacy", "/missing/page"]) {
    await page.goto(path);
    await expect(page.getByRole("banner")).toBeVisible();
    await headerLabelsDoNotWrap(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
  await close(context);
});

test("the compact footer keeps touch controls at desktop and phone widths", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/@test_host");
  const footer = page.getByRole("contentinfo");
  const desktop = (await footer.boundingBox())!;
  expect(desktop.height).toBeGreaterThanOrEqual(44);
  expect(Math.round(desktop.y + desktop.height)).toBe(900);
  await expect(footer.getByRole("link", { name: "Streamers" })).toBeVisible();
  await expect(footer.getByRole("button", { name: "Contact" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const phone = (await footer.boundingBox())!;
  expect(phone.height).toBeGreaterThanOrEqual(44);
  const targets = await footer.locator("a:visible, button:visible").evaluateAll((elements: Element[]) =>
    elements.map((element: Element) => {
      const box: DOMRect = element.getBoundingClientRect();
      return { width: box.width, height: box.height, top: box.top, bottom: box.bottom };
    }),
  );
  for (const target of targets) {
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.top).toBeGreaterThanOrEqual(phone.y + 4);
    expect(target.bottom).toBeLessThanOrEqual(phone.y + phone.height - 4);
  }
  expect(Math.round(phone.y + phone.height)).toBe(844);
  await footer.getByRole("button", { name: "More" }).click();
  const more = page.getByRole("dialog", { name: "More" });
  await expect(more.getByRole("link", { name: "Report content" })).toHaveAttribute("href", "/terms#reporting");
  await more.getByRole("button", { name: "Contact" }).click();
  await expect(page.getByRole("dialog", { name: "Contact us" })).toBeVisible();
});

test("the 404 page has the site header, a streamer search and a way on", async ({ page }) => {
  const response = await page.goto("/no/such/page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("banner").getByRole("link", { name: "StreamBullets home" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Streamers" })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search streamers" }).fill("feature");
  await page.getByRole("button", { name: "Search streamers" }).click();
  await expect(page).toHaveURL(/\/streamers\?query=feature$/u);
  await page.goBack();
  await expect(page.getByRole("main").getByRole("link", { name: "Browse streamers" })).toHaveAttribute(
    "href",
    "/streamers",
  );
  await expect(page.getByRole("contentinfo")).toBeVisible();
});

test("the Contact dialog copies the support address", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await newPage(context);
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

  // Without clipboard access, select the address for manual copying.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });
  await opener.click();
  await dialog.getByRole("button", { name: "Copy address" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Press Ctrl+C or ⌘C to copy.");
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("support@streambullets.com");
  await close(context);
});
