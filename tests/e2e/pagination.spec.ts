import { newPage, close } from "./coverage";
import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext } from "./coverage";
import { z } from "zod";
import { clientAddress } from "./client-ips";

async function signedIn(browser: Browser): Promise<BrowserContext> {
  const sessions = z
    .record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }))
    .parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
  const session = sessions.paginationowner;
  if (!session) throw new Error("Pagination test account is missing.");
  const context = await browser.newContext({
    baseURL: "http://localhost:5173",
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("pagination", 50) },
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

test("older topics show fresh reactions, retain drafts, and disappear after deletion", async ({ browser }) => {
  const context = await signedIn(browser);
  const page = await newPage(context);
  await page.goto("/@pagination_host?sort=newest");
  await page.getByRole("button", { name: "Load more topics", exact: true }).click();
  const olderTopic = page.locator("#topics .topic").filter({ hasText: "Archive topic 03" });
  await olderTopic.click();
  await expect(page.getByRole("heading", { name: "Archive topic 03", exact: true })).toBeVisible();
  const draft = page.getByRole("textbox", { name: "Write a comment" });
  await draft.fill("Keep this draft while I change my vote.");
  await page.getByRole("button", { name: /^Like 0$/ }).click();
  await expect(page.getByRole("button", { name: /^Like 1$/ })).toHaveAttribute("aria-pressed", "true");
  await expect(draft).toHaveValue("Keep this draft while I change my vote.");
  await page.getByRole("button", { name: /^Like 1$/ }).click();
  await expect(page.getByRole("button", { name: /^Like 0$/ })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Load more topics", exact: true }).click();
  await expect(olderTopic).toBeVisible();
  await page.getByRole("button", { name: "Delete topic", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete topic", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Archive topic 03", exact: true })).toHaveCount(0);
  await expect(olderTopic).toHaveCount(0);
  await page.getByRole("button", { name: "Load more topics", exact: true }).click();
  await expect(page.locator("#topics .topic").filter({ hasText: "Archive topic 01" })).toBeVisible();
  await expect(olderTopic).toHaveCount(0);
  await close(context);
});

test("poll discussion refreshes when a remote comment changes the board", async ({ browser }) => {
  const context = await signedIn(browser);
  const created = await context.request.post("/api/streamers/pagination_host", {
    headers: { Origin: "http://localhost:5173" },
    data: { action: "create", kind: "binary", title: "A live discussion", duration: 0 },
  });
  expect(created.status()).toBe(200);
  const poll = z.object({ id: z.string().uuid() }).parse(await created.json());
  const page = await newPage(context);
  await page.goto(`/@pagination_host?view=polls&entry=${poll.id}`);
  await expect(page.getByText("Live updates connected", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Write a comment" }).fill("My local draft survives remote updates.");
  const posted = await context.request.post("/api/streamers/pagination_host", {
    headers: { Origin: "http://localhost:5173" },
    data: { action: "comment", id: poll.id, text: "A comment from a different connection." },
  });
  expect(posted.status()).toBe(200);
  await expect(page.getByText("A comment from a different connection.", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Write a comment" })).toHaveValue(
    "My local draft survives remote updates.",
  );
  await close(context);
});

test("the OBS overlay bounds retries, refreshes over HTTP, and reconnects on request", async ({ browser }) => {
  const owner = await signedIn(browser);
  const created = await owner.request.post("/api/streamers/pagination_host", {
    headers: { Origin: "http://localhost:5173" },
    data: { action: "create", kind: "binary", title: "An overlay recovery poll", duration: 0 },
  });
  expect(created.status()).toBe(200);
  const poll = z.object({ id: z.string().uuid() }).parse(await created.json());
  const context = await browser.newContext({
    baseURL: "http://localhost:5173",
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("pagination", 51) },
  });
  const page = await newPage(context);
  let blocked: boolean = true;
  let attempts: number = 0;
  await page.routeWebSocket("**/api/live/pagination_host", async (socket) => {
    attempts += 1;
    if (blocked) await socket.close({ code: 1013, reason: "Test outage" });
    else socket.connectToServer();
  });
  await page.clock.install({ time: Date.now() });
  await page.goto(`/@pagination_host/overlay?poll=${poll.id}`);
  await expect(page.getByRole("heading", { name: "An overlay recovery poll" })).toBeVisible();
  await expect.poll(() => attempts).toBeGreaterThan(0);
  await page.clock.pauseAt(Date.now() + 1000);
  for (let failure: number = 0; failure < 9 && attempts < 9; failure += 1) {
    const previous: number = attempts;
    await page.clock.fastForward(30_001);
    await expect.poll(() => attempts).toBeGreaterThan(previous);
  }
  await expect(page.getByText("Live updates offline.", { exact: true })).toBeVisible();
  const voted = await owner.request.post("/api/streamers/pagination_host", {
    headers: { Origin: "http://localhost:5173" },
    data: { action: "vote", id: poll.id, choice: 0 },
  });
  expect(voted.status()).toBe(200);
  await page.clock.fastForward(30_001);
  await expect(page.locator(".overlay-total")).toContainText("1 vote");
  expect(attempts).toBe(9);
  const stopped: number = attempts;
  await page.clock.fastForward(300_001);
  expect(attempts).toBe(stopped);
  blocked = false;
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.locator(".overlay-connection")).toHaveCount(0);
  await close(context);
  await close(owner);
});

test("briefly accepted connections do not renew the automatic retry budget", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://localhost:5173" });
  const page = await newPage(context);
  let attempts: number = 0;
  await page.routeWebSocket("**/api/live/pagination_host", (socket) => {
    attempts += 1;
    socket.send(JSON.stringify({ type: "snapshot", revision: 0, serverNow: Date.now(), polls: [] }));
    socket.onMessage(() => { void socket.close({ code: 1013, reason: "Seat reclaimed" }); });
  });
  await page.clock.install({ time: Date.now() });
  await page.goto("/@pagination_host/overlay");
  await expect.poll(() => attempts).toBe(1);
  await page.clock.pauseAt(Date.now() + 1000);
  for (let connection: number = 1; connection <= 9; connection += 1) {
    await page.clock.fastForward(20_001);
    if (connection < 9) {
      await page.clock.fastForward(30_001);
      await expect.poll(() => attempts).toBe(connection + 1);
    }
  }
  await expect(page.getByText("Live updates offline.", { exact: true })).toBeVisible();
  await page.clock.fastForward(300_001);
  expect(attempts).toBe(9);
  await close(context);
});

test("the owner's overlay controller offers reconnect after its retry budget expires", async ({ browser }) => {
  const context = await signedIn(browser);
  const page = await newPage(context);
  let blocked: boolean = true;
  let attempts: number = 0;
  let recovered: boolean = false;
  await page.routeWebSocket("**/api/live/pagination_host", async (socket) => {
    attempts += 1;
    if (blocked) await socket.close({ code: 1013, reason: "Test outage" });
    else {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        socket.send(message);
        if (typeof message !== "string" || !message.startsWith("{")) return;
        const update: unknown = JSON.parse(message);
        if (typeof update === "object" && update !== null && "type" in update && update.type === "snapshot")
          recovered = true;
      });
    }
  });
  await page.clock.install({ time: Date.now() });
  await page.goto("/overlay-control");
  await expect.poll(() => attempts).toBeGreaterThan(0);
  await page.clock.pauseAt(Date.now() + 1000);
  for (let failure: number = 0; failure < 9 && attempts < 9; failure += 1) {
    const previous: number = attempts;
    await page.clock.fastForward(30_001);
    await expect.poll(() => attempts).toBeGreaterThan(previous);
  }
  await expect(page.locator(".ov-conn")).toContainText("Live updates offline.");
  expect(attempts).toBe(9);
  blocked = false;
  await page.locator(".ov-conn").getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => recovered).toBe(true);
  expect(attempts).toBe(10);
  await expect(page.locator(".ov-conn")).toHaveCount(0);
  await close(context);
});
