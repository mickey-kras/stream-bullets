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
  return RuntimeResponse.json({ access_token: `access-${code}`, token_type: "bearer", expires_in: 3600, id_token: token });
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
    callback.searchParams.set("state", code === "wrong-state" ? "unrelated-state" : url.searchParams.get("state") ?? "");
    callback.searchParams.set("code", code);
    await route.fulfill({ status: 302, headers: { location: callback.href }, body: "" });
  });
  await page.goto(`${origin}/streamers?dialog=profile`);
  const [, callbackResponse] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/sign-in/social")
      .then((response: Response): void => { expect(response.status()).toBe(200); }),
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/callback/twitch"),
    page.waitForEvent("framenavigated", {
      predicate: (frame): boolean => frame === page.mainFrame() && new URL(frame.url()).origin === origin,
    }),
    page.getByRole("button", { name: "Continue with Twitch" }).click(),
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
    expectHostCookie((await callback.headersArray()).find((header) => header.name.toLowerCase() === "set-cookie" && header.value.startsWith(sessionName))?.value ?? "");
    await expect.poll(() => viewer(context)).toMatchObject({ name: "Browser viewer" });
    expect(providerRequests).toContain(code);
    const cookie = (await context.cookies()).find((item) => item.name === sessionName);
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, path: "/", sameSite: "Lax" });
    const staleCookie: string = `${sessionName}=${cookie?.value}`;
    const response = await context.request.post(`${origin}/api/auth/sign-out`, { headers: { origin }, data: {} });
    expect(response.status()).toBe(200);
    const expired: string = response.headersArray().find((header) => header.name.toLowerCase() === "set-cookie" && header.value.startsWith(sessionName))?.value ?? "";
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
    const response = await context.request.post(`${origin}/api/account/delete`, { headers: { origin }, data: { confirm: "DELETE" } });
    expect(response.status()).toBe(200);
    const expired: string = response.headersArray().find((header) => header.name.toLowerCase() === "set-cookie" && header.value.startsWith(sessionName))?.value ?? "";
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
