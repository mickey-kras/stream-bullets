import { randomUUID } from "node:crypto";
import type { Locator, WebSocketRoute } from "@playwright/test";
import { newPage, close, test, expect, type Browser, type BrowserContext, type Page } from "./coverage";
import { runSql } from "./fixtures";
import { signedIn } from "./live-helpers";
import { clientIp } from "./client-ips";
import {
  CHARACTERS_CELL,
  CHAT_CELL,
  FEATURE_HOST,
  POLL_CELL,
  defaultLayers,
  layersSql,
  noKeysSql,
} from "./grid-helpers";
import type { OverlayState } from "../../app/types";

// The Live section of Streamer tools: the owner runs the stream from one page, and each change reaches OBS at once.
const POLL_IP = clientIp("tools-live", 41);
const TOPIC_IP = clientIp("tools-live", 42);
const CHAT_IP = clientIp("tools-live", 43);
const RECONNECT_IP = clientIp("tools-live", 44);
const OBS_IP = clientIp("tools-live", 45);
const PHONE_IP = clientIp("tools-live", 46);
const DOCK_OWNER_IP = clientIp("tools-live", 47);
const DOCK_IP = clientIp("tools-live", 48);
const REPLAY_IP = clientIp("tools-live", 49);
const SUPPORT_IP = clientIp("tools-live", 52);
const SUPPORT_DOCK_IP = clientIp("tools-live", 53);
const LAYOUT_IP = clientIp("tools-live", 54);

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

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  // The text is wider than the box, so a part of it does not show.
  cut: boolean;
}

function boxes(locator: Locator): Promise<Box[]> {
  return locator.evaluateAll((elements: Element[]): Box[] =>
    elements.map((element: Element): Box => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height, cut: element.scrollWidth > element.clientWidth + 1 };
    }),
  );
}

test("Live has a link to Overlay beside the preview title, the poll actions in one row, and one width for the buttons of the topics and of the message", async ({
  browser,
}) => {
  const owner = await signedIn(browser, "featureowner", LAYOUT_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tools?view=live");
  const poll = page.locator('[data-live-part="poll"]');
  const row = poll.locator("[data-live-poll-actions]");
  const feature = page.locator('[data-live-part="topics"] .tl-action');
  const put = page.locator("[data-live-message-show]");
  await expect(row.getByRole("button")).toHaveText(["Reveal results", "Close voting", "Take off air"]);
  await expect(feature).toHaveText(["Feature on stream", "Feature on stream", "Feature on stream"]);
  await expect(put).toHaveText("Put on stream");

  /** The poll actions are one line of equal columns that fills the part. Each one is a touch target. */
  const oneRow = async (): Promise<void> => {
    const [part] = await boxes(poll);
    const actions: Box[] = await boxes(row.getByRole("button"));
    expect(actions).toHaveLength(3);
    for (const action of actions) {
      expect(action.y).toBe(actions[0].y);
      expect(action.height).toBe(actions[0].height);
      expect(action.width).toBeCloseTo(actions[0].width, 0);
      expect(action.height).toBeGreaterThanOrEqual(44);
      expect(action.cut).toBe(false);
    }
    expect(actions[0].x).toBeCloseTo(part.x, 0);
    expect(actions[2].x + actions[2].width).toBeCloseTo(part.x + part.width, 0);
  };
  /** The buttons that feature a topic and the button of the message banner: one width, one right edge. */
  const oneWidth = async (): Promise<Box[]> => {
    const buttons: Box[] = [...(await boxes(feature)), ...(await boxes(put))];
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.width).toBeCloseTo(buttons[0].width, 0);
      expect(button.x + button.width).toBeCloseTo(buttons[0].x + buttons[0].width, 0);
      expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.cut).toBe(false);
    }
    return buttons;
  };

  await oneRow();
  const wide: Box[] = await oneWidth();
  // On a desktop the buttons are at the end of their rows: the text of a row is wider than its button.
  const [topics] = await boxes(page.locator('[data-live-part="topics"]'));
  expect(wide[0].x + wide[0].width).toBeCloseTo(topics.x + topics.width, 0);
  expect(wide[0].width).toBeLessThan(topics.width / 2);

  // The link beside the title of the preview has only an icon, a name, and a tooltip.
  const preview = page.locator('[data-live-part="preview"]');
  const edit = preview.getByRole("link", { name: "Edit the overlay" });
  await expect(edit).toHaveAttribute("title", "Edit the overlay");
  await expect(edit).toHaveAttribute("href", "/tools?view=overlay");
  await expect(edit).toHaveText("");
  const [link] = await boxes(edit);
  const [heading] = await boxes(preview.locator(".ov-step-title"));
  expect(link.width).toBeGreaterThanOrEqual(44);
  expect(link.height).toBeGreaterThanOrEqual(44);
  expect(link.x).toBeGreaterThan(heading.x + heading.width);
  expect(link.y + link.height / 2).toBeGreaterThan(heading.y);
  expect(link.y + link.height / 2).toBeLessThan(heading.y + heading.height);
  // The preview is read-only: the link is its only control.
  await expect(preview.locator("button, input, select, textarea")).toHaveCount(0);

  // The message on stream has two buttons of that width, and the topic on stream keeps the width of its button.
  await page.locator("[data-live-message]").fill("Back soon.");
  await put.click();
  const off = page.locator("[data-live-message-off]");
  await expect(off).toBeVisible();
  await feature.first().click();
  await expect(feature.first()).toHaveText("Take off air");
  const featured: Box[] = await boxes(feature);
  const [update] = await boxes(put);
  const [takeOff] = await boxes(off);
  for (const button of [...featured, update, takeOff]) expect(button.width).toBeCloseTo(wide[0].width, 0);
  // The button that takes the message off air is at the end of its row. The button that updates it is before it.
  expect(takeOff.x + takeOff.width).toBeCloseTo(featured[0].x + featured[0].width, 0);
  expect(update.y).toBe(takeOff.y);
  expect(update.x + update.width).toBeLessThan(takeOff.x);

  // A phone keeps the poll actions in one row. The other buttons fill the width of the part.
  await page.setViewportSize({ width: 390, height: 844 });
  await oneRow();
  const narrow: Box[] = await oneWidth();
  const [part] = await boxes(page.locator('[data-live-part="topics"]'));
  expect(narrow[0].width).toBeCloseTo(part.width, 0);
  expect(await page.evaluate((): number => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // A larger text size has no room for three columns: the actions are one column of equal buttons.
  await page.evaluate((): void => {
    document.documentElement.dataset.text = "130";
  });
  const stacked: Box[] = await boxes(row.getByRole("button"));
  expect(new Set(stacked.map((action: Box): number => action.y)).size).toBe(3);
  for (const action of stacked) {
    expect(action.width).toBeCloseTo(stacked[0].width, 0);
    expect(action.cut).toBe(false);
  }
  await page.evaluate((): void => {
    delete document.documentElement.dataset.text;
  });

  // The link opens the Overlay section.
  await edit.click();
  await expect(page).toHaveURL(/\/tools\?view=overlay$/);
  await expect(page.locator(".ov-head").getByRole("heading", { level: 1 })).toHaveAccessibleName("Overlay");
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

/** A chat message with `text`, from this moment: the overlay chat shows a message for two minutes. */
function said(n: number, text: string): Record<string, unknown> {
  return { ...chat(n, "twitch"), text, fragments: [{ type: "text", text }], receivedAt: Date.now() };
}

test("hide character commands hides the commands in the Live chat, the preview, the full-screen chat and the dock", async ({
  browser,
}) => {
  // The chat layer is on stream, so the preview of Live shows the overlay chat. The option is off, as by default.
  await runSql("tools-live-commands", [
    layersSql({ chat: { enabled: true }, cells: { horizontal: { chat: CHAT_CELL, poll: POLL_CELL } } }),
    noDockKey,
  ]);
  const owner = await signedIn(browser, "featureowner", CHAT_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // A command, a command with an alias, a number and a side after a full-width mark, and a word that is no command.
  const first: Record<string, unknown>[] = [
    said(1, "hello all"),
    said(2, "!jump"),
    said(3, "！HOOK 3 left"),
    said(4, "!hello"),
  ];
  const all: string[] = ["hello all", "!jump", "！HOOK 3 left", "!hello"];
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/activity/**", (socket: WebSocketRoute) => {
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "snapshot", events: first, replay: true }));
  });
  const send = (event: Record<string, unknown>): void => sockets[0].send(JSON.stringify({ type: "event", event }));
  await page.goto("/tools?view=live");
  const part = page.locator('[data-live-part="chat"]');
  const log = part.getByRole("log", { name: "Chat" });
  const texts = (list: Locator): Promise<string[]> => list.locator("[data-chat-row] .tl-chat-text").allTextContents();
  const preview = page.locator(".tl-preview [data-overlay-chat]");
  const onStream = (): Promise<string[]> => preview.locator("li.wl-item:not([data-gone]) .wl-msg").allTextContents();
  // Off by default: each message shows.
  await expect.poll(() => texts(log)).toEqual(all);
  await expect.poll(onStream).toEqual(all);

  // The dock has its own link and its own socket.
  const made = await owner.request.post("/api/dock/key", { data: {} });
  expect(made.status()).toBe(200);
  const dock = await newPage(browser, {
    viewport: { width: 300, height: 720 },
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${DOCK_IP}` },
  });
  await dock.routeWebSocket("**/api/activity/**", (socket: WebSocketRoute) => {
    socket.send(JSON.stringify({ type: "snapshot", events: first, replay: true }));
  });
  await dock.goto(((await made.json()) as { url: string }).url);
  const dockLog = dock.locator('[data-live-part="chat"]').getByRole("log", { name: "Chat" });
  await expect.poll(() => texts(dockLog)).toEqual(all);
  // Mark the documents: a reload would drop the mark.
  for (const open of [page, dock])
    await open.evaluate(() => document.documentElement.setAttribute("data-e2e-loaded", "1"));

  // The owner selects the option in a different tab. The commands go from each view, and no row stays for them.
  const hide = await owner.request.post("/api/overlay", {
    data: { action: "layers", chat: { hideCharacterCommands: true } },
  });
  expect(hide.status()).toBe(200);
  await expect.poll(() => texts(log)).toEqual(["hello all", "!hello"]);
  await expect.poll(() => texts(dockLog)).toEqual(["hello all", "!hello"]);
  await expect.poll(onStream).toEqual(["hello all", "!hello"]);
  await expect(log.locator("[data-chat-row]")).toHaveCount(2);

  // A new command gets no row and does not count for a paused chat. A word that is no command shows and counts.
  await part.getByRole("button", { name: "Pause chat" }).click();
  await expect(part.locator("[data-chat-paused]")).toHaveText("Chat paused. New messages: 0");
  send(said(5, "!wave"));
  send(said(6, "!r 2"));
  send(said(7, "!discord"));
  await expect(part.locator("[data-chat-paused]")).toHaveText("Chat paused. New messages: 1");
  await expect.poll(onStream).toEqual(["hello all", "!hello", "!discord"]);
  await part.getByRole("button", { name: "Jump to latest" }).click();
  await expect.poll(() => texts(log)).toEqual(["hello all", "!hello", "!discord"]);

  // The full-screen chat shows the same rows.
  await part.getByRole("button", { name: "Open chat full screen" }).click();
  const view = page.getByRole("dialog", { name: "Chat, full screen" });
  await expect.poll(() => texts(view.getByRole("log", { name: "Chat" }))).toEqual(["hello all", "!hello", "!discord"]);
  await view.getByRole("button", { name: "Exit" }).click();
  await expect(view).toHaveCount(0);

  // The owner clears the option: the log shows the commands again in their places.
  const show = await owner.request.post("/api/overlay", {
    data: { action: "layers", chat: { hideCharacterCommands: false } },
  });
  expect(show.status()).toBe(200);
  await expect.poll(() => texts(log)).toEqual([...all, "!wave", "!r 2", "!discord"]);
  await expect.poll(() => texts(dockLog)).toEqual(all);
  // The chat layer does not bring a hidden command back. It shows the commands that come from now on.
  send(said(8, "!dance"));
  await expect.poll(onStream).toEqual(["hello all", "!hello", "!discord", "!dance"]);
  // No page loaded again, and Live kept its one socket.
  for (const open of [page, dock]) await expect(open.locator("html")).toHaveAttribute("data-e2e-loaded", "1");
  expect(sockets).toHaveLength(1);
  await Promise.all([close(owner), close(dock)]);
  await runSql("tools-live-commands-restore", [noDockKey]);
});

test("the preview shows the recent chat when the chat layer goes on stream from a different tab", async ({
  browser,
}) => {
  // The chat layer has a place on the grid and is off stream. The characters are off the grid.
  await runSql("tools-live-replay", [
    layersSql({ chat: { enabled: false }, cells: { horizontal: { chat: CHAT_CELL, poll: POLL_CELL } } }),
  ]);
  const owner = await signedIn(browser, "featureowner", REPLAY_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sockets: WebSocketRoute[] = [];
  // The overlay chat shows a message for two minutes, so the messages are from this moment.
  const recent = (n: number): Record<string, unknown> => ({ ...chat(n, "twitch"), receivedAt: Date.now() });
  await page.routeWebSocket("**/api/activity/**", (socket: WebSocketRoute) => {
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "snapshot", events: [recent(1), recent(2)], replay: true }));
  });
  await page.goto("/tools?view=live");
  const log = page.locator('[data-live-part="chat"]').getByRole("log", { name: "Chat" });
  await expect(log.locator("[data-chat-row]")).toHaveCount(2);
  // One more message comes, and a moderator removes the first message. The socket sends each of them one time.
  sockets[0].send(JSON.stringify({ type: "event", event: recent(3) }));
  sockets[0].send(
    JSON.stringify({ type: "event", event: { kind: "delete", platform: "twitch", messageId: "m1", receivedAt: 1 } }),
  );
  await expect(log.locator("[data-chat-row]")).toHaveCount(3);
  await expect(log).toContainText("message removed by a moderator");
  const preview = page.locator(".tl-preview");
  await expect(preview.locator("[data-overlay-chat]")).toHaveCount(0);

  // A different tab of the owner puts the chat layer on stream. No new message comes.
  const turned = await owner.request.post("/api/overlay", { data: { action: "layers", chat: { enabled: true } } });
  expect(turned.status()).toBe(200);
  const shown = preview.locator("[data-overlay-chat] li.wl-item");
  await expect(shown).toHaveCount(2);
  await expect(preview.locator("[data-overlay-chat]")).toContainText("chat message 2");
  await expect(preview.locator("[data-overlay-chat]")).toContainText("chat message 3");
  // The removed message does not show, and the page opened no second socket.
  await expect(preview.locator("[data-overlay-chat]")).not.toContainText("chat message 1");
  expect(sockets).toHaveLength(1);
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

  // A paused list keeps the message that the streamer reads when the view opens and when it exits.
  const firstShown = (log: Locator): Promise<string | null> =>
    log.evaluate((element: Element): string | null => {
      const top: number = element.getBoundingClientRect().top;
      for (const row of element.querySelectorAll<HTMLElement>("[data-chat-row]"))
        if (row.getBoundingClientRect().bottom > top + 1) return row.dataset.chatRow ?? null;
      return null;
    });
  const panel = page.getByRole("log", { name: "Chat" });
  await panel.evaluate((element: Element): void => {
    const row = element.querySelectorAll<HTMLElement>("[data-chat-row]")[10];
    element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top;
  });
  await expect(page.locator('[data-live-part="chat"] [data-chat-paused]')).toBeVisible();
  const reading: string | null = await firstShown(panel);
  expect(reading).not.toBeNull();
  await open.click();
  await expect(view).toBeVisible();
  await expect(view.locator("[data-chat-paused]")).toBeVisible();
  await expect.poll(() => firstShown(list)).toBe(reading);
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await expect.poll(() => firstShown(panel)).toBe(reading);
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

const noDockKey = `DELETE FROM dock_keys WHERE streamer_id=${FEATURE_HOST};`;

test("the OBS dock runs the live controls with its own link in a narrow panel, and a new link closes the open dock", async ({
  browser,
}) => {
  await runSql("tools-live-dock", [noDockKey, noKeysSql]);
  const owner = await signedIn(browser, "featureowner", DOCK_OWNER_IP);
  const tools = await newPage(owner);
  await tools.goto("/tools?view=overlay");
  // The dock has its own closed section in "Add to OBS". Its text tells the owner to keep the dock off screen.
  const section = tools.locator("[data-ov-dock]");
  await expect(section).not.toHaveAttribute("open");
  await section.getByText("Control your stream from inside OBS").click();
  await expect(section.locator("[data-ov-dock-private]")).toHaveText(
    "The link gives control of your stream. Keep the dock off screen: do not capture it in a scene, and do not share the link.",
  );
  await section.getByRole("button", { name: "Create dock link" }).click();
  const field = section.locator("[data-ov-dock-url]");
  await expect(field).toHaveValue(/\/@feature_host\/dock\?key=[\w-]{43}$/);
  const dockUrl: string = await field.inputValue();
  await expect(section).toContainText("It shows only once.");

  // The dock in OBS: no session, 300 px wide, and no site header or footer.
  const dock = await newPage(browser, {
    viewport: { width: 300, height: 720 },
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${DOCK_IP}` },
  });
  await dock.goto(dockUrl);
  await expect(dock.locator("[data-dock]")).toBeVisible();
  await expect(dock.getByRole("heading", { level: 1 })).toHaveText("Live controls: Feature host");
  await expect(dock.locator("body > header, .site-footer")).toHaveCount(0);
  for (const part of ["poll", "topics", "message", "chat"])
    await expect(dock.locator(`[data-live-part="${part}"]`)).toBeVisible();
  expect(await dock.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  // No part is wider than the panel, and the panel scrolls to its last part.
  const widest: number = await dock.evaluate(() =>
    Math.max(
      ...[...document.querySelectorAll("[data-dock] *")].map((element) => element.getBoundingClientRect().right),
    ),
  );
  expect(widest).toBeLessThanOrEqual(300);
  await dock.locator('[data-live-part="chat"]').scrollIntoViewIfNeeded();
  await expect(dock.locator('[data-live-part="chat"]')).toBeInViewport();
  await expect(dock.locator("[data-live-poll-title]")).toHaveText("Tea or coffee");

  // An action in the dock shows in Live without a reload, and the reverse.
  const live = await newPage(owner);
  await live.goto("/tools?view=live");
  const liveResults = live.locator("[data-live-poll-results]");
  const dockResults = dock.locator("[data-live-poll-results]");
  await expect(liveResults).toHaveText("Reveal results");
  await dockResults.click();
  await expect(dockResults).toHaveText("Hide results");
  await expect(liveResults).toHaveText("Hide results");
  expect((await overlay(owner)).showResults).toBe(true);
  await liveResults.click();
  await expect(dockResults).toHaveText("Reveal results");

  // A failed action in the dock tells the streamer why the change did not reach the stream.
  await dock.route("**/api/dock/**", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 503, json: { error: "The request failed. Please try again." } });
  });
  await dockResults.click();
  await expect(dock.locator(".sb-toast")).toHaveText("The request failed. Please try again.");
  await expect(dockResults).toHaveText("Reveal results");
  await dock.unroute("**/api/dock/**");

  // A key that is not the dock key opens nothing: a wrong key, and the key of an overlay link.
  expect((await dock.request.get(`/@feature_host/dock?key=${"A".repeat(43)}`)).status()).toBe(404);
  expect((await dock.request.get("/@feature_host/dock")).status()).toBe(404);
  await tools
    .getByRole("region", { name: "Horizontal output" })
    .getByRole("button", { name: "Create overlay link" })
    .click();
  const overlayField = tools.locator("[data-ov-url]");
  await expect(overlayField).toHaveValue(/\?key=[\w-]{43}$/);
  const overlayKey: string = new URL(await overlayField.inputValue()).searchParams.get("key") ?? "";
  expect((await dock.request.get(`/@feature_host/dock?key=${overlayKey}`)).status()).toBe(404);
  const refused = await dock.request.post("/api/dock/feature_host/overlay", {
    data: { action: "showResults", on: true },
    headers: { "X-SB-Dock-Key": overlayKey, Origin: new URL(dockUrl).origin },
  });
  expect(refused.status()).toBe(403);
  expect((await overlay(owner)).showResults).toBe(false);

  // The same dock link in a browser with the session of the owner: a new dock link must close this dock too.
  const ownerDock = await newPage(owner);
  await ownerDock.goto(dockUrl);
  await expect(ownerDock.locator("[data-live-poll-title]")).toHaveText("Tea or coffee");

  // A new dock link closes the open dock at once: its controls go, and it tells the owner what to do.
  await section.getByRole("button", { name: "Regenerate dock link" }).click();
  const confirm = tools.getByRole("dialog", { name: "Regenerate the dock link?" });
  await expect(confirm).toContainText("each open dock closes");
  await confirm.getByRole("button", { name: "Regenerate dock link" }).click();
  await expect(field).not.toHaveValue(dockUrl);
  await expect(dock.locator("[data-dock-closed]")).toBeVisible();
  await expect(dock.locator("[data-dock-closed]")).toContainText("This dock link does not work");
  await expect(dock.locator("[data-live-part]")).toHaveCount(0);
  await expect(ownerDock.locator("[data-dock-closed]")).toBeVisible();
  await expect(ownerDock.locator("[data-live-part]")).toHaveCount(0);
  // The new link opens the dock again.
  await dock.goto(await field.inputValue());
  await expect(dock.locator("[data-live-poll-title]")).toHaveText("Tea or coffee");
  await Promise.all([close(owner), close(dock)]);
  await runSql("tools-live-dock-restore", [noDockKey, noKeysSql]);
});

/** A support event as the feed sends it. An anonymous event has no sender. */
function support(
  kind: "bits" | "follow",
  deliveryId: string,
  platform: "twitch" | "kick",
  more: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind,
    id: `${platform}:${deliveryId}`,
    platform,
    deliveryId,
    sender: null,
    anonymous: false,
    amount: null,
    currency: null,
    receivedAt: Date.now(),
    replay: false,
    ...more,
  };
}

test("support events show in the Live chat and in the dock, and never in the overlay chat", async ({ browser }) => {
  // The chat layer is on stream, so the preview of Live shows the overlay chat.
  await runSql("tools-live-support", [
    layersSql({ chat: { enabled: true }, cells: { horizontal: { chat: CHAT_CELL, poll: POLL_CELL } } }),
    noDockKey,
  ]);
  const owner = await signedIn(browser, "featureowner", SUPPORT_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const message: Record<string, unknown> = { ...chat(1, "twitch"), receivedAt: Date.now() };
  const cheer = support("bits", "d1", "twitch", { anonymous: true, amount: 100, text: "great <b>stream</b>" });
  const follow = support("follow", "d2", "kick", { sender: { id: "u9", displayName: "Viewer 9" } });
  const sockets: WebSocketRoute[] = [];
  // The snapshot of a reconnect has the support event as a replay. The follow comes as a live event.
  await page.routeWebSocket("**/api/activity/**", (socket: WebSocketRoute) => {
    sockets.push(socket);
    socket.send(JSON.stringify({ type: "snapshot", events: [message, { ...cheer, replay: true }], replay: true }));
  });
  await page.goto("/tools?view=live");
  const part = page.locator('[data-live-part="chat"]');
  const log = part.getByRole("log", { name: "Chat" });
  const rows = log.locator("[data-chat-row]");
  await expect(rows).toHaveCount(2);
  sockets[0].send(JSON.stringify({ type: "event", event: follow }));
  await expect(rows).toHaveCount(3);
  const bits = log.locator('[data-support="bits"]');
  await expect(bits).toHaveText("Twitch Anonymous 100 Bits great <b>stream</b>");
  await expect(bits.locator("b")).toHaveCount(0);
  await expect(log.locator('[data-support="follow"]')).toHaveText("Kick Viewer 9 followed");
  // A support row does not look like a chat row.
  const edge = (row: Locator): Promise<string> =>
    row.evaluate((element: Element): string => getComputedStyle(element).borderLeftWidth);
  expect(await edge(bits)).toBe("3px");
  expect(await edge(rows.first())).toBe("0px");
  // The same event again adds no second row. A cleared chat removes the chat text only.
  sockets[0].send(JSON.stringify({ type: "event", event: { ...cheer, replay: true } }));
  sockets[0].send(JSON.stringify({ type: "event", event: { kind: "clear", platform: "twitch", receivedAt: 1 } }));
  await expect(rows.first()).toContainText("message removed by a moderator");
  await expect(rows).toHaveCount(3);
  await expect(bits).toContainText("100 Bits");
  // The platform filter hides the support events of its platform.
  await part.getByRole("button", { name: "Kick" }).click();
  await expect(log.locator('[data-support="follow"]')).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  await part.getByRole("button", { name: "Kick" }).click();
  await expect(rows).toHaveCount(3);

  // The overlay chat of the preview got the same messages. It shows chat only.
  const recent: Record<string, unknown> = { ...chat(2, "twitch"), receivedAt: Date.now() };
  sockets[0].send(JSON.stringify({ type: "event", event: recent }));
  const overlayChat = page.locator(".tl-preview [data-overlay-chat]");
  await expect(overlayChat.locator("li.wl-item")).toHaveCount(1);
  await expect(overlayChat).toContainText("chat message 2");
  await expect(overlayChat).not.toContainText("100 Bits");
  await expect(overlayChat).not.toContainText("Viewer 9");
  await expect(rows).toHaveCount(4);

  // The dock shows the same list with its own link.
  const made = await owner.request.post("/api/dock/key", { data: {} });
  expect(made.status()).toBe(200);
  const dockUrl: string = ((await made.json()) as { url: string }).url;
  const dock = await newPage(browser, {
    viewport: { width: 300, height: 720 },
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${SUPPORT_DOCK_IP}` },
  });
  await dock.routeWebSocket("**/api/activity/**", (socket: WebSocketRoute) => {
    socket.send(JSON.stringify({ type: "snapshot", events: [message, cheer, follow], replay: true }));
  });
  await dock.goto(dockUrl);
  const dockLog = dock.locator('[data-live-part="chat"]').getByRole("log", { name: "Chat" });
  await expect(dockLog.locator("[data-chat-row]")).toHaveCount(3);
  await expect(dockLog.locator('[data-support="bits"]')).toContainText("Anonymous 100 Bits");
  await expect(dockLog.locator('[data-support="follow"]')).toContainText("Viewer 9 followed");
  // A support row is not wider than the narrow panel.
  const right: number = await dockLog
    .locator('[data-support="bits"]')
    .evaluate((element: Element): number => element.getBoundingClientRect().right);
  expect(right).toBeLessThanOrEqual(300);
  await Promise.all([close(owner), close(dock)]);
  await runSql("tools-live-support-restore", [noDockKey]);
});
