import { newPage, close } from "./coverage";
import { readFile } from "node:fs/promises";
import { test, expect, type Browser, type BrowserContext } from "./coverage";
import { z } from "zod";
import { clientAddress } from "./client-ips";
import type { Me } from "../../app/components/account/me";

const origin: string = "http://localhost:5173";
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));
const boardSchema = z.object({ entries: z.array(z.object({ id: z.string(), title: z.string() })) });
const commentsSchema = z.object({
  comments: z.array(z.object({ text: z.string(), parentId: z.string().nullable() })),
});

async function accountContext(browser: Browser, ip: string): Promise<BrowserContext> {
  const session = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8"))).reporter;
  if (!session) throw new Error("Unknown test account.");
  const context = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { "CF-Connecting-IP": ip } });
  await context.addCookies([
    { name: "stream-bullets.session_token", value: session.cookie, domain: "localhost", path: "/", httpOnly: true },
  ]);
  return context;
}

test("a member downloads their data, deletes their account, and is signed out", async ({ browser, request }) => {
  const sessions = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
  const leaver = sessions.leaver;
  if (!leaver) throw new Error("Unknown test account.");
  const context = await browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("account", 40) },
  });
  await context.addCookies([
    {
      name: "stream-bullets.session_token",
      value: leaver.cookie,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await newPage(context);
  // Legacy /settings opens Your profile; Your data stays in the account menu.
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/streamers\?dialog=profile$/);
  await expect(page.getByRole("dialog", { name: "Your profile" })).toBeVisible();
  await page.goto("/streamers?dialog=data");
  const dataDialog = page.getByRole("dialog", { name: "Your data" });
  await expect(dataDialog).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dataDialog.getByRole("link", { name: "Download my data" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^streambullets-data-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = await readFile(await download.path(), "utf8");
  const data = JSON.parse(exported) as {
    account: { id: string; email: string };
    streamerPage: { handle: string } | null;
    comments: { text: string }[];
  };
  expect(data.account).toMatchObject({ id: leaver.id, email: "leaver@example.test" });
  expect(data.streamerPage?.handle).toBe("leaver_host");
  expect(data.comments.map((comment) => comment.text)).toEqual(["Leaver comment"]);
  expect(exported).not.toContain(decodeURIComponent(leaver.cookie).split(".")[0]);

  await dataDialog.getByRole("button", { name: "Delete my account" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your account?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep my account" })).toBeVisible();
  await expect(dialog).toContainText("Replies other people wrote under your comments stay");
  await expect(dialog).toContainText("Your streamer page and everything posted on it");
  const confirm = dialog.getByRole("button", { name: "Type DELETE to enable" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Type DELETE to confirm").fill("DELET");
  await expect(confirm).toBeDisabled();
  // Confirmation ignores letter case.
  await dialog.getByLabel("Type DELETE to confirm").fill("delete");
  // Fixtures have no provider; failed deletion must retain sign-in controls.
  await page.route(
    "**/api/account/delete",
    (route) =>
      route.fulfill({
        status: 403,
        json: { error: "Sign in again to delete your account.", code: "reauth_required" },
      }),
    { times: 1 },
  );
  await dialog.getByRole("button", { name: "Delete my account" }).click();
  await expect(dialog.getByText("Sign in again to delete your account.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Sign-in is turned off on this site for now. Public pages still work.")).toBeVisible();
  await dialog.getByRole("button", { name: "Delete my account" }).click();
  await page.waitForURL(`${origin}/`);

  const cookies = await context.cookies();
  expect(cookies.find((cookie) => cookie.name === "stream-bullets.session_token")).toBeUndefined();
  const stale = await request.get("/api/me", {
    headers: { Cookie: `stream-bullets.session_token=${leaver.cookie}` },
  });
  expect(((await stale.json()) as { viewer: unknown }).viewer).toBeNull();
  const exportAfter = await request.get("/api/account/export", {
    headers: { Cookie: `stream-bullets.session_token=${leaver.cookie}` },
  });
  expect(exportAfter.status()).toBe(401);
  expect((await request.get("/api/streamers/leaver_host")).status()).toBe(404);

  const board = boardSchema.parse(await (await request.get("/api/streamers/other_host")).json());
  const topic = board.entries.find((entry) => entry.title === "Leaver discussion");
  if (!topic) throw new Error("The discussion should remain.");
  const discussion = commentsSchema.parse(await (await request.get(`/api/entries/${topic.id}/comments`)).json());
  expect(discussion.comments).toEqual([expect.objectContaining({ text: "Reply that stays", parentId: null })]);
  await close(context);
});

// Additional account cases reserve 203.0.113.124–127, one address per case.
test("a pending account deletion stays open and can recover without deleting data", async ({ browser }) => {
  const context = await accountContext(browser, "203.0.113.124");
  try {
    const page = await newPage(context);
    await page.goto("/streamers?dialog=data");
    const data = page.getByRole("dialog", { name: "Your data" });
    await data.getByRole("button", { name: "Delete my account" }).click();
    const deleting = page.getByRole("dialog", { name: "Delete your account?" });
    await expect(deleting).toContainText("Topics you suggested, with their discussions");
    await deleting.getByLabel("Type DELETE to confirm").fill("delete");
    let release!: () => void;
    const pending: Promise<void> = new Promise<void>((resolve: () => void): void => {
      release = resolve;
    });
    await page.route("**/api/account/delete", async (route) => {
      expect(route.request().postDataJSON() as unknown).toEqual({ confirm: "DELETE" });
      await pending;
      await route.fulfill({ status: 503, json: { error: "Deletion temporarily unavailable." } });
    });
    await deleting.getByRole("button", { name: "Delete my account", exact: true }).click();
    await expect(deleting.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    await expect(deleting.getByRole("button", { name: "Keep my account" })).toBeDisabled();
    await expect(deleting.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
    await deleting.getByRole("button", { name: "Close dialog" }).click();
    await expect(deleting).toBeVisible();
    const response = page.waitForResponse("**/api/account/delete");
    release();
    await response;
    await expect(deleting.getByRole("alert")).toHaveText("Deletion temporarily unavailable.");
    await expect(deleting.getByRole("button", { name: "Delete my account", exact: true })).toBeEnabled();
    await deleting.getByRole("button", { name: "Keep my account" }).click();
    await expect(data).toBeVisible();
    await data.getByRole("button", { name: "Delete my account" }).click();
    await expect(deleting.getByLabel("Type DELETE to confirm")).toBeEmpty();
    await expect(deleting.locator("#delete-account-error")).toBeEmpty();
    await expect(deleting.locator("#delete-account-error")).toBeHidden();
    await deleting.getByRole("button", { name: "Back", exact: true }).click();
    await data.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(((await (await context.request.get("/api/me")).json()) as Me).viewer).not.toBeNull();
  } finally {
    await close(context);
  }
});

test("a pending host application keeps edits on failure and reloads its updated request", async ({ browser }) => {
  const context = await accountContext(browser, "203.0.113.125");
  try {
    const page = await newPage(context);
    const me = (await (await context.request.get("/api/me")).json()) as Me;
    let application = {
      id: "account-ui-application",
      links: ["https://twitch.tv/account_ui"],
      note: "Original note",
      status: "pending" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      reviewedAt: null,
    };
    await page.route("**/api/me", (route) =>
      route.fulfill({
        json: { ...me, streamer: null, access: { admin: false, canCreateStreamer: false, application } },
      }),
    );
    const submissions: { links: string[]; note: string }[] = [];
    await page.route("**/api/application", async (route) => {
      const input = route.request().postDataJSON() as { links: string[]; note: string };
      submissions.push(input);
      if (submissions.length === 1) {
        await route.fulfill({ status: 503, json: { error: "Applications temporarily unavailable." } });
      } else {
        application = { ...application, ...input, updatedAt: Date.now() };
        await route.fulfill({ json: { application } });
      }
    });
    await page.goto("/streamers?dialog=host");
    const dialog = page.getByRole("dialog", { name: "Host a community" });
    await expect(dialog.getByText("Request received.", { exact: true })).toBeVisible();
    for (let index: number = 0; index < 4; index++)
      await dialog.getByRole("button", { name: "Add another link" }).click();
    await expect(dialog.getByText("You can add up to 5 links.", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Add another link" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Remove channel link 5" }).click();
    await expect(dialog.getByRole("textbox", { name: "Channel link 4", exact: true })).toBeFocused();
    for (const index of [4, 3, 2]) await dialog.getByRole("button", { name: `Remove channel link ${index}` }).click();
    await expect(dialog.getByRole("button", { name: /Remove channel link/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Add another link" }).click();
    await expect(dialog.getByRole("textbox", { name: "Channel link 2", exact: true })).toBeFocused();
    await dialog.getByRole("textbox", { name: "Channel link 2", exact: true }).fill("https://youtube.com/@account_ui");
    await dialog.getByLabel("Anything else we should know? (optional)").fill("  Updated schedule  ");
    await dialog.getByRole("button", { name: "Update request" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Applications temporarily unavailable.");
    await expect(dialog.getByRole("textbox", { name: "Channel link 2", exact: true })).toHaveValue(
      "https://youtube.com/@account_ui",
    );
    await dialog.getByRole("button", { name: "Update request" }).click();
    await expect(page.getByText("Request updated.", { exact: true })).toBeVisible();
    await expect(dialog.locator(".form-error[role=alert]")).toBeEmpty();
    await expect(dialog.locator(".form-error[role=alert]")).toBeHidden();
    expect(submissions).toEqual([
      { links: ["https://twitch.tv/account_ui", "https://youtube.com/@account_ui"], note: "Updated schedule" },
      { links: ["https://twitch.tv/account_ui", "https://youtube.com/@account_ui"], note: "Updated schedule" },
    ]);
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await page.goto("/streamers?dialog=host");
    await expect(dialog.getByLabel("Anything else we should know? (optional)")).toHaveValue("Updated schedule");
  } finally {
    await close(context);
  }
});

test("approved hosts can retry a handle claim and administrators see their direct hosting route", async ({
  browser,
}) => {
  const context = await accountContext(browser, "203.0.113.126");
  try {
    const page = await newPage(context);
    const me = (await (await context.request.get("/api/me")).json()) as Me;
    let administrator: boolean = false;
    await page.route("**/api/me", (route) =>
      route.fulfill({
        json: {
          ...me,
          streamer: null,
          access: {
            admin: administrator,
            canCreateStreamer: true,
            application: administrator
              ? null
              : {
                  id: "account-ui-approved",
                  status: "approved",
                  links: ["https://twitch.tv/account_ui"],
                  note: "",
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                  reviewedAt: Date.now(),
                },
          },
        },
      }),
    );
    const claims: unknown[] = [];
    await page.route("**/api/streamer", async (route) => {
      claims.push(route.request().postDataJSON() as unknown);
      await route.fulfill(
        claims.length === 1
          ? { status: 409, json: { error: "That handle is already taken." } }
          : { json: { streamer: { handle: "account_ui_claim" } } },
      );
    });
    await page.goto("/streamers?dialog=host");
    const dialog = page.getByRole("dialog", { name: "Host a community" });
    await expect(dialog).toContainText("You're approved to host a community.");
    await dialog.getByRole("textbox", { name: "Handle", exact: true }).fill("bad-handle");
    await dialog.getByRole("button", { name: "Create your community page" }).click();
    expect(claims).toHaveLength(0);
    expect(
      await dialog
        .getByRole("textbox", { name: "Handle", exact: true })
        .evaluate((input: HTMLInputElement): boolean => input.validity.patternMismatch),
    ).toBe(true);
    await dialog.getByRole("textbox", { name: "Handle", exact: true }).fill("account_ui_claim");
    await dialog.getByLabel("Streamer name").fill("  Account UI community  ");
    await dialog.getByLabel("About your stream").fill("  Account UI description  ");
    await dialog.getByRole("button", { name: "Create your community page" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("That handle is already taken.");
    await dialog.getByRole("button", { name: "Create your community page" }).click();
    await expect(dialog).toBeHidden();
    expect(claims).toEqual([
      { handle: "account_ui_claim", name: "Account UI community", about: "Account UI description" },
      { handle: "account_ui_claim", name: "Account UI community", about: "Account UI description" },
    ]);
    administrator = true;
    await page.goto("/streamers?dialog=host");
    await expect(dialog).toContainText("As an administrator, you can host a community right away.");
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await close(context);
  }
});

test("account loading errors can be dismissed and stale responses do not replace a new dialog", async ({ browser }) => {
  const context = await accountContext(browser, "203.0.113.127");
  try {
    const page = await newPage(context);
    const me = (await (await context.request.get("/api/me")).json()) as Me;
    await page.route("**/api/me", (route) =>
      route.fulfill({ status: 503, json: { error: "Account settings temporarily unavailable." } }),
    );
    await page.goto("/streamers?dialog=host");
    const host = page.getByRole("dialog", { name: "Host a community" });
    await expect(host.getByRole("alert")).toHaveText("Account settings temporarily unavailable.");
    await host.getByRole("button", { name: "Close dialog" }).click();
    await expect(host).toHaveCount(0);
    await page.unroute("**/api/me");
    let release!: () => void;
    const pending: Promise<void> = new Promise<void>((resolve: () => void): void => {
      release = resolve;
    });
    await page.route("**/api/me", async (route) => {
      await pending;
      await route.fulfill({ json: me });
    });
    await page.getByRole("button", { name: "Account menu for reporter" }).click();
    await Promise.all([
      page.waitForRequest("**/api/me"),
      page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Host a community" }).click(),
    ]);
    await expect(host.getByRole("status")).toHaveText("Loading…");
    await host.getByRole("button", { name: "Close dialog" }).click();
    const response = page.waitForResponse("**/api/me");
    release();
    await response;
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto("/streamers?dialog=profile");
    await expect(page.getByRole("dialog", { name: "Your profile" }).getByLabel("Display name")).toHaveValue("reporter");
  } finally {
    await close(context);
  }
});
