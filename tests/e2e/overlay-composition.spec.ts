import type { Locator, WebSocketRoute } from "@playwright/test";
import { newPage, close, test, expect, type Browser, type Page } from "./coverage";
import { runSql } from "./fixtures";
import { signedIn } from "./live-helpers";
import { clientIp } from "./client-ips";
import type { ActivityChat, ActivityEvent, ActivityPlatform } from "../../app/lib/activity";
import { DEFAULT_LAYERS } from "../../app/lib/overlay-layers";

const OWNER_IP = clientIp("overlay-composition", 240);
const OBS_IP = clientIp("overlay-composition", 241);
const GEOMETRY_IP = clientIp("overlay-composition", 242);
const CHARACTERS_IP = clientIp("overlay-composition", 243);
const COMMANDS_IP = clientIp("overlay-composition", 244);
const DESIGN_IP = clientIp("overlay-composition", 250);
// Set OBS_SHOT_DIR to a folder to save the OBS composition screenshots of the design-space test.
const shotDir: string | undefined = process.env.OBS_SHOT_DIR;

const resetLayers = `UPDATE overlay_state SET layers='{"chat":{"enabled":true}}', revision=revision+1 WHERE streamer_id=(SELECT id FROM streamers WHERE handle='feature_host');`;

test.afterAll(async () => {
  await runSql("overlay-composition-cleanup", [
    `UPDATE overlay_state SET layers='{}', revision=revision+1 WHERE streamer_id=(SELECT id FROM streamers WHERE handle='feature_host');`,
  ]);
});

function chat(index: number, receivedAt: number): ActivityChat {
  const messageId = `e2e-${index}`;
  return {
    kind: "chat",
    id: `twitch:${messageId}`,
    platform: "twitch",
    channelId: "e2e-channel",
    messageId,
    user: { id: `e2e-user-${index}`, displayName: `Scav ${index}` },
    text: `Hello from the bunker ${index}`,
    fragments: [{ type: "text", text: `Hello from the bunker ${index}` }],
    badges: [],
    sentAt: null,
    receivedAt,
    live: false,
  };
}

test("a per-layer chat source shows and hides the chat live when the owner changes the layer", async ({ browser }) => {
  await runSql("overlay-composition-reset", [resetLayers]);
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const obs = await newPage(browser, { viewport: { width: 420, height: 640 } });
  let activitySockets: number = 0;
  await obs.routeWebSocket("**/api/activity/**", (socket) => {
    activitySockets += 1;
    socket.send(JSON.stringify({ type: "snapshot", events: [chat(1, Date.now())], replay: true }));
  });
  await obs.goto("/@feature_host/overlay?key=e2e-key&layer=chat");
  const chatLayer = obs.locator("[data-overlay-chat]");
  await expect(chatLayer.getByText("Hello from the bunker 1")).toBeVisible();
  // A chat source renders the chat alone: no on-air content.
  await expect(obs.locator(".ov-stage")).toHaveCount(0);
  // The icon is hidden from assistive technology; screen readers read the platform name as text.
  await expect(chatLayer.locator("svg.wl-icon")).toHaveAttribute("aria-hidden", "true");
  await expect(chatLayer.locator("li.wl-item")).toContainText("Twitch");
  // Mark the document: a reload would drop the mark.
  await obs.evaluate(() => document.documentElement.setAttribute("data-e2e-loaded", "1"));

  const hide = await owner.request.post("/api/overlay", { data: { action: "layers", chat: { enabled: false } } });
  expect(hide.status()).toBe(200);
  await expect(chatLayer).toHaveCount(0);

  const show = await owner.request.post("/api/overlay", {
    data: { action: "layers", chat: { enabled: true, rect: CHAT_RECT } },
  });
  expect(show.status()).toBe(200);
  await expect(chatLayer.getByText("Hello from the bunker 1")).toBeVisible();
  await expect(obs.locator("html")).toHaveAttribute("data-e2e-loaded", "1");
  // Hiding closed the activity socket and showing opened a new one.
  expect(activitySockets).toBe(2);
  await close(owner);
});

test("an unknown layer renders an empty transparent page", async ({ page }) => {
  await page.goto("/@feature_host/overlay?layer=nope");
  await expect(page.locator("main.overlay-screen")).toBeAttached();
  expect(await page.locator("main.overlay-screen").evaluate((element) => element.childElementCount)).toBe(0);
});

const FEATURE_HOST = "(SELECT id FROM streamers WHERE handle='feature_host')";
const CHAT_RECT = { x: 1460, y: 280, w: 420, h: 640 } as const;

function setLayers(name: string, layers: object): Promise<void> {
  return runSql(name, [
    `UPDATE overlay_state SET layers='${JSON.stringify(layers)}', revision=revision+1 WHERE streamer_id=${FEATURE_HOST};`,
  ]);
}

interface Message {
  platform: ActivityPlatform;
  id: string;
  user: string;
  text: string;
  receivedAt?: number;
  sentAt?: number | null;
}

function message({ platform, id, user, text, receivedAt, sentAt }: Message): ActivityChat {
  return {
    kind: "chat",
    id: `${platform}:${id}`,
    platform,
    channelId: `e2e-${platform}`,
    messageId: id,
    user: { id: `${platform}-${user}`, displayName: user },
    text,
    fragments: [{ type: "text", text }],
    badges: [],
    sentAt: sentAt ?? null,
    receivedAt: receivedAt ?? Date.now(),
    live: true,
  };
}

function event(value: ActivityEvent): string {
  return JSON.stringify({ type: "event", event: value });
}

function snapshot(events: readonly ActivityEvent[]): string {
  return JSON.stringify({
    type: "snapshot",
    events: events.map((item) => ({ ...item, live: false })),
    replay: true,
  });
}

interface ChatSource {
  page: Page;
  chat: Locator;
  rows: Locator;
  sockets: WebSocketRoute[];
  /** Sends a frame on the newest activity socket. */
  send(frame: string): void;
}

/**
 * An OBS chat source with a mocked activity feed. `opened(n)` gives the snapshot frame of the nth socket (0-based).
 */
async function chatSource(
  browser: Browser,
  opened: (index: number) => string = () => snapshot([]),
  path: string = "/@feature_host/overlay?key=e2e-key&layer=chat",
  // A source sized like the default chat layer.
  viewport: { width: number; height: number } = { width: DEFAULT_LAYERS.chat.rect.w, height: DEFAULT_LAYERS.chat.rect.h },
): Promise<ChatSource> {
  const page = await newPage(browser, {
    viewport,
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${OBS_IP}` },
  });
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/activity/**", (socket) => {
    const index: number = sockets.length;
    sockets.push(socket);
    socket.send(opened(index));
  });
  await page.goto(path);
  await expect.poll(() => sockets.length).toBe(1);
  const chat = page.locator("[data-overlay-chat]");
  await expect(chat).toBeAttached();
  return {
    page,
    chat,
    rows: chat.locator("li.wl-item"),
    sockets,
    send(frame: string): void {
      const socket: WebSocketRoute | undefined = sockets.at(-1);
      if (!socket) throw new Error("No activity socket.");
      socket.send(frame);
    },
  };
}

/** The running animations of each chat row, read in the first frame that shows `count` rows. */
function animationsWhenRows(page: Page, count: number): Promise<number[]> {
  return page.evaluate(
    (expected: number) =>
      new Promise<number[]>((resolve) => {
        const check = (): void => {
          const items: Element[] = [...document.querySelectorAll("[data-overlay-chat] li.wl-item")];
          if (items.length === expected) resolve(items.map((item: Element): number => item.getAnimations().length));
          else requestAnimationFrame(check);
        };
        check();
      }),
    count,
  );
}

async function rowTexts(rows: Locator): Promise<string[]> {
  return rows.locator(".wl-msg").allTextContents();
}

test.describe("merged chat on the overlay", () => {
  test.beforeEach(async () => {
    await setLayers("overlay-chat-reset", { chat: { enabled: true } });
  });

  test("rows from all three platforms keep arrival order and name their platform", async ({ browser }) => {
    const source = await chatSource(browser);
    const now: number = Date.now();
    // Send times and receive times run backwards: only arrival order counts.
    source.send(
      event(
        message({
          platform: "twitch",
          id: "o1",
          user: "Rust",
          text: "first in",
          receivedAt: now,
          sentAt: now,
        }),
      ),
    );
    source.send(
      event(
        message({
          platform: "youtube",
          id: "o2",
          user: "Ngozi",
          text: "second in",
          receivedAt: now - 5_000,
          sentAt: now - 6_000,
        }),
      ),
    );
    source.send(
      event(
        message({
          platform: "kick",
          id: "o3",
          user: "Maxine",
          text: "third in",
          receivedAt: now - 9_000,
          sentAt: now - 9_500,
        }),
      ),
    );
    await expect.poll(() => rowTexts(source.rows)).toEqual(["first in", "second in", "third in"]);
    const names: [number, string][] = [
      [0, "Twitch"],
      [1, "YouTube"],
      [2, "Kick"],
    ];
    for (const [index, name] of names) {
      await expect(source.rows.nth(index).locator(".sr-only")).toHaveText(name);
      await expect(source.rows.nth(index).locator("svg.wl-icon")).toHaveAttribute("aria-hidden", "true");
    }
    expect(await source.rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-platform")))).toEqual([
      "twitch",
      "youtube",
      "kick",
    ]);
    await close(source.page);
  });

  test("moderation removes a deleted message, then a cleared or banned user's messages", async ({ browser }) => {
    const now: number = Date.now();
    const keep = message({
      platform: "twitch",
      id: "m-keep",
      user: "Calm",
      text: "stays on screen",
      receivedAt: now,
    });
    const gone = message({
      platform: "twitch",
      id: "m-gone",
      user: "Calm",
      text: "deleted soon",
      receivedAt: now,
    });
    const loud1 = message({
      platform: "twitch",
      id: "m-l1",
      user: "Loud",
      text: "loud one",
      receivedAt: now,
    });
    const loud2 = message({
      platform: "twitch",
      id: "m-l2",
      user: "Loud",
      text: "loud two",
      receivedAt: now,
    });
    const kicker = message({
      platform: "kick",
      id: "m-k1",
      user: "Banned",
      text: "kick spam",
      receivedAt: now,
    });
    const source = await chatSource(browser, () => snapshot([keep, gone, loud1, loud2, kicker]));
    await expect(source.rows).toHaveCount(5);

    // Watched in the page on every DOM change: the fade lasts only 300 ms.
    const fadeSeen: Promise<number> = source.page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const list: Element | null = document.querySelector("[data-overlay-chat]");
          if (!list) return resolve(0);
          const observer = new MutationObserver((): void => {
            const card: Element | null = list.querySelector("li[data-gone] .wl-card");
            if (!card) return;
            observer.disconnect();
            resolve(card.getAnimations().length);
          });
          observer.observe(list, { subtree: true, childList: true, attributes: true });
        }),
    );
    source.send(
      event({
        kind: "delete",
        platform: "twitch",
        messageId: "m-gone",
        receivedAt: Date.now(),
      }),
    );
    const deleted = source.chat.locator('li[data-phase="removed"]');
    await expect(deleted).toHaveCount(1);
    await expect(deleted).toContainText("message removed by a moderator");
    await expect(source.chat.getByText("deleted soon")).toHaveCount(0);
    // After its hold the removed row fades out (data-gone, with a running fade) before it goes.
    expect(await fadeSeen).toBeGreaterThanOrEqual(1);
    await expect(source.rows).toHaveCount(4);
    await expect(source.chat.locator("li[data-gone]")).toHaveCount(0);

    source.send(
      event({
        kind: "clear_user",
        platform: "twitch",
        userId: "twitch-Loud",
        receivedAt: Date.now(),
      }),
    );
    await expect(deleted).toHaveCount(2);
    await expect(deleted.locator(".wl-msg")).toHaveText([
      "message removed by a moderator",
      "message removed by a moderator",
    ]);
    await expect(source.rows).toHaveCount(2);

    source.send(
      event({
        kind: "ban",
        platform: "kick",
        userId: "kick-Banned",
        until: null,
        receivedAt: Date.now(),
      }),
    );
    await expect(source.rows).toHaveCount(1);
    await expect(source.rows.locator(".wl-msg")).toHaveText("stays on screen");
    await close(source.page);
  });

  test("after a live layer resize, the next row moves the old rows by one row only", async ({ browser }) => {
    await setLayers("overlay-chat-resize", { chat: { enabled: true, rect: CHAT_RECT } });
    const owner = await signedIn(browser, "featureowner", OWNER_IP);
    const long = "a long message that wraps onto more than one line in a narrow chat layer";
    const rows: ActivityChat[] = [1, 2, 3].map((index: number) =>
      message({ platform: "twitch", id: `rs-${index}`, user: `Wrap ${index}`, text: `${long} ${index}` }),
    );
    const source = await chatSource(browser, () => snapshot(rows));
    try {
      await expect(source.rows).toHaveCount(3);
      const canvas = source.page.locator(".ov-layer-canvas");
      const resized = await owner.request.post("/api/overlay", {
        data: { action: "layers", chat: { enabled: true, rect: { x: 1200, y: 80, w: 700, h: 840 } } },
      });
      expect(resized.status()).toBe(200);
      await expect(canvas).toHaveCSS("height", "840px");
      await expect(canvas).toHaveCSS("width", "700px");
      // Let the resize settle (the resize observer runs before the next paint).
      await source.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const starts: Promise<{ offsets: number[]; step: number }> = source.page.evaluate(
        () =>
          new Promise<{ offsets: number[]; step: number }>((resolve) => {
            const check = (): void => {
              const items: HTMLElement[] = [
                ...document.querySelectorAll<HTMLElement>("[data-overlay-chat] li.wl-item"),
              ];
              if (items.length < 4) {
                requestAnimationFrame(check);
                return;
              }
              const list: Element | null = document.querySelector("[data-overlay-chat]");
              const gap: number = list ? Number.parseFloat(getComputedStyle(list).rowGap) || 0 : 0;
              const offsets: number[] = items.map((item: HTMLElement): number => {
                const effect = item.getAnimations()[0]?.effect;
                const first = effect instanceof KeyframeEffect ? effect.getKeyframes()[0] : undefined;
                const transform: string = typeof first?.transform === "string" ? first.transform : "";
                return Number.parseFloat(/translateY\((-?[\d.]+)px\)/.exec(transform)?.[1] ?? "NaN");
              });
              resolve({ offsets, step: (items.at(-1)?.offsetHeight ?? 0) + gap });
            };
            check();
          }),
      );
      source.send(event(message({ platform: "kick", id: "rs-4", user: "Short", text: "short" })));
      const { offsets, step } = await starts;
      // Every row, old or new, starts one new row (its height and the gap) below its place.
      for (const offset of offsets) expect(Math.abs(offset - step)).toBeLessThanOrEqual(1);
    } finally {
      await close(source.page);
      await close(owner);
    }
  });

  test("with reduced motion, a live row and a removed row do not animate", async ({ browser }) => {
    const first = message({ platform: "twitch", id: "rm-1", user: "Still", text: "still one" });
    const second = message({ platform: "youtube", id: "rm-2", user: "Still", text: "still two" });
    const source = await chatSource(browser, () => snapshot([first, second]));
    // The page reads the setting when it loads.
    await source.page.emulateMedia({ reducedMotion: "reduce" });
    await source.page.reload();
    await expect.poll(() => source.sockets.length).toBe(2);
    await expect(source.page.locator("html")).toHaveAttribute("data-reduced", "true");
    await expect(source.rows).toHaveCount(2);
    const motion: Promise<number[]> = animationsWhenRows(source.page, 3);
    source.send(event(message({ platform: "kick", id: "rm-3", user: "Still", text: "still three" })));
    expect(await motion).toEqual([0, 0, 0]);
    source.send(event({ kind: "delete", platform: "twitch", messageId: "rm-1", receivedAt: Date.now() }));
    await expect(source.chat.locator('li[data-phase="removed"]')).toHaveCount(1);
    // Without motion the removed row goes at the end of its hold, without a fade.
    await expect(source.rows).toHaveCount(2);
    await expect(source.chat.locator("li[data-gone]")).toHaveCount(0);
    expect(await source.rows.evaluateAll((items) => items.map((item) => item.getAnimations().length))).toEqual([0, 0]);
    await close(source.page);
  });

  test("hide commands hides !jump; turning it off shows !jump", async ({ browser }) => {
    let source = await chatSource(browser);
    source.send(event(message({ platform: "kick", id: "c1", user: "Jumper", text: "!jump" })));
    source.send(
      event(
        message({
          platform: "kick",
          id: "c2",
          user: "Jumper",
          text: "after the command",
        }),
      ),
    );
    await expect(source.rows).toHaveCount(1);
    await expect(source.rows.locator(".wl-msg")).toHaveText("after the command");
    await close(source.page);

    await setLayers("overlay-chat-commands", {
      chat: { enabled: true, hideCommands: false },
    });
    source = await chatSource(browser);
    source.send(event(message({ platform: "kick", id: "c3", user: "Jumper", text: "!jump" })));
    source.send(
      event(
        message({
          platform: "kick",
          id: "c4",
          user: "Jumper",
          text: "after the command",
        }),
      ),
    );
    await expect.poll(() => rowTexts(source.rows)).toEqual(["!jump", "after the command"]);
    await close(source.page);
  });

  test("a reconnect snapshot neither animates nor duplicates rows", async ({ browser }) => {
    const now: number = Date.now();
    const a = message({
      platform: "twitch",
      id: "r-a",
      user: "Ada",
      text: "row a",
      receivedAt: now - 3_000,
    });
    const b = message({
      platform: "youtube",
      id: "r-b",
      user: "Bo",
      text: "row b",
      receivedAt: now - 2_000,
    });
    const c = message({
      platform: "kick",
      id: "r-c",
      user: "Cy",
      text: "row c",
      receivedAt: now - 1_000,
    });
    const d = message({
      platform: "twitch",
      id: "r-d",
      user: "Di",
      text: "row d",
      receivedAt: now + 500,
    });
    const source = await chatSource(browser, (index: number) =>
      index === 0 ? snapshot([a, b]) : snapshot([a, b, c, d]),
    );
    await expect(source.rows).toHaveCount(2);
    // Snapshot rows never slide in.
    await expect(source.chat.locator("li[data-enter]")).toHaveCount(0);
    await expect(source.chat.locator('li[data-phase="entering"]')).toHaveCount(0);

    // A live row slides in and the rows above it move up: each row has a running animation in the first frame.
    const motion: Promise<number[]> = animationsWhenRows(source.page, 3);
    source.send(event(c));
    expect((await motion).every((count: number): boolean => count >= 1)).toBe(true);
    await expect(source.rows).toHaveCount(3);
    await expect(source.rows.nth(2)).toHaveAttribute("data-enter", "true");
    await expect(source.rows.nth(2)).toHaveAttribute("data-phase", "shown");
    // Mark the rendered rows: a remount (and its animation) would drop the mark.
    await source.rows.evaluateAll((items) => items.forEach((item) => item.setAttribute("data-e2e-kept", "1")));

    await source.sockets[0].close();
    await expect.poll(() => source.sockets.length).toBe(2);
    await expect.poll(() => rowTexts(source.rows)).toEqual(["row a", "row b", "row c", "row d"]);
    await expect(source.chat.locator("li[data-e2e-kept]")).toHaveCount(3);
    // The new snapshot row and the old rows show at once, without an entering state.
    await expect(source.chat.locator('li[data-phase="entering"]')).toHaveCount(0);
    await expect(source.rows.nth(3)).not.toHaveAttribute("data-enter");
    await expect(source.rows.nth(3)).toHaveAttribute("data-phase", "shown");
    await expect(source.rows.nth(0)).not.toHaveAttribute("data-enter");
    // Nothing slides or fades in: a snapshot shows its rows in place.
    expect(await source.rows.evaluateAll((items) => items.map((item) => item.getAnimations().length))).toEqual([
      0, 0, 0, 0,
    ]);
    await close(source.page);
  });

  test("an unavailable message clears the chat", async ({ browser }) => {
    const rows = [
      message({
        platform: "twitch",
        id: "u1",
        user: "Ada",
        text: "before the new key",
      }),
      message({ platform: "kick", id: "u2", user: "Bo", text: "also before" }),
    ];
    const source = await chatSource(browser, (index: number) => snapshot(index === 0 ? rows : []));
    await expect(source.rows).toHaveCount(2);
    source.send(JSON.stringify({ type: "unavailable" }));
    await expect(source.rows).toHaveCount(0);
    // The source keeps trying, and the next snapshot is empty.
    await expect.poll(() => source.sockets.length).toBe(2);
    await expect(source.rows).toHaveCount(0);
    await close(source.page);
  });

  test("message text with markup renders as literal text", async ({ browser }) => {
    const unsafe = "<img src=x onerror=alert(1)>";
    const source = await chatSource(browser);
    const dialogs: string[] = [];
    source.page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      void dialog.dismiss();
    });
    source.send(
      event(
        message({
          platform: "youtube",
          id: "x1",
          user: "<b>bold</b>",
          text: unsafe,
        }),
      ),
    );
    await expect(source.rows.locator(".wl-msg")).toHaveText(unsafe);
    await expect(source.rows.locator(".wl-user")).toContainText("<b>bold</b>");
    await expect(source.chat.locator("img, b")).toHaveCount(0);
    expect(dialogs).toEqual([]);
    await close(source.page);
  });
});

test("the chat layer has the same geometry on the OBS composition and in the editor preview", async ({ browser }) => {
  await setLayers("overlay-geometry-reset", {
    chat: { enabled: true, rect: CHAT_RECT },
  });
  const source = await chatSource(
    browser,
    () =>
      snapshot([
        message({
          platform: "twitch",
          id: "g1",
          user: "Ada",
          text: "geometry",
        }),
      ]),
    "/@feature_host/overlay?key=e2e-key",
    { width: 1920, height: 1080 },
  );
  const obsLayer = source.page.locator('.ov-layer[data-layer="chat"]');
  await expect(obsLayer).toHaveAttribute("data-scaled", "true");
  const obsBox = await obsLayer.boundingBox();
  if (!obsBox) throw new Error("No chat layer on the OBS page.");
  expect(Math.abs(obsBox.x - CHAT_RECT.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(obsBox.y - CHAT_RECT.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(obsBox.width - CHAT_RECT.w)).toBeLessThanOrEqual(2);
  expect(Math.abs(obsBox.height - CHAT_RECT.h)).toBeLessThanOrEqual(2);
  await close(source.page);

  const owner = await signedIn(browser, "featureowner", GEOMETRY_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  const activity: string[] = [];
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/api/activity/")) activity.push(socket.url());
  });
  await page.goto("/overlay-control");
  const frame = page.getByRole("region", { name: "Composition preview" });
  await expect(frame).toHaveAttribute("data-scaled", "true");
  const layer = frame.locator('.ov-layer[data-layer="chat"]');
  await expect(layer).toHaveAttribute("data-scaled", "true");
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  const scale: number = await frame.evaluate((element: Element) => element.clientWidth / 1920);
  const scaler = await frame.locator(".ov-scaler").boundingBox();
  const box = await layer.boundingBox();
  if (!scaler || !box) throw new Error("No preview geometry.");
  expect(Math.abs(scaler.width - 1920 * scale)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.x - scaler.x - CHAT_RECT.x * scale)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y - scaler.y - CHAT_RECT.y * scale)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.width - CHAT_RECT.w * scale)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.height - CHAT_RECT.h * scale)).toBeLessThanOrEqual(2);
  // The preview plays sample chat and opens no activity socket.
  await expect(layer.locator("li.wl-item").first()).toBeVisible();
  expect(activity).toEqual([]);
  await close(owner);
});

for (const viewport of [
  { width: 800, height: 600 },
  { width: 1920, height: 1080 },
]) {
  test(`a per-layer chat source at ${viewport.width}x${viewport.height} fits the layer and keeps the newest row in view`, async ({
    browser,
  }) => {
    // The OBS source ratio differs from the layer's 420:640: the layer scales to fit and sits bottom-right.
    await setLayers("overlay-fit-reset", { chat: { enabled: true, rect: CHAT_RECT } });
    const now: number = Date.now();
    const rows: ActivityChat[] = Array.from({ length: 24 }, (_, index: number) =>
      message({ platform: "kick", id: `fit-${index}`, user: `Scav ${index}`, text: `row ${index}`, receivedAt: now - 24_000 + index * 1000 }),
    );
    const source = await chatSource(browser, () => snapshot(rows), undefined, viewport);
    const layer = source.page.locator('.ov-layer[data-layer="chat"]');
    await expect(layer).toHaveAttribute("data-scaled", "true");
    await expect(source.rows.last()).toContainText("row 23");
    const scale: number = Math.min(viewport.width / CHAT_RECT.w, viewport.height / CHAT_RECT.h);
    const canvas = await layer.locator(".ov-layer-canvas").boundingBox();
    if (!canvas) throw new Error("No chat canvas.");
    // Contain scaling, anchored to the bottom-right corner.
    expect(Math.abs(canvas.width - CHAT_RECT.w * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(canvas.height - CHAT_RECT.h * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(canvas.x + canvas.width - viewport.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(canvas.y + canvas.height - viewport.height)).toBeLessThanOrEqual(2);
    // The newest row is whole and inside the viewport.
    const newest = await source.rows.last().boundingBox();
    if (!newest) throw new Error("No newest row.");
    expect(newest.x).toBeGreaterThanOrEqual(-1);
    expect(newest.y).toBeGreaterThanOrEqual(-1);
    expect(newest.x + newest.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(newest.y + newest.height).toBeLessThanOrEqual(viewport.height + 1);
    await expect(source.page.locator("main.overlay-screen")).toHaveAttribute("data-feed-status", "live");
    await close(source.page);
  });
}

test("a characters-only source opens no sockets while the characters layer cannot render", async ({ browser }) => {
  await setLayers("overlay-characters-reset", { chat: { enabled: true }, characters: { enabled: true } });
  const page = await newPage(browser, { extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${CHARACTERS_IP}` } });
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(new URL(socket.url()).pathname));
  await page.goto("/@feature_host/overlay?key=e2e-key&layer=characters");
  const main = page.locator("main.overlay-screen");
  // This assumes that the route opens its sockets (live room and activity) in effects of its first commit, and that
  // no later state change opens one. If a socket opened later, for example after a timer, this check would miss it.
  await expect(main).toHaveAttribute("data-feed-status", "off");
  // The layer box sets data-scaled in an effect, so the page is hydrated and its first effects ran.
  await expect(main.locator('.ov-layer[data-layer="characters"]')).toHaveAttribute("data-scaled", "true");
  // Let the effects of that commit finish: the route opens its sockets in the same flush, after its children.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
  );
  expect(sockets).toEqual([]);
  await close(page);
});

test("turning on hide commands removes a command row from an open chat source", async ({ browser }) => {
  await setLayers("overlay-commands-reset", { chat: { enabled: true, hideCommands: false } });
  const owner = await signedIn(browser, "featureowner", COMMANDS_IP);
  const source = await chatSource(browser, () =>
    snapshot([
      message({ platform: "kick", id: "h1", user: "Jumper", text: "!jump" }),
      message({ platform: "twitch", id: "h2", user: "Calm", text: "not a command" }),
    ]),
  );
  await expect.poll(() => rowTexts(source.rows)).toEqual(["!jump", "not a command"]);
  // Mark the document: a reload would drop the mark.
  await source.page.evaluate(() => document.documentElement.setAttribute("data-e2e-loaded", "1"));
  const hide = await owner.request.post("/api/overlay", { data: { action: "layers", chat: { hideCommands: true } } });
  expect(hide.status()).toBe(200);
  await expect.poll(() => rowTexts(source.rows)).toEqual(["not a command"]);
  await expect(source.page.locator("html")).toHaveAttribute("data-e2e-loaded", "1");
  expect(source.sockets).toHaveLength(1);
  await close(source.page);
  await close(owner);
});

interface DesignRects {
  poll: { x: number; y: number; w: number; h: number };
  chat: { x: number; y: number; w: number; h: number };
}

/** The design-space (1920-wide) rects of the poll card and the chat box: screen boxes divided by `scale`. */
async function designRects(
  poll: Locator,
  chatBox: Locator,
  origin: { x: number; y: number },
  scale: number,
): Promise<DesignRects> {
  const toDesign = async (locator: Locator): Promise<DesignRects["poll"]> => {
    const box = await locator.boundingBox();
    if (!box) throw new Error("No box.");
    return {
      x: (box.x - origin.x) / scale,
      y: (box.y - origin.y) / scale,
      w: box.width / scale,
      h: box.height / scale,
    };
  };
  return { poll: await toDesign(poll), chat: await toDesign(chatBox) };
}

function expectSameRects(actual: DesignRects, expected: DesignRects): void {
  for (const key of ["poll", "chat"] as const)
    for (const side of ["x", "y", "w", "h"] as const)
      expect(Math.abs(actual[key][side] - expected[key][side]), `${key}.${side}`).toBeLessThanOrEqual(2);
}

test("with chat on, the OBS composition matches the editor preview at 1280x720 and 1920x1080", async ({ browser }) => {
  // The seeded on-air poll and the default chat rect, which covers the lower part of the poll.
  await runSql("overlay-design-air", [
    `UPDATE overlay_state SET air=json_object('type','poll','ref',(SELECT id FROM entries WHERE streamer_id=${FEATURE_HOST} AND title='Which boss first?')), layers='{"chat":{"enabled":true}}', revision=revision+1 WHERE streamer_id=${FEATURE_HOST};`,
  ]);
  try {
    const owner = await signedIn(browser, "featureowner", DESIGN_IP);
    const editor = await newPage(owner);
    await editor.setViewportSize({ width: 1440, height: 900 });
    await editor.goto("/overlay-control");
    const frame = editor.getByRole("region", { name: "Composition preview" });
    await expect(frame).toHaveAttribute("data-scaled", "true");
    await expect(frame.locator(".ov-stage > *").first()).toBeVisible();
    await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
    const previewScale: number = await frame.evaluate((element: Element) => element.clientWidth / 1920);
    const scaler = await frame.locator(".ov-scaler").boundingBox();
    if (!scaler) throw new Error("No preview scaler.");
    const preview: DesignRects = await designRects(
      frame.locator(".ov-stage > *").first(),
      frame.locator('.ov-layer[data-layer="chat"]'),
      scaler,
      previewScale,
    );
    // The default chat rect, in the preview.
    const { x, y, w, h } = DEFAULT_LAYERS.chat.rect;
    expectSameRects(preview, { poll: preview.poll, chat: { x, y, w, h } });
    await close(owner);

    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
    ]) {
      const rows: ActivityChat[] = [
        message({ platform: "twitch", id: "d1", user: "Ada", text: "Radahn first, obviously" }),
        message({ platform: "youtube", id: "d2", user: "Mika", text: "Fire Giant is the real boss 🔥" }),
        message({ platform: "kick", id: "d3", user: "Rook", text: "Malenia or nothing" }),
      ];
      const source = await chatSource(browser, () => snapshot(rows), "/@feature_host/overlay?key=e2e-key", viewport);
      const page: Page = source.page;
      await expect(page.locator(".ov-design")).toHaveAttribute("data-scaled", "true");
      const poll = page.locator(".ov-stage > *").first();
      await expect(poll).toBeVisible();
      await expect(source.rows).toHaveCount(rows.length);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const obs: DesignRects = await designRects(
        poll,
        page.locator('.ov-layer[data-layer="chat"]'),
        { x: 0, y: 0 },
        viewport.width / 1920,
      );
      expectSameRects(obs, preview);
      if (shotDir) await page.screenshot({ path: `${shotDir}/r3-obs-${viewport.height}.png` });
      await close(page);
    }
  } finally {
    await runSql("overlay-design-restore", [
      `UPDATE overlay_state SET air='{"type":"auto","ref":null}', layers='{}', revision=revision+1 WHERE streamer_id=${FEATURE_HOST};`,
    ]);
  }
});

test("without a feed layer, the OBS composition keeps the responsive content layout", async ({ browser }) => {
  await setLayers("overlay-design-off", {});
  const page = await newPage(browser, {
    viewport: { width: 1280, height: 720 },
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${DESIGN_IP}` },
  });
  await page.goto("/@feature_host/overlay?key=e2e-key");
  await expect(page.locator("main.overlay-screen.ov-screen")).toBeAttached();
  await expect(page.locator(".ov-design")).toHaveCount(0);
  const stage = page.locator(".ov-composition > .ov-stage");
  await expect(stage).toBeAttached();
  // Mark the on-air stage element: a remount would replace it, flash it and replay its animations.
  await stage.evaluate((element: Element) => Object.assign(element, { e2eKept: true }));

  // The owner turns the chat on live: the page changes to the design canvas without a remount.
  const owner = await signedIn(browser, "featureowner", DESIGN_IP);
  try {
    const on = await owner.request.post("/api/overlay", { data: { action: "layers", chat: { enabled: true } } });
    expect(on.status()).toBe(200);
    await expect(page.locator("main.overlay-screen.ov-design-screen")).toBeAttached();
    await expect(page.locator(".ov-design")).toHaveAttribute("data-scaled", "true");
    await expect(page.locator('.ov-layer[data-layer="chat"]')).toBeAttached();
    expect(await stage.evaluate((element: Element) => "e2eKept" in element)).toBe(true);
  } finally {
    await setLayers("overlay-design-off-restore", {});
    await close(owner);
    await close(page);
  }
});
