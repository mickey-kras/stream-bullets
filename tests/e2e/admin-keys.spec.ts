import { readFile } from "node:fs/promises";
import { test, expect, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { z } from "zod";

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

/** A CTAP2 security key with a PIN set, like a YubiKey: user verification works and touches are automatic. */
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
  const viewer = await signedIn(browser, "viewer", 80);
  for (const path of ["/api/admin/stepup", "/api/admin/keys", "/api/admin/streamers", "/api/admin/report-groups"])
    expect((await viewer.request.get(path)).status()).toBe(403);
  const options = await viewer.request.post("/api/admin/stepup/options", { data: {}, headers: { Origin: origin } });
  expect(options.status()).toBe(403);
  await viewer.close();
});

test("an admin sets up two keys, confirms with a key in another session, and moderates", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await signedIn(browser, "keyadmin", 81);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const first = await addKey(cdp);

  await page.goto("/admin");
  await expect(page.getByText("Security keys aren't set up yet.")).toBeVisible();
  await page.getByRole("link", { name: "Set up security keys" }).click();
  await expect(page.getByRole("heading", { name: "Add your first key" })).toBeVisible();
  await expect(page.locator(".key-steps [aria-current=step]")).toHaveText(/Add your first key/);
  await shot(page, "keys-setup-first");
  await page.getByRole("button", { name: "Register this key" }).click();
  await expect(page.getByRole("heading", { name: "Add a backup key" })).toBeVisible();

  // The backup key is a second authenticator. Keep the first key's credential to use it again later.
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId: first });
  expect(credentials).toHaveLength(1);
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: first });
  await addKey(cdp);
  await expect(page.getByLabel("Key name")).toHaveValue("YubiKey – safe");
  await page.getByRole("button", { name: "Register this key" }).click();
  await expect(page.getByRole("heading", { name: "Both keys are set up" })).toBeVisible();
  await shot(page, "keys-setup-done");
  await page.getByRole("link", { name: "Open Admin" }).click();
  await expect(page.getByRole("heading", { name: "Admin: Streamer requests" })).toBeVisible();
  await expect(page.getByText("Security keys aren't set up yet.")).toHaveCount(0);

  await page.getByRole("link", { name: "Security keys" }).click();
  await expect(page.getByRole("article", { name: "YubiKey – desk" })).toBeVisible();
  await page.getByRole("button", { name: "Rename YubiKey – desk" }).click();
  await page.getByRole("dialog").getByLabel("Key name").fill("YubiKey – keyring");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Renamed" })).toHaveText("Renamed the key to YubiKey – keyring.");
  await expect(page.getByRole("article", { name: "YubiKey – keyring" })).toBeVisible();
  await shot(page, "keys-tab");

  // A second session of the same account has no key check yet: Admin asks for a key first.
  const other = await signedIn(browser, "keyadmin2", 82);
  const second = await other.newPage();
  const otherCdp = await other.newCDPSession(second);
  await otherCdp.send("WebAuthn.enable");
  const restored = await addKey(otherCdp);
  await otherCdp.send("WebAuthn.addCredential", { authenticatorId: restored, credential: credentials[0] });
  await second.goto("/admin?view=pages");
  await expect(second.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await expect(second.getByRole("article", { name: "Room 48" })).toHaveCount(0);
  await shot(second, "stepup-gate");
  await second.getByRole("button", { name: "Use security key" }).click();
  await expect(second.getByRole("heading", { name: "Admin: Streamer pages" })).toBeVisible();

  // Freeze a page with a reason and a note, then lift it.
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
  await sheet.getByRole("button", { name: "Freeze", exact: true }).click();
  await expect(second.getByRole("status").filter({ hasText: "Froze" })).toHaveText("Froze @zz_room_48.");
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

  await Promise.all([context.close(), other.close()]);
});

test("reports are grouped by page and resolved per item", async ({ browser }) => {
  const reporter = await signedIn(browser, "reporter", 83);
  const board = boardSchema.parse(await (await reporter.request.get("/api/streamers/pagination_host")).json());
  const entry = board.entries.find((item) => item.title === "Archive topic 55") ?? board.entries[0];
  for (const reason of ["spam", "other"]) {
    const response = await reporter.request.post("/api/reports", {
      data: { targetKind: "entry", targetId: entry.id, reason, details: reason === "other" ? "Off topic." : "" },
      headers: { Origin: origin },
    });
    expect([200, 409]).toContain(response.status());
  }
  await reporter.close();

  // The key admin's first session has a fresh key check from the previous test, or the report-mode gate.
  const context = await signedIn(browser, "keyadmin", 84, true);
  const page = await context.newPage();
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
  await context.close();
});
