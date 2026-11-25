import { randomUUID } from "node:crypto";
import type { WebSocketRoute } from "@playwright/test";
import { newPage, close, test, expect, type Browser, type BrowserContext, type Page } from "./coverage";
import { runSql } from "./fixtures";
import { signedIn } from "./live-helpers";
import { clientIp } from "./client-ips";
import { CHARACTERS_CELL, CHAT_CELL, FEATURE_HOST, POLL_CELL, defaultLayers, layersSql } from "./grid-helpers";
import type { OverlayState } from "../../app/types";

// The Live section of Streamer tools: the owner runs the stream from one page, and each change reaches OBS at once.
const POLL_IP = clientIp("tools-live", 41);
const TOPIC_IP = clientIp("tools-live", 42);
const CHAT_IP = clientIp("tools-live", 43);
const RECONNECT_IP = clientIp("tools-live", 44);
const OBS_IP = clientIp("tools-live", 45);
const PHONE_IP = clientIp("tools-live", 46);

const now: number = Date.now();
const entry = (id: string, kind: "choice" | "topic", title: string, age: number): string =>
  `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed) SELECT '${id}',id,owner_id,'${kind}','${title}','','','${kind === "choice" ? '["Tea","Coffee"]' : "[]"}',${now + 60_000 - age},0 FROM streamers WHERE handle='feature_host';`;
// The live room accepts only UUIDs as poll ids.
const POLL_ID: string = randomUUID();
const TOPIC_A: string = randomUUID();
const TOPIC_B: string = randomUUID();
const removeEntries = `DELETE FROM entries WHERE title IN ('Tea or coffee','Speedrun the tutorial','Rank the bosses');`;

/**
 * The poll, the topic and the message banner on the grid, each in a cell that the other specs use for another layer.
 * The poll layer shows the latest active poll: the poll of this spec. The topic layer has no topic and the banner
 * is off, so only the poll is on stream.
 */
const liveLayers: string = layersSql({
  items: { message: { enabled: false } },
  cells: { horizontal: { poll: POLL_CELL, topic: CHARACTERS_CELL, message: CHAT_CELL } },
});

test.beforeEach(async () => {
  await runSql("tools-live-reset", [
    removeEntries,
    entry(POLL_ID, "choice", "Tea or coffee", 0),
    entry(TOPIC_A, "topic", "Speedrun the tutorial", 1000),
    entry(TOPIC_B, "topic", "Rank the bosses", 2000),
    liveLayers,
    `UPDATE overlay_state SET show_results=0, message='' WHERE streamer_id=${FEATURE_HOST};`,
  ]);
});

test.afterAll(async () => {
  await runSql("tools-live-cleanup", [removeEntries, defaultLayers]);
});

async function overlay(context: BrowserContext): Promise<OverlayState> {
  const response = await context.request.get("/api/overlay");
  return ((await response.json()) as { overlay: OverlayState }).overlay;
}

/** The overlay page as OBS loads it, with its own client address. It never reloads in these tests. */
async function obsPage(browser: Browser): Promise<Page> {
  const page = await newPage(browser, {
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${OBS_IP}` },
  });
  await page.goto("/@feature_host/overlay");
  return page;
}

test("the owner runs the poll from Live, and each change reaches OBS without a reload", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", POLL_IP);
  const obs = await obsPage(browser);
  const obsPoll = obs.locator('.ov-layer[data-layer="poll"]');
  await expect(obsPoll).toContainText("Tea or coffee");
  await expect(obsPoll.locator(".ov-hidden-results")).toHaveCount(1);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Streamer tools opens on Live.
  await page.goto("/tools");
  await expect(
    page.getByRole("navigation", { name: "Streamer tools sections" }).getByRole("link", { name: "Live" }),
  ).toHaveAttribute("aria-current", "page");
  const poll = page.locator('[data-live-part="poll"]');
  await expect(poll.getByRole("heading", { level: 2, name: "Poll" })).toBeVisible();
  await expect(poll.locator("[data-live-poll-title]")).toHaveText("Tea or coffee");
  const status = poll.locator("[data-live-poll-status]");
  await expect(status).toContainText("On air");
  await expect(status).toContainText("Voting live");
  await expect(status).toContainText("Results hidden on stream");
  // The preview shows what OBS shows.
  const preview = page.locator('[data-live-part="preview"]');
  await expect(preview.locator('.ov-layer[data-layer="poll"]')).toContainText("Tea or coffee");
  await expect(preview.locator("[data-live-preview-note]")).toHaveText("Changes reach OBS at once.");

  // Reveal results, by keyboard.
  await poll.getByRole("button", { name: "Reveal results" }).focus();
  await page.keyboard.press("Enter");
  await expect(poll.getByRole("button", { name: "Hide results" })).toBeVisible();
  await expect(status).toContainText("Results show on stream");
  expect((await overlay(owner)).showResults).toBe(true);
  await expect(obsPoll.locator(".ov-hidden-results")).toHaveCount(0);

  // Off air: OBS drops the poll, and viewers can still vote on the page.
  await poll.getByRole("button", { name: "Take off air" }).click();
  await expect(status).toContainText("Off air");
  await expect(obsPoll).toHaveCount(0);
  await expect(preview.locator('.ov-layer[data-layer="poll"]')).toHaveCount(0);
  await expect(status).toContainText("Voting live");
  expect((await overlay(owner)).layers.items.poll.enabled).toBe(false);
  const viewer = await newPage(browser, { extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${OBS_IP}` } });
  await viewer.goto(`/@feature_host?view=polls&entry=${POLL_ID}`);
  await expect(viewer.getByText("Voting live").first()).toBeVisible();
  await close(viewer);

  // Back on air.
  await poll.getByRole("button", { name: "Put on air" }).click();
  await expect(status).toContainText("On air");
  await expect(obsPoll).toContainText("Tea or coffee");

  // The QR code of the card on stream.
  await expect(obsPoll.locator("[data-overlay-qr]")).toHaveCount(1);
  await poll.getByRole("button", { name: "Hide QR code" }).click();
  await expect(poll.getByRole("button", { name: "Show QR code" })).toBeVisible();
  await expect(obsPoll.locator("[data-overlay-qr]")).toHaveCount(0);

  // Close voting ends the vote on the page. A closed vote does not open again.
  await poll.getByRole("button", { name: "Close voting" }).click();
  const closed = await newPage(browser, { extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${OBS_IP}` } });
  await closed.goto(`/@feature_host?view=polls&entry=${POLL_ID}`);
  await expect(closed.getByText("Ended by host").first()).toBeVisible();
  await close(closed);
  // The poll layer shows the latest active poll. This one is closed, so the next open poll of the owner takes its
  // place: the Mash Battle of the test page. A Mash Battle has its own controls and no Close voting here.
  await expect(poll.locator("[data-live-poll-title]")).toHaveText("Which boss first?");
  await expect(poll.getByRole("button", { name: "Close voting" })).toHaveCount(0);
  await expect(obsPoll).toContainText("Which boss first?");
  await close(obs);
  await close(owner);
});

test("the owner features a viewer topic and puts the message banner on stream", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", TOPIC_IP);
  const obs = await obsPage(browser);
  // The topic layer has a box also while it shows no topic, so look for the topic card.
  const obsTopic = obs.locator('.ov-layer[data-layer="topic"] [data-overlay-source="topic"]');
  const obsMessage = obs.locator('.ov-layer[data-layer="message"]');
  await expect(obs.locator('.ov-layer[data-layer="poll"]')).toHaveCount(1);
  await expect(obsTopic).toHaveCount(0);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tools?view=live");
  const topics = page.locator('[data-live-part="topics"]');
  await expect(topics.locator("[data-live-topic]").first()).toContainText("Speedrun the tutorial");
  await expect(topics.getByRole("link", { name: "Open the topic board" })).toHaveAttribute(
    "href",
    "/@feature_host?view=topics",
  );

  await topics.getByRole("button", { name: "Feature on stream: Speedrun the tutorial" }).click();
  const first = topics.locator(`[data-live-topic="${TOPIC_A}"]`);
  await expect(first).toContainText("On air");
  await expect(obsTopic).toContainText("Speedrun the tutorial");
  // Another topic takes its place.
  await topics.getByRole("button", { name: "Feature on stream: Rank the bosses" }).click();
  await expect(obsTopic).toContainText("Rank the bosses");
  await expect(first).not.toContainText("On air");
  expect((await overlay(owner)).layers.items.topic).toMatchObject({ ref: TOPIC_B, enabled: true });
  await topics.getByRole("button", { name: "Take off air: Rank the bosses" }).click();
  await expect(obsTopic).toHaveCount(0);
  await expect(topics.getByRole("button", { name: /^Take off air/ })).toHaveCount(0);

  // The message banner: one button saves the text and puts the banner on stream.
  const message = page.locator('[data-live-part="message"]');
  const show = message.locator("[data-live-message-show]");
  await expect(show).toHaveText("Put on stream");
  await expect(show).toBeDisabled();
  await expect(obsMessage).toHaveCount(0);
  await message.getByLabel("Message (up to 120 characters)").fill("Back in 5 minutes");
  await message.getByRole("button", { name: "Hype" }).click();
  await show.click();
  await expect(obsMessage).toContainText("Back in 5 minutes");
  await expect(message.locator("[data-live-message-show]")).toHaveText("Update on stream");
  expect(await overlay(owner)).toMatchObject({ message: "Back in 5 minutes", messageStyle: "hype" });
  await message.locator("[data-live-message-off]").click();
  await expect(obsMessage).toHaveCount(0);
  await expect(message.locator("[data-live-message-show]")).toHaveText("Put on stream");
  await close(obs);
  await close(owner);
});

function chat(n: number, platform: "twitch" | "youtube" | "kick"): Record<string, unknown> {
  const text = `chat message ${n}`;
  return {
    kind: "chat",
    id: `${platform}:m${n}`,
    platform,
    channelId: "c1",
    messageId: `m${n}`,
    user: { id: `u${n}`, displayName: `Viewer ${n}` },
    text,
    fragments: [{ type: "text", text }],
    badges: [],
    sentAt: null,
    receivedAt: now + n,
    live: true,
  };
}

test("the chat pauses on a scroll up, counts new messages, filters platforms and jumps to the latest", async ({
  browser,
}) => {
  const owner = await signedIn(browser, "featureowner", CHAT_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sockets: WebSocketRoute[] = [];
  const platforms = ["twitch", "youtube", "kick"] as const;
  await page.routeWebSocket("**/api/activity/**", (socket: WebSocketRoute) => {
    sockets.push(socket);
    const events = Array.from({ length: 60 }, (_, n: number) => chat(n, platforms[n % 3]));
    socket.send(JSON.stringify({ type: "snapshot", events, replay: true }));
  });
  const send = (event: Record<string, unknown>): void => sockets[0].send(JSON.stringify({ type: "event", event }));
  await page.goto("/tools?view=live");
  const part = page.locator('[data-live-part="chat"]');
  const list = part.getByRole("log", { name: "Chat" });
  const rows = list.locator("[data-chat-row]");
  await expect(rows).toHaveCount(60);
  // The owner connects without an overlay key.
  expect(new URL(sockets[0].url()).searchParams.get("key")).toBeNull();
  const fromEnd = (): Promise<number> =>
    list.evaluate((element: Element): number => element.scrollHeight - element.scrollTop - element.clientHeight);
  // The list follows the newest message.
  await expect.poll(fromEnd).toBeLessThan(2);
  send(chat(60, "twitch"));
  await expect(rows).toHaveCount(61);
  await expect.poll(fromEnd).toBeLessThan(2);
  await expect(rows.last()).toContainText("chat message 60");

  // A scroll up pauses the list. It keeps its place while messages arrive, and counts them.
  await list.evaluate((element: Element): void => {
    element.scrollTop = 0;
  });
  await expect(part.locator("[data-chat-paused]")).toHaveText("Chat paused. New messages: 0");
  send(chat(61, "youtube"));
  send(chat(62, "kick"));
  send(chat(63, "twitch"));
  await expect(part.locator("[data-chat-paused]")).toHaveText("Chat paused. New messages: 3");
  await expect(rows).toHaveCount(61);
  expect(await list.evaluate((element: Element): number => element.scrollTop)).toBe(0);
  // A message that a moderator deletes loses its text also while the list is paused.
  send({ kind: "delete", platform: "twitch", messageId: "m0", receivedAt: now });
  await expect(rows.first()).toContainText("message removed by a moderator");
  await expect(rows.first()).not.toContainText("chat message 0");

  // A platform filter hides its rows and its new messages.
  const kick = part.getByRole("button", { name: "Kick" });
  await expect(kick).toHaveAttribute("aria-pressed", "true");
  await kick.click();
  await expect(kick).toHaveAttribute("aria-pressed", "false");
  await expect(list.locator('[data-chat-row][data-platform="kick"]')).toHaveCount(0);
  await expect(part.locator("[data-chat-paused]")).toHaveText("Chat paused. New messages: 2");
  await kick.click();
  await expect(part.locator("[data-chat-paused]")).toHaveText("Chat paused. New messages: 3");

  // Jump to latest shows the waiting messages and follows again.
  await part.getByRole("button", { name: "Jump to latest" }).click();
  await expect(rows).toHaveCount(64);
  await expect.poll(fromEnd).toBeLessThan(2);
  await expect(part.locator("[data-chat-paused]")).toHaveCount(0);
  // The button pauses without a scroll, and the keyboard reaches the list.
  await part.getByRole("button", { name: "Pause chat" }).click();
  await expect(part.locator("[data-chat-paused]")).toHaveText("Chat paused. New messages: 0");
  await list.focus();
  await expect(list).toBeFocused();
  await close(owner);
});

test("after a reconnect Live shows the on-air state of the server", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", RECONNECT_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // The test holds the live socket of the page, so it can take the connection away and give it back.
  let down: boolean = false;
  const open: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/live/feature_host", async (socket: WebSocketRoute) => {
    if (down) {
      await socket.close({ code: 1013, reason: "Test outage" });
      return;
    }
    socket.connectToServer();
    open.push(socket);
  });
  await page.goto("/tools?view=live");
  const poll = page.locator('[data-live-part="poll"]');
  const status = poll.locator("[data-live-poll-status]");
  await expect(status).toContainText("On air");
  await expect(poll.getByRole("button", { name: "Reveal results" })).toBeVisible();
  // The connection goes away. Another device changes the state meanwhile.
  down = true;
  for (const socket of open) await socket.close({ code: 1013, reason: "Test outage" });
  await expect(page.locator(".ov-conn")).toContainText("Overlay disconnected, retrying…");
  const other = await signedIn(browser, "featureowner", RECONNECT_IP);
  for (const data of [
    { action: "showResults", on: true },
    { action: "layers", items: { poll: { enabled: false } } },
  ])
    expect((await other.request.post("/api/overlay", { data })).ok()).toBe(true);
  await close(other);
  down = false;
  await expect(page.locator(".ov-conn")).toHaveCount(0, { timeout: 30_000 });
  await expect(status).toContainText("Off air");
  await expect(status).toContainText("Results show on stream");
  await expect(poll.getByRole("button", { name: "Put on air" })).toBeVisible();
  await close(owner);
});

/**
 * A phone browser for the full-screen chat. `wake` is the Screen Wake Lock API of the page: a recorder, or absent as
 * in a browser without it. `fullscreen` is the Fullscreen API: absent as on iPhone Safari, or a fake that works.
 */
async function phone(
  owner: BrowserContext,
  options: { wake: boolean; fullscreen: boolean },
): Promise<{ page: Page; sockets: WebSocketRoute[] }> {
  const page = await newPage(owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((given: { wake: boolean; fullscreen: boolean }): void => {
    const record = { requests: 0, releases: 0, release: (): void => undefined };
    Object.assign(globalThis, { wakeRecord: record });
    if (given.wake)
      Object.defineProperty(Navigator.prototype, "wakeLock", {
        configurable: true,
        value: {
          request: (): Promise<unknown> => {
            record.requests += 1;
            const sentinel = new EventTarget();
            record.release = (): void => {
              sentinel.dispatchEvent(new Event("release"));
            };
            return Promise.resolve(
              Object.assign(sentinel, {
                release: (): Promise<void> => {
                  record.releases += 1;
                  return Promise.resolve();
                },
              }),
            );
          },
        },
      });
    else Reflect.deleteProperty(Navigator.prototype, "wakeLock");
    let element: Element | null = null;
    Object.defineProperty(Document.prototype, "fullscreenElement", { configurable: true, get: () => element });
    const leave = (): Promise<void> => {
      element = null;
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    };
    Object.assign(globalThis, { leaveFullscreen: leave });
    Document.prototype.exitFullscreen = leave;
    const enter = (next: Element): Promise<void> => {
      element = next;
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    };
    if (given.fullscreen)
      Element.prototype.requestFullscreen = function request(this: Element): Promise<void> {
        return enter(this);
      };
    else Reflect.deleteProperty(Element.prototype, "requestFullscreen");
  }, options);
  const sockets: WebSocketRoute[] = [];
  const platforms = ["twitch", "youtube", "kick"] as const;
  await page.routeWebSocket("**/api/activity/**", (socket: WebSocketRoute) => {
    sockets.push(socket);
    const events = Array.from({ length: 40 }, (_, n: number) => chat(n, platforms[n % 3]));
    socket.send(JSON.stringify({ type: "snapshot", events, replay: true }));
  });
  return { page, sockets };
}

const wakeRecord = (page: Page): Promise<{ requests: number; releases: number }> =>
  page.evaluate(() => {
    const { requests, releases } = (globalThis as unknown as { wakeRecord: { requests: number; releases: number } })
      .wakeRecord;
    return { requests, releases };
  });

test("on a phone the chat opens full screen, keeps the screen on, and Exit returns to the same place", async ({
  browser,
}) => {
  const owner = await signedIn(browser, "featureowner", PHONE_IP);
  // No Fullscreen API, as on iPhone Safari: the view covers the page itself.
  const { page, sockets } = await phone(owner, { wake: true, fullscreen: false });
  await page.goto("/tools?view=live");
  // Streamer tools can go on the home screen: it then opens the full-screen chat without browser bars.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/tools.webmanifest");
  const manifest = await page.request.get("/tools.webmanifest");
  expect(manifest.ok()).toBe(true);
  expect(await manifest.json()).toMatchObject({ display: "standalone", start_url: "/tools?view=live&chat=full" });

  const open = page.getByRole("button", { name: "Open chat full screen" });
  await open.scrollIntoViewIfNeeded();
  const place: number = await page.evaluate((): number => document.scrollingElement?.scrollTop ?? 0);
  await open.click();
  await expect(page).toHaveURL(/[?&]chat=full/);
  const view = page.getByRole("dialog", { name: "Chat, full screen" });
  await expect(view).toBeVisible();
  // The view fills the screen: the bars of the site are under it.
  expect(await view.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  const covered: boolean[] = await page.evaluate((): boolean[] =>
    [
      [20, 20],
      [370, 20],
      [195, 830],
    ].map(([x, y]: number[]): boolean => document.elementFromPoint(x, y)?.closest('[role="dialog"]') !== null),
  );
  expect(covered).toEqual([true, true, true]);
  // The screen stays on.
  await expect.poll(async () => (await wakeRecord(page)).requests).toBe(1);
  await expect(view.locator("[data-chat-wake]")).toHaveCount(0);
  // Portrait: the controls are above the chat. The list is at its end.
  const rail = view.locator(".tl-full-rail");
  const list = view.getByRole("log", { name: "Chat" });
  await expect(list.locator("[data-chat-row]")).toHaveCount(40);
  const portrait = { rail: await rail.boundingBox(), list: await list.boundingBox() };
  expect(portrait.rail?.width).toBe(390);
  expect((portrait.list?.y ?? 0) >= (portrait.rail?.y ?? 0) + (portrait.rail?.height ?? 0)).toBe(true);
  const fromEnd = (): Promise<number> =>
    list.evaluate((element: Element): number => element.scrollHeight - element.scrollTop - element.clientHeight);
  await expect.poll(fromEnd).toBeLessThan(2);
  // The poll on stream, in one line.
  await expect(view.locator("[data-chat-on-air]")).toHaveText("On air: Tea or coffee");

  // Larger text. The device keeps the size.
  const size = (): Promise<string> =>
    view.locator(".tl-chat-list").evaluate((element: Element): string => getComputedStyle(element).fontSize);
  const before: number = Number.parseFloat(await size());
  await view.getByRole("button", { name: "Larger text" }).click();
  await expect.poll(async () => Number.parseFloat(await size())).toBeGreaterThan(before);
  const larger: string = await size();
  // The pause and the filters work as on the page.
  await view.getByRole("button", { name: "Pause chat" }).click();
  sockets[0].send(JSON.stringify({ type: "event", event: chat(40, "kick") }));
  await expect(view.locator("[data-chat-paused]")).toHaveText("Chat paused. New messages: 1");
  await view.getByRole("button", { name: "Jump to latest" }).click();
  await expect(list.locator("[data-chat-row]")).toHaveCount(41);
  await view.getByRole("button", { name: "Kick" }).click();
  await expect(list.locator('[data-chat-row][data-platform="kick"]')).toHaveCount(0);

  // The browser takes the lock away when the page is hidden. The view asks again when the page shows again.
  await page.evaluate((): void => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    (globalThis as unknown as { wakeRecord: { release: () => void } }).wakeRecord.release();
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(view.locator('[data-chat-wake="off"]')).toHaveCount(1);
  expect((await wakeRecord(page)).requests).toBe(1);
  await page.evaluate((): void => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(async () => (await wakeRecord(page)).requests).toBe(2);
  await expect(view.locator("[data-chat-wake]")).toHaveCount(0);

  // Landscape: the controls are in a rail at the side, and the chat has the full height.
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => (await rail.boundingBox())?.height).toBe(390);
  const side = { rail: await rail.boundingBox(), list: await list.boundingBox() };
  expect(side.rail?.width).toBeLessThan(220);
  expect((side.list?.x ?? 0) >= (side.rail?.width ?? 0)).toBe(true);
  expect(await view.boundingBox()).toEqual({ x: 0, y: 0, width: 844, height: 390 });
  await page.setViewportSize({ width: 390, height: 844 });

  // A load of the address opens the view again, with the stored text size.
  await page.reload();
  await expect(view).toBeVisible();
  await expect.poll(size).toBe(larger);
  await expect.poll(async () => (await wakeRecord(page)).requests).toBe(1);

  // Exit returns to Live at the same place, releases the lock, and puts the focus on the button of the view.
  await page.evaluate((top: number): void => {
    if (document.scrollingElement) document.scrollingElement.scrollTop = top;
  }, place);
  await view.getByRole("button", { name: "Exit" }).click();
  await expect(view).toHaveCount(0);
  await expect(page).not.toHaveURL(/chat=full/);
  await expect(page).toHaveURL(/[?&]view=live/);
  expect((await wakeRecord(page)).releases).toBe(1);
  await expect(page.getByRole("log", { name: "Chat" })).toBeVisible();
  // Escape exits too.
  await open.click();
  await expect(view).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await expect(open).toBeFocused();
  await close(owner);
});

test("the full-screen chat says how to keep the screen on, and follows the full screen of the browser", async ({
  browser,
}) => {
  const owner = await signedIn(browser, "featureowner", PHONE_IP);
  // A browser without the wake lock, and with the Fullscreen API.
  const { page } = await phone(owner, { wake: false, fullscreen: true });
  await page.goto("/tools?view=live");
  await page.getByRole("button", { name: "Open chat full screen" }).click();
  const view = page.getByRole("dialog", { name: "Chat, full screen" });
  await expect(view.locator('[data-chat-wake="unsupported"]')).toHaveText(
    "This browser cannot keep the screen on. Turn off the screen lock of your device while you stream.",
  );
  // The view asked the browser for full screen.
  await expect
    .poll(() => page.evaluate((): boolean => document.fullscreenElement?.getAttribute("role") === "dialog"))
    .toBe(true);
  // The streamer leaves the full screen of the browser: the view exits too.
  await page.evaluate(() => (globalThis as unknown as { leaveFullscreen: () => Promise<void> }).leaveFullscreen());
  await expect(view).toHaveCount(0);
  await expect(page).not.toHaveURL(/chat=full/);
  await close(owner);
});
