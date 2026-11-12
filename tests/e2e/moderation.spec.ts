import { close } from "./coverage";
import { readFile } from "node:fs/promises";
import { test, expect, type Browser, type BrowserContext } from "./coverage";
import { z } from "zod";
import { clientIp } from "./client-ips";

const origin: string = "http://localhost:5173";
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));
const directorySchema = z.object({
  streamers: z.array(z.object({ handle: z.string(), isOfficial: z.boolean(), status: z.string() })),
  nextCursor: z.string().nullable(),
});
const boardSchema = z.object({
  streamer: z.object({ status: z.string(), statusReason: z.string().nullable() }),
  entries: z.array(z.object({ id: z.string(), kind: z.string(), title: z.string(), status: z.string().nullable() })),
});

async function signedIn(browser: Browser, role: string, ip: number): Promise<BrowserContext> {
  const sessions = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
  const session = sessions[role];
  if (!session) throw new Error("Unknown test account.");
  const context = await browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${ip}`, Origin: origin },
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

test("the directory pins the official page and hides suspended pages", async ({ request }) => {
  const directory = directorySchema.parse(await (await request.get("/api/streamers")).json());
  expect(directory.streamers[0]).toEqual({ handle: "streambullets", isOfficial: true, status: "active" });
  const handles = directory.streamers.map((streamer) => streamer.handle);
  expect(handles).toContain("frozen_host");
  expect(handles).not.toContain("suspended_host");
  const official = boardSchema.parse(await (await request.get("/api/streamers/streambullets")).json());
  expect(official.entries.map((entry) => [entry.title, entry.status])).toEqual([
    ["Dark mode for the overlay", "planned"],
  ]);
});

test("a suspended page is hidden from everyone but its owner and admins", async ({ browser, request, page }) => {
  expect((await request.get("/api/streamers/suspended_host")).status()).toBe(404);
  expect((await page.goto("/@suspended_host"))?.status()).toBe(404);
  expect((await page.goto("/@suspended_host/overlay"))?.status()).toBe(404);
  const viewer = await signedIn(browser, "viewer", clientIp("moderation", 60));
  expect((await viewer.request.get("/api/streamers/suspended_host")).status()).toBe(404);
  const owner = await signedIn(browser, "suspendedowner", clientIp("moderation", 61));
  const board = boardSchema.parse(await (await owner.request.get("/api/streamers/suspended_host")).json());
  expect(board.streamer).toEqual({ status: "suspended", statusReason: "Repeated spam" });
  const edit = await owner.request.patch("/api/streamer", { data: { about: "Let me back in" } });
  expect(edit.status()).toBe(423);
  const admin = await signedIn(browser, "admin", clientIp("moderation", 62));
  expect((await admin.request.get("/api/streamers/suspended_host")).status()).toBe(200);
  await Promise.all([close(viewer), close(owner), close(admin)]);
});

test("a frozen page stays public but refuses every write", async ({ browser, request }) => {
  const board = boardSchema.parse(await (await request.get("/api/streamers/frozen_host?kind=polls")).json());
  expect(board.streamer).toEqual({ status: "frozen", statusReason: null });
  const poll = board.entries.find((entry) => entry.title === "Frozen poll");
  expect(poll).toBeDefined();
  const viewer = await signedIn(browser, "viewer", clientIp("moderation", 63));
  const vote = await viewer.request.post("/api/streamers/frozen_host", {
    data: { action: "vote", id: poll?.id, choice: 0 },
  });
  expect(vote.status()).toBe(423);
  const owner = await signedIn(browser, "frozenowner", clientIp("moderation", 64));
  const own = boardSchema.parse(await (await owner.request.get("/api/streamers/frozen_host")).json());
  expect(own.streamer.statusReason).toBe("Under review");
  expect((await owner.request.patch("/api/streamer", { data: { name: "Thawed" } })).status()).toBe(423);
  await Promise.all([close(viewer), close(owner)]);
});

test("profile settings are saved per account", async ({ browser }) => {
  const viewer = await signedIn(browser, "viewer", clientIp("moderation", 65));
  try {
    const before = (await (await viewer.request.get("/api/me")).json()) as { viewer: Record<string, unknown> };
    expect(before.viewer).toMatchObject({
      avatarPreset: 3,
      locale: "en",
      displayPrefs: { contrast: "high", text: "115" },
    });
    expect((await viewer.request.patch("/api/me/locale", { data: { locale: "de" } })).status()).toBe(200);
    expect((await viewer.request.patch("/api/profile", { data: { avatarPreset: 14 } })).status()).toBe(200);
    const after = (await (await viewer.request.get("/api/me")).json()) as { viewer: Record<string, unknown> };
    expect(after.viewer).toMatchObject({ avatarPreset: 14, locale: "de" });
  } finally {
    // Restore the shared viewer language even on failure.
    const restored = [
      (await viewer.request.patch("/api/me/locale", { data: { locale: "en" } })).status(),
      (await viewer.request.patch("/api/profile", { data: { avatarPreset: 3 } })).status(),
    ];
    await close(viewer);
    expect(restored, "restores the shared viewer's locale and avatar").toEqual([200, 200]);
  }
});
