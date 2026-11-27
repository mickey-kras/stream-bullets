import type { Locator, Request, Route, WebSocketRoute } from "@playwright/test";
import { close, expect, newPage, test, type Browser, type Page } from "./coverage";
import { runSql } from "./fixtures";
import {
  CHARACTERS_CELL,
  CHAT_CELL,
  VERTICAL_KEY,
  chip,
  defaultLayers,
  layersSql,
  noKeysSql,
  saved,
  settings,
  storedLayers,
  verticalKeySql,
} from "./grid-helpers";
import { signedIn } from "./live-helpers";
import { clientIp } from "./client-ips";
import type { ActivityChat } from "../../app/lib/activity";
import type { LayersPatch } from "../../app/lib/overlay-layers";
import { TILE } from "../../app/lib/playground/constants";
import { CHAR_STATES, encodeFrame, type RosterEntry } from "../../app/lib/playground/protocol";
import { mulberry32, PlaygroundSim, parseCommand, setState } from "../../app/lib/playground/sim";
import { cellX } from "../../app/lib/playground/terrain";

const OBS_IP = clientIp("characters", 182);
const REFRESH_IP = clientIp("characters", 183);
const EDITOR_IP = clientIp("characters", 184);
const CONTROLS_IP = clientIp("characters", 185);
const FEED_IP = clientIp("characters", 186);
const BUBBLE_IP = clientIp("characters", 187);
const CROWD_IP = clientIp("characters", 188);
const OTHER_TAB_IP = clientIp("characters", 189);
const shotDir: string | undefined = process.env.OBS_SHOT_DIR;

function setLayers(name: string, layers: LayersPatch): Promise<void> {
  return runSql(name, [layersSql(layers)]);
}

/** The characters on stream along the bottom, and no other layer on the grid. */
const CHARACTERS_ON: LayersPatch = {
  characters: { enabled: true },
  cells: { horizontal: { characters: CHARACTERS_CELL } },
};
/** The characters on the grid and off stream. */
const CHARACTERS_OFF: LayersPatch = { cells: { horizontal: { characters: CHARACTERS_CELL } } };

test.afterAll(async () => {
  await runSql("characters-cleanup", [defaultLayers]);
});

function chat(user: number, text: string = user % 2 === 0 ? "!wave" : "hello wasteland"): ActivityChat {
  const platforms = ["twitch", "youtube", "kick"] as const;
  const platform = platforms[user % 3];
  return {
    kind: "chat",
    id: `${platform}:c${user}-${text.length}`,
    platform,
    channelId: "e2e",
    messageId: `c${user}-${text.length}`,
    user: { id: `viewer-${user}`, displayName: `Scav ${user}` },
    text,
    fragments: [{ type: "text", text }],
    badges: [],
    sentAt: null,
    receivedAt: Date.now(),
    live: true,
  };
}

interface Frames {
  /** The full frame, then tick frames 100 ms of rules time apart. */
  full: string;
  ticks: string[];
  roster: RosterEntry[];
  /** The full frame after the owner removed the character `id`. */
  without: (id: number) => string;
}

/** Frames of the real simulation: `viewers` chatters on a 32 x 4 playground, a few seconds after they spoke. */
function playground(seed: number, viewers: number): Frames {
  const sim = new PlaygroundSim({ cellsW: 32, cellsH: 4, rng: mulberry32(seed) });
  sim.resumeAfter(0);
  for (let user = 1; user <= viewers; user += 1) sim.receive(chat(user));
  for (let i = 0; i < 120; i += 1) sim.tick();
  // Two viewers speak again, so the frames have bubbles.
  sim.receive(chat(1, "who left the door open?"));
  sim.receive(chat(4, "!jump"));
  for (let i = 0; i < 6; i += 1) sim.tick();
  const frame = sim.fullFrame();
  const ticks: string[] = [];
  for (let k = 0; k < 20; k += 1) {
    for (let i = 0; i < 3; i += 1) sim.tick();
    ticks.push(encodeFrame(sim.tickFrame()));
  }
  const without = (id: number): string => {
    sim.remove(id);
    return encodeFrame(sim.fullFrame());
  };
  return { full: encodeFrame(frame), ticks, roster: frame.roster, without };
}

/** Viewers who only talk (no commands, so nobody jumps): 4 of them speak, one at length. */
function talkers(cellsW: number): string {
  const sim = new PlaygroundSim({ cellsW, cellsH: 4, rng: mulberry32(9) });
  sim.resumeAfter(0);
  for (let user = 1; user <= 10; user += 1) sim.receive(chat(user, "hello wasteland"));
  for (let i = 0; i < 150; i += 1) sim.tick();
  const lines = [
    "who left the door open?",
    "this bunker smells like rust and old coffee, and the radio keeps playing the same three songs all night long",
    "gg",
    "nice dig",
  ];
  // Users 3, 4, 5 and 6: Twitch, YouTube, Kick and Twitch.
  for (const [index, text] of lines.entries()) {
    sim.receive(chat(3 + index, text));
    for (let i = 0; i < 4; i += 1) sim.tick();
  }
  const frame = sim.fullFrame();
  expect(frame.bubbles).toHaveLength(4);
  return encodeFrame(frame);
}

/**
 * A full frame of 40 visible characters on a `cellsW` x 4 playground. The speakers say `lines` (each with its own
 * name), and stand `spread` logical px apart from x = `at`, so their bubbles stand off their heads.
 */
function crowd(
  cellsW: number,
  lines: readonly { name: string; text: string }[],
  options: { at: number; spread: number; test?: boolean },
): string {
  const sim = new PlaygroundSim({ cellsW, cellsH: 4, rng: mulberry32(4) });
  sim.resumeAfter(0);
  const say = (index: number, text: string): void =>
    sim.receive({ ...chat(41 + index, text), user: { id: `speaker-${index}`, displayName: lines[index].name } });
  for (const index of lines.keys()) say(index, "hello wasteland");
  for (let user = 1; user <= 40 - lines.length; user += 1) sim.receive(chat(user, "hello wasteland"));
  for (let i = 0; i < 150; i += 1) sim.tick();
  for (const [index, line] of lines.entries()) {
    say(index, line.text);
    for (let i = 0; i < 4; i += 1) sim.tick();
  }
  // A speaker that is turning starts its bubble a few ticks later.
  for (let i = 0; i < 60 && sim.fullFrame().bubbles.length < lines.length; i += 1) sim.tick();
  if (options.test) sim.startTest();
  const frame = sim.fullFrame();
  expect(frame.chars).toHaveLength(40);
  expect(frame.bubbles).toHaveLength(lines.length);
  for (const [index, bubble] of frame.bubbles.entries()) {
    const char = frame.chars.find((c) => c[0] === bubble.id);
    if (char) [char[1], char[3]] = [(options.at + index * options.spread) * 10, CHAR_STATES.indexOf("walk")];
  }
  return encodeFrame(frame);
}

/** Opaque pixels of exactly `color` (#rrggbb) above the characters' heads, where only labels draw. */
function labelPixels(canvas: Locator, color: string): Promise<number> {
  return canvas.evaluate((element: Element, hex: string): number => {
    const target = element as HTMLCanvasElement;
    const [r, g, b] = [1, 3, 5].map((i: number) => Number.parseInt(hex.slice(i, i + 2), 16));
    // The ground is 18 world px above the bottom; a standing head is 30 world px above the ground (3 px each).
    const height: number = target.height - (18 + 30) * 3;
    const data = target.getContext("2d")?.getImageData(0, 0, target.width, height).data;
    let count = 0;
    if (data)
      for (let i = 0; i < data.length; i += 4)
        if (data[i] === r && data[i + 1] === g && data[i + 2] === b && data[i + 3] === 255) count += 1;
    return count;
  }, color);
}

const SNAPSHOT: string = JSON.stringify({ type: "snapshot", events: [], replay: true });
/** A snapshot with chat, for the composition. */
const CHAT_SNAPSHOT: string = JSON.stringify({
  type: "snapshot",
  events: [chat(1, "who left the door open?"), chat(5, "smells like rust out here"), chat(7, "gg chat")].map(
    (event: ActivityChat) => ({ ...event, live: false }),
  ),
  replay: true,
});

/** Opaque pixels on the characters canvas. */
function painted(canvas: Locator): Promise<number> {
  return canvas.evaluate((element: Element): number => {
    const target = element as HTMLCanvasElement;
    const data = target.getContext("2d")?.getImageData(0, 0, target.width, target.height).data;
    let count = 0;
    if (data) for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
    return count;
  });
}

/** Mocks the activity feed. `opened(n)` gives the messages of the nth socket (0-based). */
async function mockFeed(page: Page, opened: (index: number) => string[]): Promise<WebSocketRoute[]> {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/activity/**", (socket: WebSocketRoute) => {
    const index: number = sockets.length;
    sockets.push(socket);
    for (const message of opened(index)) socket.send(message);
  });
  return sockets;
}

async function obsPage(browser: Browser, ip: number, viewport: { width: number; height: number }): Promise<Page> {
  return newPage(browser, { viewport, extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${ip}` } });
}

for (const [name, path, viewport] of [
  ["the composition", "/@feature_host/overlay?key=e2e-key", { width: 1920, height: 1080 }],
  ["a characters source", "/@feature_host/overlay?key=e2e-key&layer=characters", { width: 1920, height: 240 }],
] as const) {
  test(`${name} draws the playground from one activity socket with characters, on a transparent page`, async ({
    browser,
  }) => {
    await setLayers("characters-obs", {
      chat: { enabled: true },
      characters: { enabled: true },
      cells: { horizontal: { chat: CHAT_CELL, characters: CHARACTERS_CELL } },
    });
    const frames: Frames = playground(1, 12);
    const page = await obsPage(browser, OBS_IP, viewport);
    const sockets = await mockFeed(page, () => [CHAT_SNAPSHOT, frames.full, ...frames.ticks]);
    await page.goto(path);
    await expect.poll(() => sockets.length).toBe(1);
    const url = new URL(sockets[0].url());
    expect(url.searchParams.get("key")).toBe("e2e-key");
    expect(url.searchParams.get("characters")).toBe("1");
    const canvas = page.locator('.ov-layer[data-layer="characters"] canvas.characters-layer');
    await expect(canvas).toHaveAttribute("width", "1920");
    await expect(canvas).toHaveAttribute("height", "240");
    await expect.poll(() => painted(canvas)).toBeGreaterThan(500);
    // Transparent: the page has no background and the sky of the playground has no pixels.
    const backgrounds: string[] = await page.evaluate(() =>
      [document.documentElement, document.body, document.querySelector("main")].map(
        (element) => getComputedStyle(element as Element).backgroundColor,
      ),
    );
    expect(backgrounds).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
    const corner: number = await canvas.evaluate((element: Element): number => {
      const target = element as HTMLCanvasElement;
      return target.getContext("2d")?.getImageData(target.width - 1, 0, 1, 1).data[3] ?? -1;
    });
    expect(corner).toBe(0);
    // Still one socket: chat and characters share it.
    expect(sockets).toHaveLength(1);
    if (shotDir && path.endsWith("e2e-key")) await page.screenshot({ path: `${shotDir}/obs-chat-characters.png` });
    await close(page);
  });
}

test("a full frame characters layer draws the builds of the viewers: blocks, stairs and planks", async ({
  browser,
}) => {
  await setLayers("characters-builds", {
    characters: { enabled: true },
    cells: { horizontal: { characters: { c: 0, r: 0, w: 32, h: 18 } } },
  });
  // The real simulation in a full frame world: five viewers stand apart, and each runs its own commands.
  const sim = new PlaygroundSim({ cellsW: 32, cellsH: 18, rng: mulberry32(5) });
  sim.resumeAfter(0);
  const scripts: [number, string[]][] = [
    [8, ["up", "up", "up", "stairs 3", "flag"]],
    [15, ["stairs 5", "bridge 3", "block", "dance"]],
    [21, ["up", "up", "up", "up", "up", "bridge 2", "up", "up"]],
    [26, ["block", "block", "look left", "block", "jump"]],
    [31, ["stairs 2 left", "up", "up", "cheer"]],
  ];
  for (const [user, [column]] of scripts.entries()) {
    sim.receive(chat(user + 1, "hello wasteland"));
    setState(sim.list()[user], "hold", { x: cellX(column), y: sim.world.gy, dir: 1, piloted: true, free: false });
  }
  for (let step = 0; step < 8; step += 1) {
    for (const [user, [, commands]] of scripts.entries()) {
      const call = parseCommand(`!${commands[step] ?? "wave"}`);
      const p = sim.list()[user];
      p.pendingText = null;
      if (call && p.state === "hold") sim.perform(p, call.name, "", call.n, call.side);
    }
    for (let i = 0; i < 200; i += 1) {
      for (const p of sim.list()) p.lastChat = sim.clock;
      sim.tick();
    }
  }
  sim.receive(chat(2, "who needs a bridge?"));
  for (let i = 0; i < 4; i += 1) sim.tick();
  const frame = sim.fullFrame();
  const cols: number = frame.terrain.ground.length;
  const cells: number[] = Array.from(frame.terrain.blocks).flatMap((code: string, i: number) =>
    code === "a" ? [i] : [],
  );
  expect(cells.length).toBeGreaterThan(5);
  expect(frame.terrain.blocks).toMatch(/[m-r]/);
  expect(frame.terrain.blocks).toMatch(/[g-l]/);
  const page = await obsPage(browser, OBS_IP, { width: 1920, height: 1080 });
  await mockFeed(page, () => [frame].map(encodeFrame));
  await page.goto("/@feature_host/overlay?key=e2e-key");
  const canvas = page.locator('.ov-layer[data-layer="characters"] canvas.characters-layer');
  await expect(canvas).toHaveAttribute("height", "1080");
  await expect.poll(() => painted(canvas)).toBeGreaterThan(500);
  // The centre of each dirt block has a pixel of the ground picture, and the top of the layer stays free.
  const centres: [number, number][] = cells.map((i: number): [number, number] => [
    ((i % cols) * TILE + TILE / 2) * 3,
    (frame.terrain.gy - Math.floor(i / cols) * TILE - TILE / 2) * 3,
  ]);
  const alphas: number[] = await canvas.evaluate((element: Element, points: [number, number][]): number[] => {
    const context = (element as HTMLCanvasElement).getContext("2d");
    return [...points, [960, 4] as [number, number]].map(
      ([x, y]: [number, number]): number => context?.getImageData(x, y, 1, 1).data[3] ?? -1,
    );
  }, centres);
  expect(alphas.pop()).toBe(0);
  expect(alphas.every((alpha: number): boolean => alpha === 255)).toBe(true);
  if (shotDir) await page.screenshot({ path: `${shotDir}/obs-builds.png` });
  await close(page);
});

test("the vertical output shows the one playground whole inside its cell, at the bottom", async ({ browser }) => {
  // The playground has the size of the horizontal cell, 32 x 4 cells. The vertical cell is 18 x 6 cells.
  const tall = { c: 0, r: 26, w: 18, h: 6 };
  await runSql("characters-vertical", [
    layersSql({
      characters: { enabled: true },
      cells: { horizontal: { characters: CHARACTERS_CELL }, vertical: { characters: tall } },
    }),
    verticalKeySql(),
  ]);
  try {
    const frames: Frames = playground(4, 12);
    // Half of 1080 x 1920.
    const page = await obsPage(browser, OBS_IP, { width: 540, height: 960 });
    await mockFeed(page, () => [SNAPSHOT, frames.full, ...frames.ticks]);
    await page.goto(`/@feature_host/overlay?key=${VERTICAL_KEY}`);
    const layer = page.locator('.ov-layer[data-layer="characters"]');
    const canvas = layer.locator("canvas.characters-layer");
    await expect.poll(() => painted(canvas)).toBeGreaterThan(500);
    // The canvas has the size of the playground, not of the cell.
    await expect(canvas).toHaveAttribute("width", "1920");
    await expect(canvas).toHaveAttribute("height", "240");
    // The layer is at its vertical cell, and the picture fits inside it on the ground of the cell.
    const box = await layer.boundingBox();
    if (!box) throw new Error("The characters layer has no box.");
    const near = (actual: number, expected: number): void => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);
    near(box.x, 0);
    near(box.y, (tall.r * 60) / 2);
    near(box.width, 540);
    near(box.height, (tall.h * 60) / 2);
    const fit: string[] = await canvas.evaluate((element: Element): string[] => {
      const style: CSSStyleDeclaration = getComputedStyle(element);
      return [style.objectFit, style.objectPosition];
    });
    expect(fit).toEqual(["contain", "50% 100%"]);
    await close(page);
  } finally {
    await runSql("characters-vertical-restore", [noKeysSql]);
  }
});

test("a refresh draws the playground again from the new socket's full frame, never from tick frames alone", async ({
  browser,
}) => {
  await setLayers("characters-refresh", CHARACTERS_ON);
  const before: Frames = playground(2, 6);
  const after: Frames = playground(3, 9);
  const page = await obsPage(browser, REFRESH_IP, { width: 1920, height: 240 });
  const sockets = await mockFeed(page, (index: number) =>
    index === 0 ? [SNAPSHOT, before.full, ...before.ticks] : [SNAPSHOT, ...after.ticks],
  );
  await page.goto("/@feature_host/overlay?key=e2e-key&layer=characters");
  const canvas = page.locator("canvas.characters-layer");
  await expect.poll(() => painted(canvas)).toBeGreaterThan(500);
  await page.reload();
  await expect.poll(() => sockets.length).toBe(2);
  await expect(canvas).toHaveAttribute("width", "1920");
  // Tick frames without a full frame do not say what the playground is: nothing shows.
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 500)));
  expect(await painted(canvas)).toBe(0);
  // The new full frame (what the server sends on every new socket) brings the current playground back.
  sockets[1].send(after.full);
  sockets[1].send(after.ticks[0]);
  await expect.poll(() => painted(canvas)).toBeGreaterThan(500);
  await close(page);
});

test("the editor preview opens the owner's characters socket only while the characters layer is on", async ({
  browser,
}) => {
  // The chat is on stream. The characters are on the grid and off stream.
  await setLayers("characters-editor", {
    chat: { enabled: true },
    cells: { horizontal: { chat: CHAT_CELL, characters: CHARACTERS_CELL } },
  });
  const frames: Frames = playground(4, 8);
  const owner = await signedIn(browser, "featureowner", EDITOR_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  const sockets = await mockFeed(page, () => [SNAPSHOT, frames.full, ...frames.ticks]);
  await page.route("**/api/overlay/characters", (route: Route) =>
    route.fulfill({ json: { paused: false, testEndsAt: null } }),
  );
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  const frame = editor.getByRole("region", { name: "Composition preview" });
  await expect(frame).toHaveAttribute("data-scaled", "true");
  // The preview plays sample chat; with the characters layer off it opens no activity socket.
  await expect(frame.locator('.ov-layer[data-layer="chat"] li.wl-item').first()).toBeVisible();
  // The characters settings show for the selected layer.
  await chip(editor, "characters").click();
  const layer = settings(editor);
  await expect(layer).toHaveAttribute("data-comp-props", "characters");
  await expect(layer.locator("[data-characters-empty]")).toHaveText(
    "Turn on “Show on stream” to see the characters here.",
  );
  expect(sockets).toHaveLength(0);
  await layer.getByRole("checkbox", { name: "Show on stream" }).check();
  await expect.poll(() => sockets.length).toBe(1);
  const url = new URL(sockets[0].url());
  // The owner's socket: no key, with characters.
  expect(url.pathname).toBe("/api/activity/feature_host");
  expect(url.searchParams.get("key")).toBeNull();
  expect(url.searchParams.get("characters")).toBe("1");
  const canvas = frame.locator('.ov-layer[data-layer="characters"] canvas.characters-layer');
  await expect.poll(() => painted(canvas)).toBeGreaterThan(500);
  // The sample chat stays: the chat preview never reads the live feed.
  await expect(frame.locator('.ov-layer[data-layer="chat"] li.wl-item').first()).toBeVisible();
  // The list shows each visible character with its platform.
  const list = layer.locator("[data-characters-list] li");
  await expect(list).toHaveCount(frames.roster.length);
  await expect(list.first()).toContainText(frames.roster[0].name);
  if (shotDir) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
      await expect(frame).toHaveAttribute("data-scaled", "true");
      await frame.evaluate((element: Element) => element.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: `${shotDir}/editor-preview-${width}.png` });
      await layer.evaluate((element: Element) => element.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: `${shotDir}/editor-controls-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  // Off again: the socket closes and no other opens.
  await layer.getByRole("checkbox", { name: "Show on stream" }).uncheck();
  await expect(layer.locator("[data-characters-empty]")).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
  expect(sockets).toHaveLength(1);
  await close(owner);
});

test("the characters controls send their requests, keep focus and name every control", async ({ browser }) => {
  await setLayers("characters-controls", CHARACTERS_ON);
  const frames: Frames = playground(5, 4);
  const owner = await signedIn(browser, "featureowner", CONTROLS_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  const sockets = await mockFeed(page, () => [SNAPSHOT, frames.full]);
  const bodies: unknown[] = [];
  let reply: { paused: boolean; testEndsAt: number | null } = { paused: false, testEndsAt: null };
  await page.route("**/api/overlay/characters", async (route: Route) => {
    const body: { op: string } = route.request().postDataJSON() as { op: string };
    bodies.push(body);
    if (body.op === "pause") reply = { ...reply, paused: true };
    if (body.op === "resume") reply = { ...reply, paused: false };
    if (body.op === "test") reply = { paused: false, testEndsAt: Date.now() + 300_000 };
    if (body.op === "stopTest") reply = { ...reply, testEndsAt: null };
    await route.fulfill({ json: reply });
  });
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  await expect.poll(() => sockets.length).toBe(1);
  // The page asks for the state once: pause and the test end are not in the layers.
  await expect.poll(() => bodies).toEqual([{ op: "status" }]);
  // The characters settings show for the selected layer. They have no test button of their own.
  await chip(editor, "characters").click();
  const layer = settings(editor);
  await expect(layer).toHaveAttribute("data-comp-props", "characters");
  await expect(layer.getByRole("button", { name: /test/i })).toHaveCount(0);

  // Timeout: an invalid value shows an error and saves nothing; a valid one saves through the layers.
  const timeout = layer.getByRole("textbox", { name: "Seconds without chat before a character walks out" });
  await expect(timeout).toHaveValue("60");
  await timeout.fill("5");
  // No error while typing; it shows, as an alert, when the owner tries to save.
  await expect(timeout).not.toHaveAttribute("aria-invalid", "true");
  await timeout.press("Enter");
  await expect(timeout).toHaveAttribute("aria-invalid", "true");
  await expect(timeout).toHaveAccessibleDescription(/Type a whole number from 10 to 600\./);
  await expect(layer.getByRole("alert")).toHaveText("Type a whole number from 10 to 600.");
  const saved: Promise<Request> = page.waitForRequest(
    (request: Request) =>
      request.url().endsWith("/api/overlay") && (request.postDataJSON() as { action?: string }).action === "layers",
  );
  await timeout.fill("45");
  await timeout.press("Enter");
  expect((await saved).postDataJSON()).toMatchObject({ action: "layers", characters: { timeout: 45 } });
  await expect(timeout).not.toHaveAttribute("aria-invalid", "true");

  // Pause and resume.
  const pause = layer.getByRole("button", { name: "Pause" });
  await pause.click();
  await expect(layer.getByRole("button", { name: "Resume" })).toBeFocused();
  await expect(layer.locator("[data-characters-paused]")).toBeVisible();
  await expect(layer.locator("[data-characters-news]")).toHaveText("Playground paused.");
  await layer.getByRole("button", { name: "Resume" }).click();
  await expect(layer.getByRole("button", { name: "Pause" })).toBeFocused();
  await expect(layer.locator("[data-characters-news]")).toHaveText("Playground resumed.");

  // The test: the one test button of the toolbar. Only the characters are on stream, so it starts only their test.
  // Focus stays on the button while the test starts and stops.
  const toggle = editor.locator("[data-test-toggle]");
  const testNews = editor.locator("[data-test-news]");
  await expect(toggle).toHaveAccessibleName("Start test");
  await toggle.click();
  await expect(toggle).toHaveAccessibleName("Stop test");
  await expect(toggle).toBeFocused();
  await expect(editor.locator("[data-test-status]")).toHaveText(/^The test runs in OBS\. \d+ s left\.$/);
  await expect(testNews).toHaveText("Test started. OBS shows sample data.");
  await toggle.press("Enter");
  await expect(toggle).toHaveAccessibleName("Start test");
  await expect(toggle).toBeFocused();
  await expect(testNews).toHaveText("Test stopped.");

  // A test started during a pause ends the pause, and says so before and after.
  await layer.getByRole("button", { name: "Pause" }).click();
  await expect(toggle).toHaveAccessibleDescription(/Starting the test resumes the playground\.$/);
  await toggle.click();
  await expect(testNews).toHaveText("Test started and the playground resumed. OBS shows sample data.");
  await expect(layer.getByRole("button", { name: "Pause" })).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAccessibleName("Start test");

  // Remove takes the roster id of the frames. When the character leaves, focus goes to the next Remove button.
  const first: RosterEntry = frames.roster[0];
  await layer.getByRole("button", { name: `Remove ${first.name}` }).click();
  await expect(layer.locator("[data-characters-news]")).toHaveText(`${first.name} removed.`);
  sockets[0].send(frames.without(first.id));
  await expect(layer.getByRole("button", { name: `Remove ${frames.roster[1].name}` })).toBeFocused();

  // Clear removes the builds with one click, without a question.
  await layer.getByRole("button", { name: "Clear all builds" }).click();
  await expect(layer.locator("[data-characters-news]")).toHaveText("All builds removed.");

  // Reset asks first, in the page.
  await layer.getByRole("button", { name: "Reset playground" }).click();
  const dialog = page.getByRole("dialog", { name: "Reset the playground?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(layer.locator("[data-characters-news]")).toHaveText("Playground reset.");

  expect(bodies).toEqual([
    { op: "status" },
    { op: "pause" },
    { op: "resume" },
    { op: "test" },
    { op: "stopTest" },
    { op: "pause" },
    { op: "test" },
    { op: "stopTest" },
    { op: "remove", id: first.id },
    { op: "clear" },
    { op: "reset" },
  ]);

  // Accessibility of the controls: every control has a name, ids are unique and descriptions point at real text.
  const problems = await layer.evaluate((root: Element) => {
    const issues: string[] = [];
    for (const control of root.querySelectorAll("button, input")) {
      const label: string =
        control.getAttribute("aria-label") ??
        (control.id ? (root.querySelector(`label[for="${control.id}"]`)?.textContent ?? "") : "");
      const text: string = control instanceof HTMLButtonElement ? (control.textContent ?? "") : "";
      const wrapped: string = control.closest("label")?.textContent ?? "";
      if (!(label || text || wrapped).trim()) issues.push(`unnamed ${control.outerHTML}`);
      for (const id of (control.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean))
        if (!document.getElementById(id)?.textContent?.trim()) issues.push(`empty description ${id}`);
    }
    const ids: string[] = [...document.querySelectorAll("[id]")].map((element: Element) => element.id);
    for (const id of ids) if (ids.indexOf(id) !== ids.lastIndexOf(id)) issues.push(`duplicate id ${id}`);
    if (root.querySelector("[disabled]:is(button)")) issues.push("a disabled button drops focus");
    return [...new Set(issues)];
  });
  expect(problems).toEqual([]);
  await expect(layer.locator("[data-characters-list]")).toHaveAccessibleName("Characters on the playground");
  await close(owner);
});

test("the maximum characters field saves through the layers and stays after a reload", async ({ browser }) => {
  await setLayers("characters-max", CHARACTERS_OFF);
  const owner = await signedIn(browser, "featureowner", CONTROLS_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  await chip(editor, "characters").click();
  const layer = settings(editor);
  const max = layer.getByRole("textbox", { name: "Maximum characters on screen" });
  await expect(max).toHaveValue("40");
  await expect(max).toHaveAccessibleDescription(/A whole number from 5 to 40\./);
  // A value outside the limits shows an error and saves nothing.
  await max.fill("41");
  await max.press("Enter");
  await expect(max).toHaveAttribute("aria-invalid", "true");
  await expect(layer.getByRole("alert")).toHaveText("Type a whole number from 5 to 40.");
  expect((await storedLayers(page)).characters.max).toBe(40);
  // A valid value saves when the field loses focus.
  const done: Promise<unknown> = saved(page);
  await max.fill("12");
  await max.blur();
  await done;
  await expect(max).not.toHaveAttribute("aria-invalid", "true");
  expect((await storedLayers(page)).characters.max).toBe(12);
  await page.reload();
  await chip(editor, "characters").click();
  await expect(max).toHaveValue("12");
  await close(owner);
});

test("a test started in another tab shows here: frames with the test make the editor read the status again", async ({
  browser,
}) => {
  await setLayers("characters-other-tab", CHARACTERS_ON);
  const frames: Frames = playground(6, 3);
  const testing = new PlaygroundSim({ cellsW: 32, cellsH: 4, rng: mulberry32(6) });
  testing.resumeAfter(0);
  testing.startTest();
  const owner = await signedIn(browser, "featureowner", OTHER_TAB_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  const sockets = await mockFeed(page, () => [SNAPSHOT, frames.full]);
  const bodies: unknown[] = [];
  let release: () => void = (): void => {};
  const held: Promise<void> = new Promise<void>((resolve: () => void): void => {
    release = resolve;
  });
  await page.route("**/api/overlay/characters", async (route: Route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) return route.fulfill({ json: { paused: false, testEndsAt: null } });
    await held;
    await route.fulfill({ json: { paused: false, testEndsAt: Date.now() + 300_000 } });
  });
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  const toggle = editor.locator("[data-test-toggle]");
  const status = editor.locator("[data-test-status]");
  await expect.poll(() => sockets.length).toBe(1);
  await expect(toggle).toHaveAccessibleName("Start test");
  // Another tab starts the test: this tab only sees it in the frames.
  sockets[0].send(encodeFrame(testing.fullFrame()));
  await expect.poll(() => bodies).toEqual([{ op: "status" }, { op: "status" }]);
  // While the status is read, the test runs here too, without a countdown.
  await expect(toggle).toHaveAccessibleName("Stop test");
  await expect(status).toHaveText("The test runs in OBS.");
  release();
  await expect(status).toHaveText(/^The test runs in OBS\. \d+ s left\.$/);
  await expect(toggle).toHaveAccessibleName("Stop test");
  await close(owner);
});

test("the test, pause and reset are unavailable while the saved characters layer is off stream", async ({
  browser,
}) => {
  await setLayers("characters-test-off", CHARACTERS_OFF);
  const owner = await signedIn(browser, "featureowner", CONTROLS_IP);
  const page = await newPage(owner);
  const bodies: unknown[] = [];
  await page.route("**/api/overlay/characters", async (route: Route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ json: { paused: false, testEndsAt: null } });
  });
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  await chip(editor, "characters").click();
  const layer = settings(editor);
  const toggle = editor.locator("[data-test-toggle]");
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await expect(toggle).toHaveAccessibleDescription("Put Chat or Characters on stream to start the test.");
  const hint = "Turn on “Show on stream” to pause, reset, or test the characters.";
  // A press starts nothing and tells the reason; force skips Playwright's own check of aria-disabled.
  await toggle.click({ force: true });
  await expect(toggle).toBeFocused();
  await expect(page.locator(".sb-toast")).toHaveText("Put Chat or Characters on stream to start the test.");
  for (const name of ["Pause", "Reset playground"]) {
    const button = layer.getByRole("button", { name });
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(button).toHaveAccessibleDescription(hint);
    await button.click({ force: true });
    await expect(button).toBeFocused();
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
  await expect(layer.locator("[data-characters-news]")).toHaveText("");
  // With the saved layer off the page does not even read the state: the playground keeps nothing then.
  expect(bodies).toEqual([]);
  await close(owner);
});

test("the controls show a calm note when the server has no playground", async ({ browser }) => {
  await setLayers("characters-server-off", CHARACTERS_ON);
  const owner = await signedIn(browser, "featureowner", CONTROLS_IP);
  const page = await newPage(owner);
  await mockFeed(page, () => [SNAPSHOT]);
  await page.route("**/api/overlay/characters", (route: Route) =>
    route.fulfill({ status: 503, json: { error: "Characters are off on this server." } }),
  );
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  await chip(editor, "characters").click();
  const layer = settings(editor);
  await expect(layer.locator("[data-characters-off]")).toHaveText("Characters are off on this server.");
  await expect(layer.locator("[data-characters-status-error]")).toHaveCount(0);
  // A control gets the same note, not an error toast.
  await layer.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Playground not changed" })).toHaveCount(0);
  await close(owner);
});

test("a closed feed empties the layer: no names, bubbles or badges stay on stream", async ({ browser }) => {
  await setLayers("characters-unavailable", CHARACTERS_ON);
  const frames: Frames = playground(6, 8);
  const page = await obsPage(browser, FEED_IP, { width: 1920, height: 240 });
  const sockets = await mockFeed(page, (index: number) =>
    index === 0 ? [SNAPSHOT, frames.full, ...frames.ticks] : [],
  );
  await page.goto("/@feature_host/overlay?key=e2e-key&layer=characters");
  const canvas = page.locator("canvas.characters-layer");
  await expect.poll(() => painted(canvas)).toBeGreaterThan(500);
  // Channels went off or the key was revoked: the server says so and closes the socket.
  sockets[0].send(JSON.stringify({ type: "unavailable" }));
  await expect.poll(() => painted(canvas)).toBe(0);
  await close(page);
});

test("pictures that fail to load leave the layer empty and log a fixed event", async ({ browser }) => {
  await setLayers("characters-failed", CHARACTERS_ON);
  const frames: Frames = playground(7, 6);
  const page = await obsPage(browser, FEED_IP, { width: 1920, height: 240 });
  const logged: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") logged.push(message.text());
  });
  await page.route("**/wasteland-courier.png*", (route: Route) => route.abort());
  await mockFeed(page, () => [SNAPSHOT, frames.full, ...frames.ticks]);
  await page.goto("/@feature_host/overlay?key=e2e-key&layer=characters");
  await expect.poll(() => logged.some((text: string) => text.includes("characters_layer_failed"))).toBe(true);
  const canvas = page.locator("canvas.characters-layer");
  await expect(canvas).toHaveCount(1);
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
  expect(await painted(canvas)).toBe(0);
  await close(page);
});

test("bubbles over a crowd: leader lines to clustered speakers, room for the test badge, right-to-left text", async ({
  browser,
}) => {
  const long = "this bunker smells like rust and old coffee, and the radio keeps playing the same songs";
  const cases = [
    {
      name: "leader-lines-1920",
      width: 1920,
      cellsW: 32,
      lines: [1, 2, 3, 4].map((n: number) => ({
        name: `Scav ${n}`,
        text: n === 2 ? long : `line ${n} from the crowd`,
      })),
      at: 290,
      spread: 6,
      test: false,
    },
    {
      name: "badge-band-720",
      width: 720,
      cellsW: 12,
      lines: [{ name: "Corner scav", text: long }],
      at: 228,
      spread: 0,
      test: true,
    },
    {
      name: "rtl-1920",
      width: 1920,
      cellsW: 32,
      lines: [
        { name: "דנה!", text: "שלום לכולם, מה שלומכם היום?" },
        { name: "«سارة»", text: "مرحبا يا أصدقاء، كيف حالكم؟" },
        { name: "Mixed 2", text: "gg, שלום!" },
      ],
      at: 150,
      spread: 60,
      test: false,
    },
  ];
  for (const scene of cases) {
    await setLayers(`characters-${scene.name}`, {
      characters: { enabled: true },
      cells: { horizontal: { characters: { c: 0, r: 14, w: scene.cellsW, h: 4 } } },
    });
    const page = await obsPage(browser, CROWD_IP, { width: scene.width, height: 240 });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.name));
    await mockFeed(page, () => [SNAPSHOT, crowd(scene.cellsW, scene.lines, scene)]);
    await page.goto("/@feature_host/overlay?key=e2e-key&layer=characters");
    const canvas = page.locator("canvas.characters-layer");
    await expect(canvas).toHaveAttribute("width", String(scene.width));
    await expect.poll(() => labelPixels(canvas, "#F6ECD2")).toBeGreaterThan(500);
    if (scene.test) {
      // No bubble paper under the badge row at the top right: the bubble starts below it.
      const covered: number = await canvas.evaluate((element: Element): number => {
        const target = element as HTMLCanvasElement;
        const data = target.getContext("2d")?.getImageData(target.width - 120, 0, 110, 44).data;
        let count = 0;
        if (data)
          for (let i = 0; i < data.length; i += 4)
            if (data[i] === 0xf6 && data[i + 1] === 0xec && data[i + 2] === 0xd2) count += 1;
        return count;
      });
      expect(covered).toBe(0);
      await expect.poll(() => labelPixels(canvas, "#E5BD54")).toBeGreaterThan(20);
    }
    expect(errors).toEqual([]);
    if (shotDir) await page.screenshot({ path: `${shotDir}/characters-${scene.name}.png` });
    await close(page);
  }
});

for (const [width, cellsW] of [
  [1920, 32],
  [720, 12],
] as const) {
  test(`bubbles carry the platform glyph and name of their speakers at ${width} x 240`, async ({ browser }) => {
    await setLayers(`characters-bubbles-${width}`, {
      characters: { enabled: true },
      cells: { horizontal: { characters: { c: 0, r: 14, w: cellsW, h: 4 } } },
    });
    const page = await obsPage(browser, BUBBLE_IP, { width, height: 240 });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.name));
    await mockFeed(page, () => [SNAPSHOT, talkers(cellsW)]);
    await page.goto("/@feature_host/overlay?key=e2e-key&layer=characters");
    const canvas = page.locator("canvas.characters-layer");
    await expect(canvas).toHaveAttribute("width", String(width));
    await expect.poll(() => painted(canvas)).toBeGreaterThan(500);
    // The Twitch, YouTube and Kick glyphs in the name rows of the bubbles, in the helmet colours. The narrow
    // playground has room for fewer bubbles side by side: the oldest go, so only some glyphs stay in sight.
    const colors: string[] = ["#9146FF", "#E5322D", "#53FC18"];
    const glyphs = async (): Promise<number[]> =>
      Promise.all(colors.map((color: string) => labelPixels(canvas, color)));
    if (width === 1920) await expect.poll(async () => Math.min(...(await glyphs()))).toBeGreaterThan(5);
    else await expect.poll(async () => (await glyphs()).filter((count: number) => count > 5).length).toBeGreaterThan(1);
    expect(errors).toEqual([]);
    if (shotDir) await page.screenshot({ path: `${shotDir}/characters-bubbles-${width}.png` });
    await close(page);
  });
}
