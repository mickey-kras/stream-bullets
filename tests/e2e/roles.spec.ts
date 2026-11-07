import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { origin, signedIn } from "./fixtures";

/**
 * The cross-phase role matrix (P8): what each kind of account can see and do on the key routes and APIs.
 * Every check here reads, or expects a write to be refused, so the seeded data stays as other specs expect it.
 */

type Role = "signed-out" | "viewer" | "owner" | "admin" | "frozenowner" | "suspendedowner";

const NO_ID = "00000000-0000-4000-8000-000000000000";

/** Each role's browser context. Each role gets its own IP for the rate limiter. */
async function contextFor(browser: Browser, role: Role, ip: number): Promise<BrowserContext> {
  if (role !== "signed-out") return signedIn(browser, role, ip);
  return browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${ip}`, Origin: origin },
  });
}

/** The HTTP status of each admin API for one role, and of a write that every role but admins is refused. */
async function adminApiStatuses(request: APIRequestContext): Promise<number[]> {
  return Promise.all([
    request.get("/api/admin/streamers").then((response) => response.status()),
    request.get("/api/admin/report-groups").then((response) => response.status()),
    // A missing page and a missing idea: admins get past the role check to a 404; everyone else stops at it.
    request
      .post(`/api/admin/streamers/${NO_ID}`, { data: { action: "unfreeze", reason: "other" } })
      .then((response) => response.status()),
    request
      .post(`/api/admin/entries/${NO_ID}/status`, { data: { status: "planned" } })
      .then((response) => response.status()),
  ]);
}

/** Opens the account menu and returns its row labels (none when signed out). */
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
    ip: 200,
    admin: [401, 401, 401, 401],
    overlayControl: 200,
    adminPage: "sign-in",
    menu: { has: [], lacks: [] },
  },
  {
    role: "viewer",
    ip: 201,
    admin: [403, 403, 403, 403],
    overlayControl: 404,
    adminPage: "404",
    menu: { has: ["Host a community", "Your profile"], lacks: [...OWNER_ROWS, "Admin"] },
  },
  {
    role: "owner",
    ip: 202,
    admin: [403, 403, 403, 403],
    overlayControl: 200,
    adminPage: "404",
    menu: { has: OWNER_ROWS, lacks: ["Host a community", "Admin"] },
    ownPage: "test_host",
  },
  {
    role: "admin",
    ip: 203,
    admin: [200, 200, 404, 404],
    overlayControl: 404,
    adminPage: "admin",
    menu: { has: ["Admin", "Host a community"], lacks: OWNER_ROWS },
  },
];

for (const row of matrix) {
  test(`role matrix: ${row.role} on the shell routes and admin APIs`, async ({ browser }) => {
    const context = await contextFor(browser, row.role, row.ip);
    const page = await context.newPage();

    expect(await adminApiStatuses(context.request)).toEqual(row.admin);

    // /overlay-control: owners only. Signed out it sends you to /streamers; others get a 404.
    const overlay = await page.goto("/overlay-control");
    expect(overlay?.status()).toBe(row.overlayControl);
    if (row.role === "signed-out") await expect(page).toHaveURL(/\/streamers$/);
    if (row.role === "owner")
      await expect(page.getByRole("heading", { level: 1, name: "Overlay control" })).toBeVisible();

    // /admin: a sign-in screen signed out, a 404 for non-admins, the admin tabs for admins.
    const admin = await page.goto("/admin");
    if (row.adminPage === "sign-in")
      await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
    if (row.adminPage === "404") expect(admin?.status()).toBe(404);
    if (row.adminPage === "admin") {
      const sections = page.getByRole("navigation", { name: "Admin sections" });
      await expect(sections.getByRole("link", { name: /Streamer pages|Pages/ })).toBeVisible();
      await expect(sections.getByRole("link", { name: /Content reports|Reports/ })).toBeVisible();
    }

    // /streamers and the account menu.
    expect((await page.goto("/streamers"))?.status()).toBe(200);
    const rows = await menuRows(page);
    for (const label of row.menu.has) expect(rows, label).toContain(label);
    for (const label of row.menu.lacks) expect(rows, label).not.toContain(label);
    if (row.role === "signed-out")
      await expect(page.getByRole("banner").getByRole("button", { name: /Sign in/ })).toBeVisible();

    // Edit your page: owners get the dialog with their page; signed out it asks to sign in.
    await page.goto("/streamers?dialog=page");
    if (row.role === "signed-out") await expect(page.getByRole("dialog", { name: /Sign in/ })).toBeVisible();
    else if (row.ownPage) {
      const dialog = page.getByRole("dialog", { name: "Edit your page" });
      await expect(dialog.getByLabel("Handle")).toHaveValue(row.ownPage);
      await expect(dialog.locator(".owner-notice")).toHaveCount(0);
    } else await expect(page.getByRole("dialog", { name: "Edit your page" })).toHaveCount(0);
    await context.close();
  });
}

test("role matrix: the streamer page header action and content tools", async ({ browser }) => {
  const anonymous = await browser.newContext({ baseURL: origin });
  const board = await anonymous.request.get("/api/streamers/pagination_host");
  const { entries } = (await board.json()) as { entries: { id: string; title: string }[] };
  const topic = entries.find((entry) => entry.title === "Archive topic 01") ?? entries.at(-1);
  if (!topic) throw new Error("The seeded topics are missing.");
  await anonymous.close();

  // Someone else's page (pagination_host): signed-in people suggest and report; admins also remove.
  const tools: Record<"signed-out" | "viewer" | "owner" | "admin", { signedIn: boolean; remove: boolean }> = {
    "signed-out": { signedIn: false, remove: false },
    viewer: { signedIn: true, remove: false },
    owner: { signedIn: true, remove: false },
    admin: { signedIn: true, remove: true },
  };
  for (const [index, role] of (["signed-out", "viewer", "owner", "admin"] as const).entries()) {
    const context = await contextFor(browser, role, 204 + index);
    const page = await context.newPage();
    const want = tools[role];
    await page.goto(`/@pagination_host?entry=${topic.id}`);
    await expect(page.locator("#detail").getByRole("heading", { name: topic.title })).toBeVisible();
    const suggest = page.getByRole("button", { name: "Suggest a topic", exact: true });
    await expect(suggest, role).toHaveCount(want.signedIn ? 1 : 0);
    await expect(page.getByRole("button", { name: "Report topic" }), role).toHaveCount(want.signedIn ? 1 : 0);
    await expect(page.getByRole("button", { name: "Delete topic" }), role).toHaveCount(want.remove ? 1 : 0);
    // Only the page owner adds polls.
    await page.goto("/@pagination_host?view=polls");
    await expect(page.getByRole("button", { name: "New poll" }), role).toHaveCount(0);

    // Reports: signed out is refused; a signed-in report of a missing item gets past the sign-in check.
    const report = await context.request.post("/api/reports", {
      data: { targetKind: "entry", targetId: NO_ID, reason: "spam", details: "" },
    });
    expect(report.status(), role).toBe(role === "signed-out" ? 401 : 404);
    // Only a page owner may edit a page. The owner's edit keeps test_host's seeded text.
    const edit = await context.request.patch("/api/streamer", { data: { about: "A test community." } });
    expect(edit.status(), role).toBe({ "signed-out": 401, viewer: 404, owner: 200, admin: 404 }[role]);
    await context.close();
  }

  // The owner's own page offers New poll on the Polls tab.
  const owner = await signedIn(browser, "owner", 208);
  const page = await owner.newPage();
  await page.goto("/@test_host?view=polls");
  await expect(page.getByRole("button", { name: "New poll" }).first()).toBeVisible();
  await owner.close();
});

test("role matrix: Ideas status is for admins only", async ({ browser }) => {
  const anonymous = await browser.newContext({ baseURL: origin });
  const board = await anonymous.request.get("/api/streamers/streambullets");
  const { entries } = (await board.json()) as { entries: { id: string; title: string }[] };
  const idea = entries.find((entry) => entry.title === "Dark mode for the overlay");
  if (!idea) throw new Error("The seeded idea is missing.");
  await anonymous.close();
  for (const [index, role] of (["signed-out", "viewer", "owner", "admin"] as const).entries()) {
    const context = await contextFor(browser, role, 210 + index);
    const page = await context.newPage();
    await page.goto(`/@streambullets?entry=${idea.id}`);
    await expect(page.locator("#detail .idea-status")).toBeVisible();
    await expect(page.getByText("Status (admins only)"), role).toHaveCount(role === "admin" ? 1 : 0);
    await context.close();
  }
});

const moderated: {
  role: "frozenowner" | "suspendedowner";
  handle: string;
  ip: number;
  notice: string;
}[] = [
  {
    role: "frozenowner",
    handle: "frozen_host",
    ip: 214,
    notice: "Your page is frozen. Your content stays visible, but no one can post or vote. Reason: Under review.",
  },
  {
    role: "suspendedowner",
    handle: "suspended_host",
    ip: 215,
    notice:
      "Your page is suspended. It's hidden from the public until the suspension is lifted. Reason: Repeated spam.",
  },
];

for (const row of moderated) {
  test(`role matrix: the ${row.role} sees the notice on the page, in the menu and in Edit your page`, async ({
    browser,
  }) => {
    const context = await signedIn(browser, row.role, row.ip);
    const page = await context.newPage();
    expect((await page.goto(`/@${row.handle}`))?.status()).toBe(200);
    await expect(page.locator("#page-banner")).toContainText(row.notice);
    await expect(page.locator("#page-banner").getByRole("button", { name: "Appeal / contact us" })).toBeVisible();
    // Writes are refused: the header action is off and the API answers 423 Locked.
    await expect(page.getByRole("button", { name: "Suggest a topic", exact: true })).toBeDisabled();
    expect((await context.request.patch("/api/streamer", { data: { about: "Let me back in" } })).status()).toBe(423);

    // R13: the account menu marks the avatar and shows the same notice.
    const toggle = page.getByRole("button", { name: `Account menu for ${row.role}. Your page needs attention.` });
    await expect(toggle.locator(".notice-dot")).toBeAttached();
    await toggle.click();
    await expect(page.locator(".account-menu .owner-notice")).toHaveText(row.notice);
    await toggle.click();

    // Edit your page opens with the notice on top.
    await page.goto(`/@${row.handle}?dialog=page`);
    const dialog = page.getByRole("dialog", { name: "Edit your page" });
    await expect(dialog.locator(".owner-notice")).toHaveText(row.notice);
    await context.close();
  });
}

test("role matrix: frozen and suspended pages for everyone else", async ({ browser }) => {
  for (const [index, role] of (["signed-out", "viewer", "owner", "admin"] as const).entries()) {
    const context = await contextFor(browser, role, 216 + index);
    const page = await context.newPage();
    // Frozen: public and read-only.
    expect((await page.goto("/@frozen_host"))?.status(), role).toBe(200);
    const banner = page.locator("#page-banner");
    if (role === "admin") {
      await expect(banner).toContainText("This page is frozen. Nobody can post or vote.");
      await expect(banner.getByRole("link", { name: "Open moderation" })).toHaveAttribute("href", "/admin");
    } else
      await expect(banner).toHaveText("This page is frozen. Viewing only — no new posts, votes, or polls right now.");
    await expect(page.locator(".owner-notice")).toHaveCount(0);
    // Suspended: hidden from everyone but its owner and admins.
    const suspended = await page.goto("/@suspended_host");
    expect(suspended?.status(), role).toBe(role === "admin" ? 200 : 404);
    if (role === "admin") await expect(banner).toContainText("This page is suspended and hidden from the public.");
    // Nobody but the owner gets the owner's notice or the needs-attention avatar.
    if (role !== "signed-out")
      await expect(page.getByRole("button", { name: /Your page needs attention/ })).toHaveCount(0);
    await context.close();
  }
});
