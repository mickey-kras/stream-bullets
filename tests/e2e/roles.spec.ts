import { newPage, close } from "./coverage";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "./coverage";
import { origin, signedIn } from "./fixtures";
import { clientIp } from "./client-ips";

// Read-only and refused-write role checks preserve shared fixture data.

type Role = "signed-out" | "viewer" | "owner" | "admin" | "frozenowner" | "suspendedowner";

const NO_ID = "00000000-0000-4000-8000-000000000000";

// Each role uses a separate rate-limit IP.
async function contextFor(browser: Browser, role: Role, ip: number): Promise<BrowserContext> {
  if (role !== "signed-out") return signedIn(browser, role, ip);
  return browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${ip}`, Origin: origin },
  });
}

// Admin endpoint statuses and an admin-only write for each role.
async function adminApiStatuses(request: APIRequestContext): Promise<number[]> {
  return Promise.all([
    request.get("/api/admin/streamers").then((response) => response.status()),
    request.get("/api/admin/report-groups").then((response) => response.status()),
    // Missing targets let admins reach 404; other roles fail authorization first.
    request
      .post(`/api/admin/streamers/${NO_ID}`, { data: { action: "unfreeze", reason: "other" } })
      .then((response) => response.status()),
    request
      .post(`/api/admin/entries/${NO_ID}/status`, { data: { status: "planned" } })
      .then((response) => response.status()),
  ]);
}

async function menuRows(page: Page): Promise<string[]> {
  const toggle = page.locator(".account-menu-wrap > button.profile");
  if ((await toggle.count()) === 0) return [];
  await toggle.click();
  const rows = await page.getByRole("navigation", { name: "Account" }).getByRole("link").allTextContents();
  await toggle.click();
  return rows;
}

const OWNER_ROWS = ["Your page", "Overlay control", "Edit your page"];

const matrix: {
  role: Role;
  ip: number;
  admin: number[];
  overlayControl: number;
  adminPage: "sign-in" | "404" | "admin";
  menu: { has: string[]; lacks: string[] };
  ownPage?: string;
}[] = [
  {
    role: "signed-out",
    ip: clientIp("roles", 200),
    admin: [401, 401, 401, 401],
    overlayControl: 200,
    adminPage: "sign-in",
    menu: { has: [], lacks: [] },
  },
  {
    role: "viewer",
    ip: clientIp("roles", 201),
    admin: [403, 403, 403, 403],
    overlayControl: 404,
    adminPage: "404",
    menu: { has: ["Host a community", "Your profile"], lacks: [...OWNER_ROWS, "Admin"] },
  },
  {
    role: "owner",
    ip: clientIp("roles", 202),
    admin: [403, 403, 403, 403],
    overlayControl: 200,
    adminPage: "404",
    menu: { has: OWNER_ROWS, lacks: ["Host a community", "Admin"] },
    ownPage: "test_host",
  },
  {
    role: "admin",
    ip: clientIp("roles", 203),
    admin: [200, 200, 404, 404],
    overlayControl: 404,
    adminPage: "admin",
    menu: { has: ["Admin", "Host a community"], lacks: OWNER_ROWS },
  },
];

for (const row of matrix) {
  test(`role matrix: ${row.role} on the shell routes and admin APIs`, async ({ browser }) => {
    const context = await contextFor(browser, row.role, row.ip);
    const page = await newPage(context);

    expect(await adminApiStatuses(context.request)).toEqual(row.admin);

    // Overlay control: owners only; signed out redirects to /streamers; others get 404.
    const overlay = await page.goto("/overlay-control");
    expect(overlay?.status()).toBe(row.overlayControl);
    if (row.role === "signed-out") await expect(page).toHaveURL(/\/streamers$/);
    if (row.role === "owner")
      await expect(page.getByRole("heading", { level: 1, name: "Overlay control" })).toBeVisible();

    // Admin: sign-in when signed out; 404 for non-admins; tabs for admins.
    const admin = await page.goto("/admin");
    if (row.adminPage === "sign-in")
      await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
    if (row.adminPage === "404") expect(admin?.status()).toBe(404);
    if (row.adminPage === "admin") {
      const sections = page.getByRole("navigation", { name: "Admin sections" });
      await expect(sections.getByRole("link", { name: /Streamer pages|Pages/ })).toBeVisible();
      await expect(sections.getByRole("link", { name: /Content reports|Reports/ })).toBeVisible();
    }

    expect((await page.goto("/streamers"))?.status()).toBe(200);
    const rows = await menuRows(page);
    for (const label of row.menu.has) expect(rows, label).toContain(label);
    for (const label of row.menu.lacks) expect(rows, label).not.toContain(label);
    if (row.role === "signed-out")
      await expect(page.getByRole("banner").getByRole("button", { name: /Sign in/ })).toBeVisible();

    await page.goto("/streamers?dialog=page");
    if (row.role === "signed-out") await expect(page.getByRole("dialog", { name: /Sign in/ })).toBeVisible();
    else if (row.ownPage) {
      const dialog = page.getByRole("dialog", { name: "Edit your page" });
      await expect(dialog.getByLabel("Handle")).toHaveValue(row.ownPage);
      await expect(dialog.locator(".owner-notice")).toHaveCount(0);
    } else await expect(page.getByRole("dialog", { name: "Edit your page" })).toHaveCount(0);
    await close(context);
  });
}

test("role matrix: the streamer page header action and content tools", async ({ browser }) => {
  const anonymous = await browser.newContext({ baseURL: origin });
  const board = await anonymous.request.get("/api/streamers/pagination_host");
  const { entries } = (await board.json()) as { entries: { id: string; title: string }[] };
  const topic = entries.find((entry) => entry.title === "Archive topic 01") ?? entries.at(-1);
  if (!topic) throw new Error("The seeded topics are missing.");
  await close(anonymous);

  // On another page, members suggest and report; admins also remove.
  const tools: Record<"signed-out" | "viewer" | "owner" | "admin", { signedIn: boolean; remove: boolean }> = {
    "signed-out": { signedIn: false, remove: false },
    viewer: { signedIn: true, remove: false },
    owner: { signedIn: true, remove: false },
    admin: { signedIn: true, remove: true },
  };
  for (const [index, role] of (["signed-out", "viewer", "owner", "admin"] as const).entries()) {
    const context = await contextFor(browser, role, clientIp("roles", 204 + index));
    const page = await newPage(context);
    const want = tools[role];
    await page.goto(`/@pagination_host?entry=${topic.id}`);
    await expect(page.locator("#detail").getByRole("heading", { name: topic.title })).toBeVisible();
    const suggest = page.getByRole("button", { name: "Suggest a topic", exact: true });
    await expect(suggest, role).toHaveCount(want.signedIn ? 1 : 0);
    await expect(page.getByRole("button", { name: "Report topic" }), role).toHaveCount(want.signedIn ? 1 : 0);
    await expect(page.getByRole("button", { name: "Delete topic" }), role).toHaveCount(want.remove ? 1 : 0);
    await page.goto("/@pagination_host?view=polls");
    await expect(page.getByRole("button", { name: "New poll" }), role).toHaveCount(0);

    // A signed-in report of a missing item passes authentication; signed out fails.
    const report = await context.request.post("/api/reports", {
      data: { targetKind: "entry", targetId: NO_ID, reason: "spam", details: "" },
    });
    expect(report.status(), role).toBe(role === "signed-out" ? 401 : 404);
    // Keep test_host fixture text unchanged when testing owner edits.
    const edit = await context.request.patch("/api/streamer", { data: { about: "A test community." } });
    expect(edit.status(), role).toBe({ "signed-out": 401, viewer: 404, owner: 200, admin: 404 }[role]);
    await close(context);
  }

  const owner = await signedIn(browser, "owner", clientIp("roles", 208));
  const page = await newPage(owner);
  await page.goto("/@test_host?view=polls");
  await expect(page.getByRole("button", { name: "New poll" }).first()).toBeVisible();
  await close(owner);
});

test("role matrix: Ideas status is for admins only", async ({ browser }) => {
  const anonymous = await browser.newContext({ baseURL: origin });
  const board = await anonymous.request.get("/api/streamers/streambullets");
  const { entries } = (await board.json()) as { entries: { id: string; title: string }[] };
  const idea = entries.find((entry) => entry.title === "Dark mode for the overlay");
  if (!idea) throw new Error("The seeded idea is missing.");
  await close(anonymous);
  for (const [index, role] of (["signed-out", "viewer", "owner", "admin"] as const).entries()) {
    const context = await contextFor(browser, role, clientIp("roles", 210 + index));
    const page = await newPage(context);
    await page.goto(`/@streambullets?entry=${idea.id}`);
    await expect(page.locator("#detail .idea-status")).toBeVisible();
    await expect(page.getByText("Status (admins only)"), role).toHaveCount(role === "admin" ? 1 : 0);
    await close(context);
  }
});

const moderated: {
  role: "frozenowner" | "suspendedowner";
  handle: string;
  ip: number;
  notice: RegExp;
}[] = [
  {
    role: "frozenowner",
    handle: "frozen_host",
    ip: clientIp("roles", 214),
    // Owner notice order: date, reason, effect.
    notice:
      /^Your page was frozen on [A-Z][a-z]{2} \d{1,2}, \d{4}\. Reason: Under review\. Your content stays visible, but no one can post or vote\.$/u,
  },
  {
    role: "suspendedowner",
    handle: "suspended_host",
    ip: clientIp("roles", 215),
    notice:
      /^Your page was suspended on [A-Z][a-z]{2} \d{1,2}, \d{4}\. Reason: Repeated spam\. It's hidden from the public until the suspension is lifted\.$/u,
  },
];

for (const row of moderated) {
  test(`role matrix: the ${row.role} sees the notice on the page, in the menu and in Edit your page`, async ({
    browser,
  }) => {
    const context = await signedIn(browser, row.role, row.ip);
    const page = await newPage(context);
    expect((await page.goto(`/@${row.handle}`))?.status()).toBe(200);
    await expect(page.locator("#page-banner > span")).toHaveText(row.notice);
    await expect(page.locator("#page-banner").getByRole("button", { name: "Appeal / contact us" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Suggest a topic", exact: true })).toBeDisabled();
    expect((await context.request.patch("/api/streamer", { data: { about: "Let me back in" } })).status()).toBe(423);

    // The account menu repeats the notice and marks the avatar.
    const toggle = page.getByRole("button", { name: `Account menu for ${row.role}. Your page needs attention.` });
    await expect(toggle.locator(".notice-dot")).toBeAttached();
    await toggle.click();
    await expect(page.locator(".account-menu .owner-notice")).toHaveText(row.notice);
    await toggle.click();

    await page.goto(`/@${row.handle}?dialog=page`);
    const dialog = page.getByRole("dialog", { name: "Edit your page" });
    await expect(dialog.locator(".owner-notice")).toHaveText(row.notice);
    await close(context);
  });
}

test("role matrix: frozen and suspended pages for everyone else", async ({ browser }) => {
  for (const [index, role] of (["signed-out", "viewer", "owner", "admin"] as const).entries()) {
    const context = await contextFor(browser, role, clientIp("roles", 216 + index));
    const page = await newPage(context);
    expect((await page.goto("/@frozen_host"))?.status(), role).toBe(200);
    const banner = page.locator("#page-banner");
    if (role === "admin") {
      await expect(banner).toContainText("This page is frozen. Nobody can post or vote.");
      await expect(banner.getByRole("link", { name: "Open moderation" })).toHaveAttribute("href", "/admin?view=pages");
      // Unfreeze opens the moderation sheet in place.
      await banner.getByRole("button", { name: "Unfreeze" }).click();
      await expect(page.getByRole("dialog", { name: "Unfreeze @frozen_host?" })).toBeVisible();
      await page.keyboard.press("Escape");
    } else
      await expect(banner).toHaveText("This page is frozen. Viewing only — no new posts, votes, or polls right now.");
    await expect(page.locator(".owner-notice")).toHaveCount(0);
    const suspended = await page.goto("/@suspended_host");
    expect(suspended?.status(), role).toBe(role === "admin" ? 200 : 404);
    if (role === "admin") await expect(banner).toContainText("This page is suspended and hidden from the public.");
    // Only owners see the owner notice and attention marker.
    if (role !== "signed-out")
      await expect(page.getByRole("button", { name: /Your page needs attention/ })).toHaveCount(0);
    await close(context);
  }
});
