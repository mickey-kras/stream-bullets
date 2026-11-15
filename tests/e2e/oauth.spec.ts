import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare, Response as RuntimeResponse, type Request as RuntimeRequest } from "miniflare";
import type { BrowserContext, Page, Response } from "@playwright/test";
import { test, expect, newPage, close } from "./coverage";
import { applyMigrations, migrationFiles } from "../helpers/database";
import { clientAddress } from "./client-ips";

const origin: string = "https://localhost:5174";
const sessionName: string = "__Host-stream-bullets.session_token";
let runtime: Miniflare;
let sequence: number = 0;
const providerRequests: string[] = [];
async function providerResponse(request: RuntimeRequest): Promise<RuntimeResponse> {
  if (request.url !== "https://id.twitch.tv/oauth2/token" || request.method !== "POST") {
    throw new Error("Unexpected provider request in browser OAuth test.");
  }
  const body = new URLSearchParams(await request.text());
  const code: string = body.get("code") ?? "";
  providerRequests.push(code);
  if (!code.startsWith("browser-")) return RuntimeResponse.json({ error: "invalid_grant" }, { status: 400 });
  const encode = (value: Record<string, unknown>): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token: string = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    sub: code,
    email: `${code}@example.test`,
    email_verified: true,
    preferred_username: "Browser viewer",
  })}.c2lnbmF0dXJl`;
  return RuntimeResponse.json({
    access_token: `access-${code}`,
    token_type: "bearer",
    expires_in: 3600,
    id_token: token,
  });
}

test.beforeAll(async () => {
  runtime = new Miniflare({
    modulesRoot: resolve("build/server"),
    modules: [
      { type: "ESModule", path: resolve("build/server/index.js") },
      ...(await readdir("build/server/assets"))
        .filter((file: string): boolean => file.endsWith(".js"))
        .map((file: string) => ({ type: "ESModule" as const, path: resolve("build/server/assets", file) })),
    ],
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    host: "127.0.0.1",
    port: 5174,
    https: true,
    assets: { directory: resolve("build/client"), routerConfig: { has_user_worker: true } },
    bindings: {
      APP_ORIGIN: origin,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      TWITCH_CLIENT_ID: "browser-test-client",
      TWITCH_CLIENT_SECRET: "browser-test-secret",
    },
    d1Databases: ["DB"],
    r2Buckets: ["IMAGES"],
    durableObjects: { POLL_ROOMS: { className: "PollRoom", useSQLite: true } },
    ratelimits: { REQUEST_LIMITER: { namespace_id: "587", simple: { limit: 120, period: 60 } } },
    outboundService: providerResponse,
  });
  await applyMigrations((await runtime.getD1Database("DB")) as unknown as D1Database, await migrationFiles());
  await runtime.ready;
});

test.afterAll(async () => {
  await runtime?.dispose();
});

async function signIn(page: Page, code: string): Promise<Response> {
  await page.route("https://id.twitch.tv/oauth2/authorize**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("client_id")).toBe("browser-test-client");
    expect(url.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/callback/twitch`);
    expect(url.searchParams.get("state")).toBeTruthy();
    const callback = new URL(`${origin}/api/auth/callback/twitch`);
    callback.searchParams.set(
      "state",
      code === "wrong-state" ? "unrelated-state" : (url.searchParams.get("state") ?? ""),
    );
    callback.searchParams.set("code", code);
    await route.fulfill({ status: 302, headers: { location: callback.href }, body: "" });
  });
  await page.goto(`${origin}/streamers?dialog=profile`);
  const [, callbackResponse] = await Promise.all([
    page
      .waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/sign-in/social")
      .then((response: Response): void => {
        expect(response.status()).toBe(200);
      }),
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/callback/twitch"),
    page.waitForEvent("domcontentloaded"),
    (async () => {
      await page.getByRole("checkbox", { name: /I confirm/ }).check();
      await page.getByRole("button", { name: "Continue with Twitch" }).click();
    })(),
  ]);
  const location: string | null = await callbackResponse.headerValue("location");
  expect(location).not.toBeNull();
  expect(page.url()).toBe(new URL(location ?? "", origin).href);
  await page.waitForLoadState("load");
  return callbackResponse;
}

function expectHostCookie(header: string): void {
  expect(header).toContain(`${sessionName}=`);
  expect(header).toMatch(/;\s*Secure/i);
  expect(header).toMatch(/;\s*HttpOnly/i);
  expect(header).toMatch(/;\s*Path=\//i);
  expect(header).toMatch(/;\s*SameSite=Lax/i);
  expect(header).not.toMatch(/;\s*Domain=/i);
}

async function viewer(context: BrowserContext): Promise<unknown> {
  return ((await (await context.request.get(`${origin}/api/me`)).json()) as { viewer: unknown }).viewer;
}

test("OAuth creates a host-only HTTPS session and sign-out expires it", async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("oauth", 150) },
  });
  try {
    const page = await newPage(context);
    const code: string = `browser-${++sequence}`;
    const callback = await signIn(page, code);
    expect(callback.status()).toBe(302);
    expectHostCookie(
      (await callback.headersArray()).find(
        (header) => header.name.toLowerCase() === "set-cookie" && header.value.startsWith(sessionName),
      )?.value ?? "",
    );
    await expect.poll(() => viewer(context)).toMatchObject({ name: "Browser viewer" });
    expect(providerRequests).toContain(code);
    const cookie = (await context.cookies()).find((item) => item.name === sessionName);
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, path: "/", sameSite: "Lax" });
    const staleCookie: string = `${sessionName}=${cookie?.value}`;
    const response = await context.request.post(`${origin}/api/auth/sign-out`, { headers: { origin }, data: {} });
    expect(response.status()).toBe(200);
    const expired: string =
      response
        .headersArray()
        .find((header) => header.name.toLowerCase() === "set-cookie" && header.value.startsWith(sessionName))?.value ??
      "";
    expectHostCookie(expired);
    expect(expired).toMatch(/Max-Age=0/i);
    expect((await context.cookies()).find((item) => item.name === sessionName)).toBeUndefined();
    expect(await viewer(context)).toBeNull();
    const replay = await context.request.get(`${origin}/api/me`, { headers: { cookie: staleCookie } });
    expect(((await replay.json()) as { viewer: unknown }).viewer).toBeNull();
  } finally {
    await close(context);
  }
});

test("deleting an OAuth-created account expires the HTTPS cookie", async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("oauth", 151) },
  });
  try {
    const page = await newPage(context);
    await signIn(page, `browser-${++sequence}`);
    await expect.poll(() => viewer(context)).toMatchObject({ name: "Browser viewer" });
    const response = await context.request.post(`${origin}/api/account/delete`, {
      headers: { origin },
      data: { confirm: "DELETE" },
    });
    expect(response.status()).toBe(200);
    const expired: string =
      response
        .headersArray()
        .find((header) => header.name.toLowerCase() === "set-cookie" && header.value.startsWith(sessionName))?.value ??
      "";
    expectHostCookie(expired);
    expect(expired).toMatch(/Max-Age=0/i);
    expect((await context.cookies()).find((item) => item.name === sessionName)).toBeUndefined();
    expect(await viewer(context)).toBeNull();
  } finally {
    await close(context);
  }
});

test("a failed provider exchange creates no browser session", async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("oauth", 152) },
  });
  try {
    const page = await newPage(context);
    const callback = await signIn(page, "rejected-code");
    expect(callback.status()).toBe(302);
    expect((await callback.headerValue("location")) ?? "").toContain("error=");
    expect(providerRequests).toContain("rejected-code");
    expect((await context.cookies()).find((item) => item.name === sessionName)).toBeUndefined();
    expect(await viewer(context)).toBeNull();
  } finally {
    await close(context);
  }
});

test("a callback with unrelated state never exchanges a code or creates a session", async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("oauth", 153) },
  });
  try {
    const page = await newPage(context);
    const before: number = providerRequests.length;
    const callback = await signIn(page, "wrong-state");
    expect(callback.status()).toBe(302);
    expect((await callback.headerValue("location")) ?? "").toContain("error=");
    expect(providerRequests).toHaveLength(before);
    expect((await context.cookies()).find((item) => item.name === sessionName)).toBeUndefined();
    expect(await viewer(context)).toBeNull();
  } finally {
    await close(context);
  }
});

test("invalid signup names show correction guidance before OAuth starts", async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await newPage(context);
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel("Display name (optional; used for new accounts)").fill("Alice\u2028Bob");
    const acceptance = page.getByRole("checkbox", { name: /I confirm/ });
    await expect(acceptance).toBeInViewport();
    await acceptance.check();
    await page.getByRole("button", { name: "Continue with Twitch" }).click();
    await expect(page.getByRole("alert")).toContainText("Enter a display name below, then try again.");
    expect(new URL(page.url()).pathname).toBe("/sign-in");
  } finally {
    await close(context);
  }
});

test("unsaved profile edits disable login method changes", async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await newPage(context);
    await signIn(page, `browser-${++sequence}`);
    const profile = (await viewer(context)) as { id: string };
    const db = await runtime.getD1Database("DB");
    await db
      .prepare("INSERT INTO account(id,account_id,provider_id,user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(`extra-${sequence}`, `extra-${sequence}`, "twitch", profile.id, Date.now(), Date.now())
      .run();
    await page.goto(`${origin}/streamers?dialog=profile`);
    const dialog = page.getByRole("dialog", { name: "Your profile" });
    const remove = dialog.getByRole("button", { name: "Remove Twitch" }).first();
    await expect(remove).toBeEnabled();
    await dialog.getByLabel("Display name").fill("Unsaved change");
    await expect(remove).toBeDisabled();
    await expect(dialog.getByText("Save or discard your profile changes before changing login methods.")).toBeVisible();
  } finally {
    await close(context);
  }
});

// Account UI coverage owns 203.0.113.120–139; these isolated OAuth users use .128–131.
test("login methods recover from reauthentication and preserve the last usable account", async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "CF-Connecting-IP": "203.0.113.128" },
  });
  try {
    const page = await newPage(context);
    await signIn(page, `browser-${++sequence}`);
    const profile = (await viewer(context)) as { id: string };
    const db = await runtime.getD1Database("DB");
    for (const [id, provider] of [
      [`account-ui-extra-${sequence}`, "twitch"],
      [`account-ui-disabled-${sequence}`, "retired-provider"],
    ] as const) {
      await db
        .prepare("INSERT INTO account(id,account_id,provider_id,user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .bind(id, id, provider, profile.id, Date.now(), Date.now())
        .run();
    }
    await page.goto(`${origin}/streamers?dialog=profile`);
    const dialog = page.getByRole("dialog", { name: "Your profile" });
    const methods = dialog.getByRole("region", { name: "Login methods" });
    const remove = methods.getByRole("button", { name: "Remove Twitch" });
    await expect(remove).toHaveCount(2);
    await expect(remove.first()).toBeEnabled();
    const attempts: unknown[] = [];
    await page.route("**/api/auth/unlink-account", async (route) => {
      attempts.push(route.request().postDataJSON() as unknown);
      await route.fulfill(
        attempts.length === 1
          ? { status: 403, json: { message: "A fresh sign-in is required.", code: "REAUTH_REQUIRED" } }
          : { status: 409, json: { message: "Could not unlink.", code: "UNLINK_FAILED" } },
      );
    });
    await remove.last().click();
    await expect(methods.getByRole("alert").first()).toHaveText("Sign in again before changing login methods.");
    await expect(methods.getByRole("button", { name: "Continue with Twitch" })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Display name", exact: true }).fill("Unsaved login edit");
    await expect(remove.first()).toBeDisabled();
    await expect(methods.getByRole("button", { name: "Continue with Twitch" })).toHaveCount(0);
    await dialog.getByRole("textbox", { name: "Display name", exact: true }).fill("Browser viewer");
    await expect(methods.getByRole("button", { name: "Continue with Twitch" })).toBeVisible();
    await remove.last().click();
    await expect(methods.getByRole("alert")).toHaveText("Could not change login methods. Sign in again, then retry.");
    await expect(methods.getByRole("button", { name: "Continue with Twitch" })).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[0]).toMatchObject({ accountId: expect.stringMatching(/.+/) });
    await page.unroute("**/api/auth/unlink-account");
    await remove.last().click();
    await expect(remove).toHaveCount(1);
    await expect(remove).toBeDisabled();
    await expect(methods.getByRole("button", { name: /retired-provider/ })).toHaveCount(0);
    const remaining = (await (await context.request.get(`${origin}/api/auth/list-accounts`)).json()) as {
      providerId: string;
    }[];
    expect(remaining.filter((account) => account.providerId === "twitch")).toHaveLength(1);
  } finally {
    await close(context);
  }
});

test("linking an unlinked provider retries failures and preserves account settings callbacks", async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "CF-Connecting-IP": "203.0.113.129" },
  });
  try {
    const page = await newPage(context);
    await signIn(page, `browser-${++sequence}`);
    await page.route("**/api/auth/list-accounts", (route) => route.fulfill({ json: [] }));
    const links: unknown[] = [];
    await page.route("**/api/auth/link-social", async (route) => {
      links.push(route.request().postDataJSON() as unknown);
      await route.fulfill(
        links.length === 1
          ? {
              status: 409,
              json: { message: "Account already belongs to another profile.", code: "ACCOUNT_ALREADY_LINKED" },
            }
          : { json: { status: true, redirect: false } },
      );
    });
    await page.goto(`${origin}/streamers?dialog=profile`);
    const dialog = page.getByRole("dialog", { name: "Your profile" });
    const methods = dialog.getByRole("region", { name: "Login methods" });
    const link = methods.getByRole("button", { name: "Link Twitch" });
    await expect(link).toBeEnabled();
    await link.click();
    await expect(methods.getByRole("alert")).toHaveText("Could not change login methods. Sign in again, then retry.");
    await link.click();
    await expect(methods.getByRole("alert")).toBeEmpty();
    await expect(link).toBeEnabled();
    expect(links).toEqual([
      { provider: "twitch", callbackURL: "/settings", errorCallbackURL: "/sign-in" },
      { provider: "twitch", callbackURL: "/settings", errorCallbackURL: "/sign-in" },
    ]);
    await expect(page).toHaveURL(`${origin}/streamers?dialog=profile`);
  } finally {
    await close(context);
  }
});

test("account list failures remain visible and late results do not reopen a closed profile", async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "CF-Connecting-IP": "203.0.113.130" },
  });
  try {
    const page = await newPage(context);
    await signIn(page, `browser-${++sequence}`);
    await page.route("**/api/auth/list-accounts", (route) =>
      route.fulfill({ status: 503, json: { message: "The request failed. Please try again." } }),
    );
    await page.goto(`${origin}/streamers?dialog=profile`);
    const dialog = page.getByRole("dialog", { name: "Your profile" });
    const methods = dialog.getByRole("region", { name: "Login methods" });
    await expect(methods.getByRole("alert")).toHaveText("Could not change login methods. Sign in again, then retry.");
    await expect(methods.getByRole("button", { name: "Link Twitch" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await page.unroute("**/api/auth/list-accounts");
    let release!: () => void;
    const pending: Promise<void> = new Promise<void>((resolve: () => void): void => {
      release = resolve;
    });
    await page.route("**/api/auth/list-accounts", async (route) => {
      await pending;
      await route.fulfill({ json: [] });
    });
    await page.getByRole("button", { name: "Account menu for Browser viewer" }).click();
    await Promise.all([
      page.waitForRequest("**/api/auth/list-accounts"),
      page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Your profile" }).click(),
    ]);
    await expect(methods.getByRole("button", { name: "Link Twitch" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    const response = page.waitForResponse("**/api/auth/list-accounts");
    release();
    await response;
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/streamers`);
  } finally {
    await close(context);
  }
});

test("deletion recovery shows the signed-in provider and allows keeping the OAuth account", async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "CF-Connecting-IP": "203.0.113.131" },
  });
  try {
    const page = await newPage(context);
    await signIn(page, `browser-${++sequence}`);
    await page.goto(`${origin}/streamers?dialog=data`);
    const dialog = page.getByRole("dialog", { name: "Your data" });
    await expect(dialog.getByText("Signed in with Twitch", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Delete my account" }).click();
    const deleting = page.getByRole("dialog", { name: "Delete your account?" });
    await expect(deleting).toContainText("Your Twitch sign-in link and every signed-in session");
    await expect(deleting).toContainText("Your request to host a community, if you sent one");
    await deleting.getByLabel("Type DELETE to confirm").fill(" DELETE ");
    await page.route("**/api/account/delete", (route) =>
      route.fulfill({ status: 403, json: { error: "Sign in again to delete your account.", code: "reauth_required" } }),
    );
    await deleting.getByRole("button", { name: "Delete my account", exact: true }).click();
    await expect(deleting.getByRole("button", { name: "Continue with Twitch" })).toBeVisible();
    await deleting.getByRole("button", { name: "Keep my account" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Delete my account" }).click();
    await expect(deleting.getByLabel("Type DELETE to confirm")).toBeEmpty();
    await expect(deleting.locator("#delete-account-error")).toBeEmpty();
    await deleting.getByRole("button", { name: "Back", exact: true }).click();
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await viewer(context)).not.toBeNull();
  } finally {
    await close(context);
  }
});
