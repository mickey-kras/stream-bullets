import { newPage, close } from "./coverage";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type BrowserContext, type CDPSession, type Page } from "./coverage";
import { z } from "zod";
import { clientIp } from "./client-ips";
import { accounts, runSql } from "./fixtures";

// Added admin coverage owns TEST-NET-3 .60–79; existing setup requests retain their allocated IPs.
const origin: string = "http://localhost:5173";
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));
const boardSchema = z.object({ entries: z.array(z.object({ id: z.string(), title: z.string() })) });
const shots: string | undefined = process.env.P6_SCREENSHOTS;

async function signedIn(browser: Browser, role: string, ip: number, mobile = false): Promise<BrowserContext> {
  const sessions = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
  const session = sessions[role];
  if (!session) throw new Error("Unknown test account.");
  const context = await browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${ip}` },
    ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}),
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

// CTAP2 key with a PIN, user verification, and automatic touches.
async function addKey(cdp: CDPSession): Promise<string> {
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "usb",
      hasResidentKey: false,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
}

test("only administrators reach the admin and security-key API", async ({ browser, request }) => {
  for (const path of ["/api/admin/stepup", "/api/admin/keys", "/api/admin/streamers", "/api/admin/report-groups"])
    expect((await request.get(path)).status()).toBe(401);
  const viewer = await signedIn(browser, "viewer", clientIp("admin-keys", 120));
  for (const path of ["/api/admin/stepup", "/api/admin/keys", "/api/admin/streamers", "/api/admin/report-groups"])
    expect((await viewer.request.get(path)).status()).toBe(403);
  const options = await viewer.request.post("/api/admin/stepup/options", { data: {}, headers: { Origin: origin } });
  expect(options.status()).toBe(403);
  await close(viewer);
});

test("an admin sets up two keys, confirms with a key in another session, and moderates", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await signedIn(browser, "keyadmin", clientIp("admin-keys", 121));
  const page = await newPage(context);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const first = await addKey(cdp);

  await page.goto("/admin");
  await expect(page.getByText("Security keys aren't set up yet.")).toBeVisible();
  await page.getByRole("link", { name: "Set up security keys" }).click();
  await expect(page.getByRole("heading", { name: "Add your first key" })).toBeVisible();
  await expect(page.locator(".key-steps [aria-current=step]")).toHaveText(/Add your first key/);
  await shot(page, "keys-setup-first");
  await context.setExtraHTTPHeaders({ Origin: origin, "CF-Connecting-IP": "203.0.113.62" });
  await page.evaluate(() => {
    Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true });
  });
  await page.getByRole("button", { name: "Register this key" }).click();
  await expect(page.getByRole("alert")).toContainText("This browser can't use security keys.");
  await page.reload();
  await page.route(
    "**/api/admin/keys/options",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "The request failed. Please try again." },
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Register this key" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The request failed. Please try again." })).toBeVisible();
  await expect(page.getByLabel("Key name")).toHaveValue("YubiKey – desk");
  await page.getByRole("button", { name: "Register this key" }).click();
  await expect(page.getByRole("heading", { name: "Add a backup key" })).toBeVisible();

  // Keep the first credential while registering the backup authenticator.
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId: first });
  expect(credentials).toHaveLength(1);
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: first });
  const backup = await addKey(cdp);
  await expect(page.getByLabel("Key name")).toHaveValue("YubiKey – safe");
  await page.getByRole("button", { name: "Register this key" }).click();
  await expect(page.getByRole("article", { name: "YubiKey – safe" })).toBeVisible();
  await expect(page.getByRole("article", { name: "YubiKey – desk" })).toBeVisible();
  await page.getByRole("link", { name: "Streamer requests" }).click();
  await expect(page.getByRole("heading", { name: /^Admin\s*:\s*Streamer requests$/ })).toBeVisible();
  await expect(page.getByText("Security keys aren't set up yet.")).toHaveCount(0);
  await page.getByRole("link", { name: "Security keys" }).click();
  await page.getByRole("button", { name: "Rename YubiKey – desk" }).click();
  await page.getByRole("dialog").getByLabel("Key name").fill("YubiKey – keyring");
  await page.route(
    "**/api/admin/keys/*",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "The request failed. Please try again." },
      }),
    { times: 1 },
  );
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("The request failed. Please try again.");
  await expect(page.getByRole("dialog").getByLabel("Key name")).toHaveValue("YubiKey – keyring");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Renamed" })).toHaveText(
    "Renamed the key to YubiKey – keyring.",
  );
  await expect(page.getByRole("article", { name: "YubiKey – keyring" })).toBeVisible();
  await shot(page, "keys-tab");

  // A second session of the same account needs its own key check.
  const other = await signedIn(browser, "keyadmin2", clientIp("admin-keys", 122));
  const second = await newPage(other);
  const otherCdp = await other.newCDPSession(second);
  await otherCdp.send("WebAuthn.enable");
  const restored = await addKey(otherCdp);
  await otherCdp.send("WebAuthn.addCredential", { authenticatorId: restored, credential: credentials[0] });
  await second.goto("/admin?view=pages");
  await expect(second.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await expect(second.getByRole("article", { name: "Room 48" })).toHaveCount(0);
  await shot(second, "stepup-gate");
  await other.setExtraHTTPHeaders({ Origin: origin, "CF-Connecting-IP": "203.0.113.63" });
  await second.evaluate(() => {
    Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true });
  });
  await second.getByRole("button", { name: "Use security key" }).click();
  await expect(second.getByRole("alert")).toContainText("This browser can't use security keys.");
  await second.reload();
  await second.getByText("Lost your keys?", { exact: true }).click();
  await expect(second.getByText(/If every key is lost, the site operator resets them/)).toBeVisible();
  await second.route(
    "**/api/admin/stepup/options",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "The request failed. Please try again." },
      }),
    { times: 1 },
  );
  await second.getByRole("button", { name: "Use security key" }).click();
  await expect(second.getByRole("alert")).toHaveText("The request failed. Please try again.");
  await second.getByRole("button", { name: "Try again" }).click();
  await expect(second.getByRole("heading", { name: /^Admin\s*:\s*Streamer pages$/ })).toBeVisible();

  await second.getByLabel("Search streamer pages").fill("zz_room_48");
  await second.getByLabel("Search streamer pages").press("Enter");
  const row = second.getByRole("article", { name: "Room 48" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Freeze @zz_room_48" }).click();
  const sheet = second.getByRole("dialog", { name: "Freeze @zz_room_48?" });
  await sheet.getByRole("combobox", { name: "Reason" }).click();
  await second.getByRole("option", { name: "Spam or scam" }).click();
  await sheet.getByLabel("Internal note (optional)").fill("Test freeze from the browser suite.");
  await shot(second, "moderate-sheet");
  await second.route(
    "**/api/admin/streamers/*",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "The request failed. Please try again." },
      }),
    { times: 1 },
  );
  await sheet.getByRole("button", { name: "Freeze", exact: true }).click();
  await expect(sheet.getByRole("alert")).toHaveText("The request failed. Please try again.");
  await expect(sheet.getByLabel("Internal note (optional)")).toHaveValue("Test freeze from the browser suite.");
  await second.route(
    "**/api/admin/streamers/*",
    (route) =>
      route.fulfill({
        status: 403,
        json: { error: "Confirm again.", code: "step_up_required" },
      }),
    { times: 1 },
  );
  await sheet.getByRole("button", { name: "Freeze", exact: true }).click();
  await expect(second.getByRole("dialog", { name: "Confirm it's you" })).toBeVisible();
  await second.getByRole("dialog").getByRole("button", { name: "Use security key" }).click();
  // Freeze defaults to notification; without NOTIFY_EMAIL, e2e sends no email.
  await expect(second.getByRole("status").filter({ hasText: "Froze" })).toHaveText(
    "Froze @zz_room_48. The owner sees a notice on their page. No email went out.",
  );
  await expect(row.locator(".mod-badge")).toHaveText("Frozen");
  await row.getByText("Moderation history (1)").click();
  await expect(row.getByText("Test freeze from the browser suite.")).toBeVisible();
  await shot(second, "pages-frozen");
  await row.getByRole("button", { name: "Unfreeze @zz_room_48" }).click();
  const lift = second.getByRole("dialog", { name: "Unfreeze @zz_room_48?" });
  await lift.getByRole("combobox", { name: "Reason" }).click();
  await second.getByRole("option", { name: "Something else" }).click();
  await lift.getByRole("button", { name: "Unfreeze", exact: true }).click();
  await expect(row.locator(".mod-badge")).toHaveText("Active");

  await row.getByRole("button", { name: "Suspend @zz_room_48" }).click();
  const suspend = second.getByRole("dialog", { name: "Suspend @zz_room_48?" });
  await suspend.getByRole("combobox", { name: "Reason" }).click();
  await second.getByRole("option", { name: "Spam or scam" }).click();
  await suspend.getByRole("checkbox").uncheck();
  await suspend.getByRole("button", { name: "Suspend", exact: true }).click();
  await expect(row.locator(".mod-badge")).toHaveText("Suspended");
  await row.getByRole("button", { name: "Unsuspend @zz_room_48" }).click();
  const restore = second.getByRole("dialog", { name: "Unsuspend @zz_room_48?" });
  await restore.getByRole("combobox", { name: "Reason" }).click();
  await second.getByRole("option", { name: "Something else" }).click();
  await restore.getByRole("button", { name: "Unsuspend", exact: true }).click();
  await expect(row.locator(".mod-badge")).toHaveText("Active");

  await row.getByRole("button", { name: "Mark as official @zz_room_48" }).click();
  const official = second.getByRole("dialog");
  await second.route(
    "**/api/admin/streamers/*/official",
    (route) =>
      route.fulfill({
        status: 403,
        json: { error: "Confirm again.", code: "step_up_required" },
      }),
    { times: 1 },
  );
  await official.getByRole("button", { name: "Mark as official", exact: true }).click();
  await expect(official.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await official.getByRole("button", { name: "Use security key" }).click();
  await expect(row.locator(".official-badge")).toHaveText("Official");
  await row.getByRole("button", { name: "Remove official @zz_room_48" }).click();
  await second.getByRole("dialog").getByRole("button", { name: "Remove official", exact: true }).click();
  await expect(row.locator(".official-badge")).toHaveCount(0);

  // Add a third key and remove it after confirmation with the retained backup key.
  const { credentials: backupCredentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId: backup });
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: backup });
  const travel = await addKey(cdp);
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add a security key" });
  await add.getByLabel("Key name").fill("Travel key");
  await add.getByRole("button", { name: "Touch new key to register" }).click();
  await expect(page.getByRole("article", { name: "Travel key" })).toBeVisible();
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: travel });
  const retained = await addKey(cdp);
  await cdp.send("WebAuthn.addCredential", { authenticatorId: retained, credential: backupCredentials[0] });
  await page.getByRole("button", { name: "Remove Travel key", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "Remove Travel key?" });
  await expect(remove.getByText(/YubiKey – safe/)).toBeVisible();
  await page.route(
    "**/api/admin/keys/*",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "The request failed. Please try again." },
      }),
    { times: 1 },
  );
  await remove.getByRole("button", { name: "Confirm with another key" }).click();
  await expect(remove.getByRole("alert").filter({ hasText: "The request failed. Please try again." })).toBeVisible();
  await remove.getByRole("button", { name: "Confirm with another key" }).click();
  await expect(page.getByRole("article", { name: "Travel key" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Removed Travel key." })).toBeVisible();
  await page.getByRole("button", { name: "Rename YubiKey – safe" }).click();
  await page.getByRole("dialog").press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await Promise.all([close(context), close(other)]);
});

test("reports are grouped by page and resolved per item", async ({ browser }) => {
  const reporter = await signedIn(browser, "reporter", clientIp("admin-keys", 123));
  const board = boardSchema.parse(await (await reporter.request.get("/api/streamers/pagination_host")).json());
  const entry = board.entries.find((item) => item.title === "Archive topic 55") ?? board.entries[0];
  for (const reason of ["spam", "other"]) {
    const response = await reporter.request.post("/api/reports", {
      data: { targetKind: "entry", targetId: entry.id, reason, details: reason === "other" ? "Off topic." : "" },
      headers: { Origin: origin },
    });
    expect([200, 409]).toContain(response.status());
  }
  await close(reporter);

  // The first key-admin session has a fresh check or uses report mode.
  const context = await signedIn(browser, "keyadmin", clientIp("admin-keys", 124), true);
  const page = await newPage(context);
  await page.goto("/admin?view=reports");
  const skip = page.getByRole("button", { name: "Continue without a key" });
  if (await skip.isVisible()) await skip.click();
  const group = page.getByRole("article", { name: "Pagination host" });
  await expect(group).toBeVisible();
  await expect(group.locator(".reason-chip").first()).toBeVisible();
  await group.getByRole("button", { name: /Show 1 reported item/ }).click();
  await expect(group.getByText("Reported by 1 person")).toBeVisible();
  await group.getByRole("button", { name: "By author" }).click();
  await expect(group.getByRole("button", { name: "By author" })).toHaveAttribute("aria-pressed", "true");
  await shot(page, "reports-group-mobile");
  await group.getByRole("button", { name: "Dismiss reports on this topic or poll" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByRole("status").filter({ hasText: "dismissed" })).toHaveText("Reports dismissed.");
  await expect(page.getByRole("article", { name: "Pagination host" })).toHaveCount(0);
  await close(context);
});

test("report pagination recovers, preserves focus and resolves content and deleted-page reports", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await signedIn(browser, "admin", clientIp("admin-keys", 120));
  await context.setExtraHTTPHeaders({ Origin: origin, "CF-Connecting-IP": "203.0.113.60" });
  const users = await accounts();
  const result = z
    .object({ streamer: z.object({ id: z.string().uuid() }) })
    .parse(await (await context.request.get("/api/streamers/zz_room_47")).json());
  const streamerId: string = result.streamer.id;
  const deletedIds: string[] = Array.from({ length: 100 }, () => randomUUID());
  const entryIds: string[] = Array.from({ length: 52 }, () => randomUUID());
  const reportIds: string[] = [];
  const statements: string[] = [];
  const now: number = Date.now();
  function report(
    target: string,
    streamer: string,
    index: number,
    reporter: string | null,
    author: string | null,
  ): string {
    const id: string = randomUUID();
    reportIds.push(id);
    return `INSERT INTO content_reports(id,target_kind,target_id,streamer_id,reporter_id,target_author_id,reason,details,snapshot,status,created_at) VALUES ('${id}','entry','${target}','${streamer}',${reporter ? `'${reporter}'` : "NULL"},${author ? `'${author}'` : "NULL"},'spam','${index === 0 ? "Please review the context." : ""}','Review fixture ${index}','open',${now - index});`;
  }
  for (const [index, id] of entryIds.entries()) {
    const author: string = index % 2 ? users.viewer.id : users.owner.id;
    statements.push(
      `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed) VALUES ('${id}','${streamerId}','${author}','topic','Review fixture ${index}','','','[]',${now - index},0);`,
      report(id, streamerId, index, users.reporter.id, author),
    );
  }
  // Deleted reporters retain their reports; live content keeps the same author across all reports.
  // The response bounds per-item reporter details at 50.
  for (let index: number = 0; index < 51; index += 1)
    statements.push(report(entryIds[0], streamerId, 0, null, users.owner.id));
  // Deleted-page snapshots have neither a surviving content author nor a surviving reporter.
  for (const [index, id] of deletedIds.entries()) statements.push(report(randomUUID(), id, index + 100, null, null));
  await runSql("admin-report-review-coverage", statements);
  const page = await newPage(context);
  try {
    await page.goto("/admin?view=reports");
    await page.route(
      "**/api/admin/report-groups?*",
      (route) =>
        route.fulfill({
          status: 503,
          json: { error: "The request failed. Please try again." },
        }),
      { times: 1 },
    );
    await page.getByRole("button", { name: "Load more pages", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The request failed. Please try again." })).toBeVisible();
    await page.getByRole("button", { name: "Load more pages", exact: true }).click();
    await expect(page.getByRole("button", { name: "Load more pages", exact: true })).toHaveCount(0);
    await expect(page.locator("[data-group]:focus")).toHaveCount(1);
    await expect(page.getByRole("article", { name: "Deleted page", exact: true })).toHaveCount(100);
    const deleted = page.getByRole("article", { name: "Deleted page", exact: true }).last();
    await deleted.getByRole("button", { name: "Show 1 reported item" }).click();
    await expect(deleted.locator(".report-item")).toHaveCount(1);
    await expect(deleted.getByRole("link", { name: "Open in context" })).toHaveCount(0);
    await expect(deleted.locator(".report-item .person strong")).toHaveText("a deleted account");
    await expect(deleted.locator(".reporters")).toContainText("a deleted account (Spam)");
    await deleted.getByRole("button", { name: "By author", exact: true }).click();
    await expect(deleted.locator(".author-head")).toContainText("a deleted account");

    const group = page.getByRole("article", { name: "Room 47", exact: true });
    await page.route(
      `**/api/admin/report-groups/${streamerId}?*`,
      (route) =>
        route.fulfill({
          status: 503,
          json: { error: "The request failed. Please try again." },
        }),
      { times: 1 },
    );
    await group.getByRole("button", { name: "Show 52 reported items" }).click();
    await expect(group.getByRole("alert")).toHaveText("The request failed. Please try again.");
    await group.getByRole("button", { name: "Hide reported items" }).click();
    await group.getByRole("button", { name: "Show 52 reported items" }).click();
    await expect(group.locator(".report-item")).toHaveCount(50);
    await expect(group.locator(".reporters").first()).toContainText("2 more");
    await expect(group.getByText(/Please review the context/).first()).toBeVisible();
    const original = group.locator(".report-item").first();
    await expect(original.getByRole("link", { name: "Open in context" })).toHaveAttribute(
      "href",
      `/@zz_room_47?entry=${entryIds[0]}`,
    );
    await page.route(
      `**/api/admin/report-groups/${streamerId}?*cursor=*`,
      (route) =>
        route.fulfill({
          status: 503,
          json: { error: "The request failed. Please try again." },
        }),
      { times: 1 },
    );
    await group.getByRole("button", { name: "Load more reported items" }).click();
    await expect(group.getByRole("alert")).toHaveText("The request failed. Please try again.");
    await group.getByRole("button", { name: "Load more reported items" }).click();
    await expect(group.locator(".report-item")).toHaveCount(52);
    await expect(group.locator(".report-item:focus")).toHaveAttribute("data-item", `entry:${entryIds[50]}`);
    await group.getByRole("button", { name: "By author", exact: true }).click();
    await expect(group.locator(".author-group")).toHaveCount(2);
    await group.getByRole("button", { name: "By item", exact: true }).click();
    await expect(group.getByRole("button", { name: "By item", exact: true })).toHaveAttribute("aria-pressed", "true");
    await original.getByRole("button", { name: "Remove content", exact: true }).click();
    await page.getByRole("dialog").press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await original.getByRole("button", { name: "Remove content", exact: true }).click();
    await page.route(
      "**/api/admin/reports/resolve",
      (route) =>
        route.fulfill({
          status: 503,
          json: { error: "The request failed. Please try again." },
        }),
      { times: 1 },
    );
    const remove = page.getByRole("dialog", { name: "Remove this content?" });
    await remove.getByRole("button", { name: "Remove content", exact: true }).click();
    await expect(remove.getByRole("alert")).toHaveText("The request failed. Please try again.");
    await remove.getByRole("button", { name: "Remove content", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Content removed and its reports closed." })).toBeVisible();
    await expect(group.locator(`[data-item="entry:${entryIds[0]}"]`)).toHaveCount(0);
    await group.getByRole("button", { name: "Freeze @zz_room_47", exact: true }).click();
    await page.getByRole("dialog").press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await group.getByRole("button", { name: "Freeze @zz_room_47", exact: true }).click();
    const freeze = page.getByRole("dialog", { name: "Freeze @zz_room_47?" });
    await freeze.getByRole("combobox", { name: "Reason" }).click();
    await page.getByRole("option", { name: "Spam or scam" }).click();
    await freeze.getByRole("checkbox").uncheck();
    await freeze.getByRole("button", { name: "Freeze", exact: true }).click();
    await expect(group.locator(".mod-badge")).toHaveText("Frozen");
    await group.getByRole("button", { name: "Unfreeze @zz_room_47", exact: true }).click();
    const unfreeze = page.getByRole("dialog", { name: "Unfreeze @zz_room_47?" });
    await unfreeze.getByRole("combobox", { name: "Reason" }).click();
    await page.getByRole("option", { name: "Something else" }).click();
    await unfreeze.getByRole("button", { name: "Unfreeze", exact: true }).click();
    await expect(group.locator(".mod-badge")).toHaveText("Active");
    await group.getByRole("button", { name: "Dismiss all open", exact: true }).click();
    await page.getByRole("dialog").press("Escape");
    await group.getByRole("button", { name: "Dismiss all open", exact: true }).click();
    const dismiss = page.getByRole("dialog", { name: "Dismiss all open reports on @zz_room_47?" });
    await dismiss.getByRole("button", { name: "Dismiss all open", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Dismissed all open reports on Room 47." })).toBeVisible();
    await expect(group).toHaveCount(0);
    await page.getByLabel("Search by streamer", { exact: true }).fill("zz_room_47");
    await page.getByLabel("Search by streamer", { exact: true }).press("Enter");
    await page
      .getByRole("navigation", { name: "Report status" })
      .getByRole("link", { name: "Resolved", exact: true })
      .click();
    await group.getByRole("button", { name: "Show 52 reported items" }).click();
    await expect(group.locator(".resolved-line").filter({ hasText: "Content removed" })).toHaveCount(1);
    await expect(group.locator(".resolved-line").filter({ hasText: "Dismissed" })).toHaveCount(49);
    await expect(group.getByRole("button", { name: "Dismiss all open", exact: true })).toHaveCount(0);
    await expect(group.getByRole("button", { name: "Remove content", exact: true })).toHaveCount(0);
  } finally {
    await close(context);
    await runSql("admin-report-review-cleanup", [
      `DELETE FROM content_reports WHERE id IN (${reportIds.map((id) => `'${id}'`).join(",")});`,
      `DELETE FROM entries WHERE id IN (${entryIds.map((id) => `'${id}'`).join(",")});`,
      `UPDATE streamers SET status='active',status_reason=NULL,status_changed_at=NULL,status_changed_by=NULL WHERE id='${streamerId}';`,
      `DELETE FROM moderation_actions WHERE streamer_id='${streamerId}' AND created_at>=${now} AND action IN ('freeze','unfreeze');`,
    ]);
  }
});
