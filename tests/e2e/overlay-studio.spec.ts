import { inflateSync } from "node:zlib";
import type { Locator, Route, WebSocketRoute } from "@playwright/test";
import { close, expect, newPage, test, type Browser, type Page } from "./coverage";
import { clientIp } from "./client-ips";
import { runSql } from "./fixtures";
import {
  CHARACTERS_CELL,
  CHAT_CELL,
  FEATURE_HOST,
  POLL_CELL,
  chip,
  defaultLayers,
  gridButton,
  layersSql,
  placeLayer,
  resetLayers,
  saved,
  settings,
  storedLayers,
} from "./grid-helpers";
import { signedIn } from "./live-helpers";
import { CONTENT_LAYERS, emptyCells, type ContentLayer, type OverlayLayers } from "../../app/lib/overlay-layers";

// The overlay studio: step 2 of Overlay control. Each layer goes on the grid one time, and a selected layer shows
// its settings. The OBS page shows only the layers on the grid.
const PLACE_IP = clientIp("overlay-studio", 28);
const STREAM_IP = clientIp("overlay-studio", 29);
const TEST_IP = clientIp("overlay-studio", 30);
const LEGACY_IP = clientIp("overlay-studio", 31);
const PHONE_IP = clientIp("overlay-studio", 32);
const KEYS_IP = clientIp("overlay-studio", 33);
const OBS_IP = clientIp("overlay-studio", 34);
const QR_IP = clientIp("overlay-studio", 35);
const CAMERA_IP = clientIp("overlay-studio", 36);
const LAYOUT_IP = clientIp("overlay-studio", 37);

test.beforeEach(async () => {
  await runSql("overlay-studio-reset", [
    resetLayers,
    `UPDATE overlay_state SET show_results=1, message='', message_style='info' WHERE streamer_id=${FEATURE_HOST};`,
  ]);
});

test.afterAll(async () => {
  await runSql("overlay-studio-cleanup", [defaultLayers]);
});

/** An empty feed for the pages that open an activity socket: the OBS page with chat, and the characters preview. */
async function emptyFeed(page: Page): Promise<void> {
  await page.routeWebSocket("**/api/activity/**", (socket: WebSocketRoute) => {
    socket.send(JSON.stringify({ type: "snapshot", events: [], replay: true }));
  });
}

async function obsPage(browser: Browser, path: string = "/@feature_host/overlay?key=e2e-key"): Promise<Page> {
  const page = await newPage(browser, {
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${OBS_IP}` },
  });
  await emptyFeed(page);
  await page.goto(path);
  return page;
}

/** The names of the layers on a page, in the order of the document. */
function layerNames(page: Page | Locator): Promise<(string | null)[]> {
  return page
    .locator(".ov-layer")
    .evaluateAll((layers: Element[]) => layers.map((layer) => layer.getAttribute("data-layer")));
}

test("each content layer goes on the grid one time with its real content, and OBS shows the same layers", async ({
  browser,
}) => {
  const owner = await signedIn(browser, "featureowner", PLACE_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  const frame = editor.getByRole("region", { name: "Composition preview" });
  await expect(frame).toHaveAttribute("data-scaled", "true");
  const status = editor.locator("[data-grid-status]");
  // Each chip puts its layer at the first free place: four in the first two rows, then the next two rows.
  const places: Record<ContentLayer, string> = {
    poll: "column 1, row 1",
    topic: "column 9, row 1",
    next: "column 17, row 1",
    message: "column 25, row 1",
    card: "column 1, row 5",
    support: "column 9, row 5",
  };
  const names: Record<ContentLayer, string> = {
    poll: "Poll",
    topic: "Topic",
    next: "Up next",
    message: "Message banner",
    card: "Community card",
    support: "Support banner",
  };
  for (const layer of CONTENT_LAYERS) {
    await placeLayer(page, editor, layer);
    await expect(status).toHaveText(`${names[layer]} placed at ${places[layer]}, 8 × 4 cells.`);
    await expect(chip(editor, layer)).toHaveText(`${names[layer]}Placed`);
    await expect(settings(editor)).toHaveAttribute("data-comp-props", layer);
    await expect(settings(editor).getByRole("checkbox", { name: "Show on stream" })).toBeChecked();
    // Each content layer has the QR code switch. The message banner has none: it has no page to open.
    await expect(settings(editor).getByRole("checkbox", { name: "Show QR code" })).toHaveCount(
      layer === "message" ? 0 : 1,
    );
  }
  await expect(frame.locator("[data-grid-box]")).toHaveCount(6);
  // The preview shows the real content of each layer, like the stream.
  await expect(frame.locator('.ov-layer[data-layer="poll"] [data-overlay-mash]')).toBeVisible();
  // The topic layer took the newest topic of the page when it came on the grid.
  await expect(frame.locator('.ov-layer[data-layer="topic"] [data-overlay-source="topic"] h1')).toHaveText(/\S/);
  await expect(frame.locator('.ov-layer[data-layer="next"] [data-overlay-source="next"]')).toBeVisible();
  await expect(frame.locator('.ov-layer[data-layer="message"] [data-overlay-source="message"]')).toBeVisible();
  await expect(frame.locator('.ov-layer[data-layer="card"] [data-overlay-source="card"]')).toBeVisible();
  await expect(frame.locator('.ov-layer[data-layer="support"] [data-overlay-source="support"]')).toContainText(
    "ko-fi.com/feature_host",
  );

  // A layer is on the grid at most one time: the chip of a placed layer selects it and sends nothing.
  let posts: number = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/overlay") posts += 1;
  });
  for (const layer of CONTENT_LAYERS) {
    await chip(editor, layer).click();
    await expect(chip(editor, layer)).toHaveAttribute("aria-pressed", "true");
    await expect(frame.locator(`[data-grid-box="${layer}"]`)).toHaveAttribute("data-selected", "true");
    await expect(page.locator("#sb-announce-polite")).toHaveText(`${names[layer]} selected.`);
  }
  await expect(frame.locator("[data-grid-box]")).toHaveCount(6);
  expect(posts).toBe(0);
  const stored: OverlayLayers = await storedLayers(page);
  expect(stored.cells.horizontal).toEqual({
    ...emptyCells(),
    poll: { c: 0, r: 0, w: 8, h: 4 },
    topic: { c: 8, r: 0, w: 8, h: 4 },
    next: { c: 16, r: 0, w: 8, h: 4 },
    message: { c: 24, r: 0, w: 8, h: 4 },
    card: { c: 0, r: 4, w: 8, h: 4 },
    support: { c: 8, r: 4, w: 8, h: 4 },
  });
  expect(stored.cells.vertical).toEqual(emptyCells());

  // OBS shows the same six layers, each in its own cell of the frame, and nothing else.
  const obs = await obsPage(browser);
  await expect(obs.locator(".ov-design")).toHaveAttribute("data-scaled", "true");
  await expect(obs.locator(".ov-layer")).toHaveCount(6);
  expect(await layerNames(obs)).toEqual([...CONTENT_LAYERS]);
  await expect(obs.locator(".ov-composition > .ov-stage")).toHaveCount(0);
  const boxes = await obs
    .locator(".ov-layer")
    .evaluateAll((layers: Element[]) => layers.map((layer) => layer.getBoundingClientRect().toJSON() as DOMRect));
  for (const [index, box] of boxes.entries()) {
    expect(Math.round(box.width)).toBe(480);
    expect(Math.round(box.height)).toBe(240);
    for (const other of boxes.slice(index + 1)) {
      const apart: boolean =
        box.right <= other.left + 1 ||
        other.right <= box.left + 1 ||
        box.bottom <= other.top + 1 ||
        other.bottom <= box.top + 1;
      expect(apart).toBe(true);
    }
  }
  await close(obs);
  // A content source shows the content layers alone. A chat source has none of them.
  const content = await obsPage(browser, "/@feature_host/overlay?key=e2e-key&layer=content");
  await expect(content.locator(".ov-layer")).toHaveCount(6);
  await close(content);
  const chat = await obsPage(browser, "/@feature_host/overlay?key=e2e-key&layer=chat");
  await expect(chat.locator("main.overlay-screen")).toBeAttached();
  await expect(chat.locator(".ov-layer")).toHaveCount(0);
  await close(chat);
  await close(owner);
});

test("Show on stream and the background of a layer reach the OBS page at once", async ({ browser }) => {
  await runSql("overlay-studio-stream", [
    layersSql({ chat: { enabled: true }, cells: { horizontal: { chat: CHAT_CELL, poll: POLL_CELL } } }),
  ]);
  const owner = await signedIn(browser, "featureowner", STREAM_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  const frame = editor.getByRole("region", { name: "Composition preview" });
  const panel = settings(editor);
  const obs = await obsPage(browser);
  const obsPoll = obs.locator('.ov-layer[data-layer="poll"]');
  await expect(obsPoll.locator("[data-overlay-mash]")).toBeVisible();
  await expect(obs.locator('.ov-layer[data-layer="chat"]')).toHaveCount(1);
  // Mark the document: a reload would drop the mark.
  await obs.evaluate(() => document.documentElement.setAttribute("data-e2e-loaded", "1"));
  const background = (layer: Locator): Promise<string> =>
    layer.evaluate((element: Element) => getComputedStyle(element).getPropertyValue("--ov-bg").trim());

  // The background of the poll layer: each key press is one step of 5. The preview follows at once.
  await chip(editor, "poll").click();
  const range = panel.locator("[data-props-background]");
  const slider = range.getByRole("slider", { name: "Background" });
  await expect(slider).toHaveValue("100");
  expect(await background(obsPoll)).toBe("1");
  let save = saved(page);
  await slider.focus();
  for (let step = 0; step < 8; step += 1) await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", "60%");
  await expect(range.locator("[data-props-background-value]")).toHaveText("60%");
  await expect.poll(() => background(frame.locator('.ov-layer[data-layer="poll"]'))).toBe("0.6");
  await save;
  await expect.poll(() => background(obsPoll)).toBe("0.6");
  // The card background is thinner on stream. The text stays opaque.
  const card = obsPoll.locator(".overlay-card");
  await expect
    .poll(() => card.evaluate((element: Element) => getComputedStyle(element).backgroundColor))
    .toMatch(/(rgba\(.*, 0\.5\d*\)|\/ 0\.5\d*\))$/);
  expect(await card.evaluate((element: Element) => getComputedStyle(element).opacity)).toBe("1");
  expect((await storedLayers(page)).items.poll.backgroundOpacity).toBe(60);

  // "Show on stream" off: the layer leaves OBS and stays on the grid, dimmed. On: it is back.
  const show = panel.getByRole("checkbox", { name: "Show on stream" });
  save = saved(page);
  await show.uncheck();
  await save;
  await expect(obsPoll).toHaveCount(0);
  await expect(frame.locator('[data-grid-box="poll"]')).toHaveAttribute("data-off", "true");
  await expect(frame.locator('.ov-layer[data-layer="poll"]')).toHaveCount(0);
  await expect(chip(editor, "poll")).toHaveText("PollPlaced");
  save = saved(page);
  await show.check();
  await save;
  await expect(obsPoll.locator("[data-overlay-mash]")).toBeVisible();
  expect(await background(obsPoll)).toBe("0.6");

  // The chat has the same switch.
  await chip(editor, "chat").click();
  await expect(panel).toHaveAttribute("data-comp-props", "chat");
  save = saved(page);
  await show.uncheck();
  await save;
  await expect(obs.locator('.ov-layer[data-layer="chat"]')).toHaveCount(0);
  await expect(obsPoll).toHaveCount(1);
  save = saved(page);
  await show.check();
  await save;
  await expect(obs.locator('.ov-layer[data-layer="chat"]')).toHaveCount(1);
  // "Remove from grid" also takes a layer off the stream.
  save = saved(page);
  await panel.getByRole("button", { name: "Remove from grid" }).click();
  await save;
  await expect(obs.locator('.ov-layer[data-layer="chat"]')).toHaveCount(0);
  // The OBS page followed each change live, without a page load.
  await expect(obs.locator("html")).toHaveAttribute("data-e2e-loaded", "1");
  await close(obs);
  await close(owner);
});

test("the poll layer shows a QR code in OBS by default, and its switch removes it", async ({ browser }) => {
  await runSql("overlay-studio-qr", [layersSql({ cells: { horizontal: { poll: POLL_CELL } } })]);
  const owner = await signedIn(browser, "featureowner", QR_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  const frame = editor.getByRole("region", { name: "Composition preview" });
  const previewCode = frame.locator('.ov-layer[data-layer="poll"] [data-overlay-qr]');
  const obs = await obsPage(browser);
  const obsPoll = obs.locator('.ov-layer[data-layer="poll"]');
  const code = obsPoll.getByRole("img", { name: "QR code: open on your phone" });
  await expect(code).toBeVisible();
  // The code opens the poll that the layer shows, on the public page of the streamer.
  await expect(code).toHaveAttribute(
    "data-overlay-qr",
    /^http:\/\/localhost:5173\/@feature_host\?view=polls&entry=[\da-f-]{36}$/,
  );
  // The code is at least 96 design pixels, inside the card, and the card stays inside its cell.
  expect(await code.evaluate((element: HTMLElement) => element.offsetWidth)).toBeGreaterThanOrEqual(96);
  const inside: boolean = await code.evaluate((element: Element) => {
    const within = (inner: DOMRect, outer: DOMRect): boolean =>
      inner.left >= outer.left - 0.5 &&
      inner.right <= outer.right + 0.5 &&
      inner.top >= outer.top - 0.5 &&
      inner.bottom <= outer.bottom + 0.5;
    const card: Element | null = element.closest("article");
    const layer: Element | null = element.closest(".ov-layer");
    if (!card || !layer) return false;
    return (
      within(element.getBoundingClientRect(), card.getBoundingClientRect()) &&
      within(card.getBoundingClientRect(), layer.getBoundingClientRect())
    );
  });
  expect(inside).toBe(true);
  // The studio preview shows the same card.
  await expect(previewCode).toHaveCount(1);

  await chip(editor, "poll").click();
  const toggle = settings(editor).getByRole("checkbox", { name: "Show QR code" });
  await expect(toggle).toBeChecked();
  await expect(toggle).toHaveAccessibleDescription("Viewers scan it with a phone to open this item.");
  let save = saved(page);
  await toggle.uncheck();
  await save;
  await expect(code).toHaveCount(0);
  await expect(previewCode).toHaveCount(0);
  await expect(obsPoll.locator("[data-overlay-mash]")).toBeVisible();
  expect((await storedLayers(page)).items.poll.qr).toBe(false);
  save = saved(page);
  await toggle.check();
  await save;
  await expect(code).toBeVisible();
  await close(obs);
  await close(owner);
});

test("one Start test starts and stops the chat test and the characters test together", async ({ browser }) => {
  await runSql("overlay-studio-test", [
    layersSql({
      chat: { enabled: true },
      characters: { enabled: true },
      cells: { horizontal: { chat: CHAT_CELL, characters: CHARACTERS_CELL } },
    }),
  ]);
  const owner = await signedIn(browser, "featureowner", TEST_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await emptyFeed(page);
  // The character playground of this test: it records each control and answers with its state.
  const controls: string[] = [];
  let reply: { paused: boolean; testEndsAt: number | null } = { paused: false, testEndsAt: null };
  await page.route("**/api/overlay/characters", async (route: Route) => {
    const body = route.request().postDataJSON() as { op: string };
    controls.push(body.op);
    if (body.op === "test") reply = { paused: false, testEndsAt: Date.now() + 300_000 };
    if (body.op === "stopTest") reply = { ...reply, testEndsAt: null };
    await route.fulfill({ json: reply });
  });
  const actions: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/overlay")
      actions.push(request.postDataJSON());
  });
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  await expect.poll(() => controls).toEqual(["status"]);
  // The studio has one test button, in the toolbar.
  await expect(page.getByRole("button", { name: /test/i })).toHaveCount(1);
  const toggle = editor.locator(".ov-comp-bar").getByRole("button", { name: "Start test" });
  await expect(toggle).toHaveText("");
  const status = editor.locator("[data-test-status]");
  const news = editor.locator("[data-test-news]");
  await expect(toggle).toHaveAttribute("aria-disabled", "false");
  await expect(status).toContainText("Shows sample chat for 60 seconds and sample viewers as characters for 5 minutes");
  await expect(news).toHaveText("");

  // One press starts both tests. The time left is that of the longer test, the characters test.
  await toggle.click();
  const stop = editor.locator(".ov-comp-bar").getByRole("button", { name: "Stop test" });
  await expect(stop).toBeFocused();
  await expect(news).toHaveText("Test started. OBS shows sample data.");
  await expect(status).toHaveText(/^The test runs in OBS\. (300|29\d) s left\.$/);
  expect(actions).toEqual([{ action: "chatTest", on: true }]);
  expect(controls).toEqual(["status", "test"]);
  // The chat preview keeps its sample chat. OBS gets the TEST tag of the chat test.
  const obs = await obsPage(browser);
  await expect(obs.locator("[data-chat-test]")).toHaveText("TEST");
  await close(obs);

  // One press stops both.
  await stop.click();
  await expect(toggle).toBeFocused();
  await expect(news).toHaveText("Test stopped.");
  await expect(status).toContainText("Shows sample chat for 60 seconds");
  expect(actions).toEqual([
    { action: "chatTest", on: true },
    { action: "chatTest", on: false },
  ]);
  expect(controls).toEqual(["status", "test", "stopTest"]);

  // With the chat off stream the button starts the characters test alone.
  await chip(editor, "chat").click();
  const save = saved(page);
  await settings(editor).getByRole("checkbox", { name: "Show on stream" }).uncheck();
  await save;
  await toggle.click();
  await expect(stop).toBeVisible();
  expect(controls).toEqual(["status", "test", "stopTest", "test"]);
  expect(actions.filter((action) => (action as { action: string }).action === "chatTest")).toHaveLength(2);
  await stop.click();
  await expect(toggle).toBeVisible();
  expect(controls).toEqual(["status", "test", "stopTest", "test", "stopTest"]);
  await close(owner);
});

test("state from before the studio shows as layers: the source that was on air, the chat and nothing new", async ({
  browser,
}) => {
  // The old state: a message banner on air in the top bar at size L, the chat on, and layers without a version.
  const legacy = (air: string, layers: string): string =>
    `UPDATE overlay_state SET air='${air}', preview='{"type":"card","ref":null}', position='top', size='l', instant=1, message='Back soon', layers='${layers}', revision=revision+1 WHERE streamer_id=${FEATURE_HOST};`;
  await runSql("overlay-studio-legacy", [legacy('{"type":"message","ref":null}', '{"chat":{"enabled":true}}')]);
  const owner = await signedIn(browser, "featureowner", LEGACY_IP);
  try {
    // The OBS page: the chat keeps its old cell at the top left. The banner is beside it, where the top bar is free.
    const obs = await obsPage(browser);
    await expect(obs.locator(".ov-design")).toHaveAttribute("data-scaled", "true");
    await expect(obs.locator('.ov-layer[data-layer="message"] [data-overlay-source="message"]')).toContainText(
      "Back soon",
    );
    expect(await layerNames(obs)).toEqual(["message", "chat"]);
    const box = async (layer: string): Promise<{ x: number; y: number; width: number; height: number } | null> =>
      obs.locator(`.ov-layer[data-layer="${layer}"]`).boundingBox();
    expect(await box("chat")).toEqual({ x: 0, y: 0, width: 600, height: 840 });
    expect(await box("message")).toEqual({ x: 600, y: 0, width: 1320, height: 360 });
    await close(obs);

    // The control page shows the same layers, and no control from before the studio.
    const page = await newPage(owner);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/tools?view=overlay");
    const editor = page.locator("[data-composition-editor]");
    await expect(chip(editor, "chat")).toHaveText("ChatPlaced");
    await expect(chip(editor, "message")).toHaveText("Message bannerPlaced");
    await expect(chip(editor, "poll")).toHaveText("+ Poll");
    await expect(editor.locator("[data-grid-box]")).toHaveCount(2);
    await expect(page.locator("[data-ov-monitor]")).toHaveCount(0);
    const converted: OverlayLayers = await storedLayers(page);
    expect(converted.chat.enabled).toBe(true);
    expect(converted.items.message.enabled).toBe(true);
    expect(converted.cells).toEqual({
      horizontal: { ...emptyCells(), chat: CHAT_CELL, message: { c: 10, r: 0, w: 22, h: 6 } },
      vertical: { ...emptyCells(), chat: { c: 0, r: 16, w: 18, h: 10 }, message: { c: 0, r: 0, w: 18, h: 6 } },
    });
    await chip(editor, "message").click();
    await expect(page.locator("[data-ov-message]")).toHaveValue("Back soon");

    // The conversion happens one time: the owner takes the banner off the grid, and it does not come back.
    const save = saved(page);
    await settings(editor).getByRole("button", { name: "Remove from grid" }).click();
    await save;
    await page.reload();
    await expect(chip(editor, "message")).toHaveText("+ Message banner");
    await expect(editor.locator("[data-grid-box]")).toHaveCount(1);
    const again = await obsPage(browser);
    await expect(again.locator('.ov-layer[data-layer="chat"]')).toHaveCount(1);
    await expect(again.locator('.ov-layer[data-layer="message"]')).toHaveCount(0);
    await close(again);

    // Hidden was on air, and the chat was off: no layer comes on the grid.
    await runSql("overlay-studio-legacy-hidden", [legacy('{"type":"hidden","ref":null}', "{}")]);
    await page.reload();
    await expect(editor.locator("[data-comp-grid]")).toBeVisible();
    await expect(editor.locator("[data-grid-box]")).toHaveCount(0);
    expect((await storedLayers(page)).cells).toEqual({ horizontal: emptyCells(), vertical: emptyCells() });
    // The default source, the latest active poll, becomes the poll layer beside the old chat cell.
    await runSql("overlay-studio-legacy-auto", [legacy('{"type":"auto","ref":null}', "{}")]);
    await page.reload();
    await expect(chip(editor, "poll")).toHaveText("PollPlaced");
    await expect(editor.locator('.ov-layer[data-layer="poll"] [data-overlay-mash]')).toBeVisible();
    expect((await storedLayers(page)).cells.horizontal.poll).toEqual({ c: 0, r: 0, w: 32, h: 18 });
  } finally {
    await runSql("overlay-studio-legacy-restore", [
      `UPDATE overlay_state SET air='{"type":"auto","ref":null}', preview='{"type":"auto","ref":null}', position='lower', size='m', instant=0, message='' WHERE streamer_id=${FEATURE_HOST};`,
    ]);
    await close(owner);
  }
});

test("at 390 px the studio stacks the palette, the grid and the settings, and the page does not scroll sideways", async ({
  browser,
}) => {
  await runSql("overlay-studio-phone", [
    layersSql({ chat: { enabled: true }, cells: { horizontal: { chat: CHAT_CELL, poll: POLL_CELL } } }),
  ]);
  const owner = await signedIn(browser, "featureowner", PHONE_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  const frame = editor.getByRole("region", { name: "Composition preview" });
  await expect(frame).toHaveAttribute("data-scaled", "true");
  await chip(editor, "poll").click();
  const panel = settings(editor);
  await expect(panel).toHaveAttribute("data-comp-props", "poll");
  const sideways = (): Promise<number> =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await sideways()).toBe(0);
  const rect = async (locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
    const box = await locator.boundingBox();
    if (!box) throw new Error("No box.");
    return box;
  };
  const palette = await rect(editor.locator("[data-comp-palette]"));
  const grid = await rect(frame);
  const side = await rect(panel);
  // One column: the palette, then the grid, then the settings. Each is inside the screen width.
  expect(palette.y + palette.height).toBeLessThanOrEqual(grid.y);
  expect(grid.y + grid.height).toBeLessThanOrEqual(side.y);
  for (const box of [palette, grid, side]) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.width).toBeGreaterThan(300);
  }
  // Each control of the settings and of the toolbar is inside the screen width too.
  for (const control of await editor.locator("button:visible, input:visible, [role=combobox]:visible").all()) {
    const box = await rect(control);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  // The same holds with the vertical frame and with the settings of the characters, the longest panel.
  let save = saved(page);
  await editor.getByRole("button", { name: "Vertical", exact: true }).click();
  await save;
  await expect(frame).toHaveAttribute("data-orientation", "vertical");
  await page.route("**/api/overlay/characters", (route: Route) =>
    route.fulfill({ json: { paused: false, testEndsAt: null } }),
  );
  await emptyFeed(page);
  save = saved(page);
  await chip(editor, "characters").click();
  await save;
  await expect(panel).toHaveAttribute("data-comp-props", "characters");
  await expect(panel.getByRole("button", { name: "Reset playground" })).toBeVisible();
  expect(await sideways()).toBe(0);

  // On a phone the settings stay below the grid of the vertical output too, and the help is below them.
  const help = editor.locator("[data-comp-help]");
  const tallPhone = { grid: await rect(frame), side: await rect(panel), help: await rect(help) };
  expect(tallPhone.grid.y + tallPhone.grid.height).toBeLessThanOrEqual(tallPhone.side.y);
  expect(tallPhone.side.y + tallPhone.side.height).toBeLessThanOrEqual(tallPhone.help.y);

  // On a wide screen the palette is beside the work area. The settings are beside the grid of the vertical output.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(frame).toHaveAttribute("data-scaled", "true");
  const tall = {
    palette: await rect(editor.locator("[data-comp-palette]")),
    grid: await rect(frame),
    side: await rect(panel),
    help: await rect(help),
  };
  expect(tall.palette.x + tall.palette.width).toBeLessThanOrEqual(tall.grid.x);
  expect(tall.grid.x + tall.grid.width).toBeLessThanOrEqual(tall.side.x);
  expect(Math.abs(tall.grid.y - tall.side.y)).toBeLessThan(4);
  expect(Math.max(tall.grid.y + tall.grid.height, tall.side.y + tall.side.height)).toBeLessThanOrEqual(tall.help.y);
  expect(await sideways()).toBe(0);
  // The settings are below the grid of the horizontal output, at the width of the grid. The help is below them.
  save = saved(page);
  await editor.getByRole("button", { name: "Horizontal", exact: true }).click();
  await save;
  await expect(frame).toHaveAttribute("data-scaled", "true");
  await chip(editor, "poll").click();
  await expect(panel).toHaveAttribute("data-comp-props", "poll");
  const wide = {
    palette: await rect(editor.locator("[data-comp-palette]")),
    grid: await rect(frame),
    side: await rect(panel),
    help: await rect(help),
  };
  expect(wide.palette.x + wide.palette.width).toBeLessThanOrEqual(wide.grid.x);
  expect(Math.abs(wide.palette.y - wide.grid.y)).toBeLessThan(40);
  expect(wide.grid.y + wide.grid.height).toBeLessThanOrEqual(wide.side.y);
  expect(Math.abs(wide.grid.x - wide.side.x)).toBeLessThan(2);
  expect(Math.abs(wide.grid.width - wide.side.width)).toBeLessThan(2);
  expect(wide.side.y + wide.side.height).toBeLessThanOrEqual(wide.help.y);
  expect(await sideways()).toBe(0);
  // The toolbar is one line: the tabs, the layout list, and the icon buttons at the right edge of the step.
  const bar = await rect(editor.locator("[data-comp-toolbar]"));
  const tools = await rect(editor.locator("[data-comp-tools]"));
  const firstTab = await rect(editor.getByRole("button", { name: "Horizontal", exact: true }));
  const list = await rect(editor.getByRole("combobox", { name: "Layout" }));
  expect(bar.height).toBeLessThanOrEqual(48);
  expect(firstTab.x + firstTab.width).toBeLessThan(list.x);
  expect(list.x + list.width).toBeLessThan(tools.x);
  expect(Math.abs(tools.x + tools.width - (bar.x + bar.width))).toBeLessThan(2);
  for (const button of await editor.locator("[data-comp-tools] button").all()) {
    const box = await rect(button);
    expect(box.width).toBe(44);
    expect(box.height).toBe(44);
    await expect(button).toHaveText("");
    expect(await button.getAttribute("title")).toContain((await button.getAttribute("aria-label")) ?? "no name");
  }
  await close(owner);
});

test("the layer groups close and open, and the closed help for the grid stays in reach of the keyboard", async ({
  browser,
}) => {
  await runSql("overlay-studio-groups", [layersSql({ cells: { horizontal: { poll: POLL_CELL } } })]);
  const owner = await signedIn(browser, "featureowner", KEYS_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  const grid = gridButton(editor, "Layout grid, 32 columns by 18 rows");
  const picture = editor.locator('[data-comp-group="picture"]');
  const content = editor.locator('[data-comp-group="content"]');
  // The two groups start open. The summary of a group has its name and the number of its layers.
  await expect(picture).toHaveJSProperty("open", true);
  await expect(content).toHaveJSProperty("open", true);
  await expect(picture.locator("summary")).toHaveText("Picture · 3");
  await expect(content.locator("summary")).toHaveText("Content · 6");
  await expect(picture.locator("[data-comp-layer]")).toHaveText(["+ Chat", "+ Characters", "+ Camera frame"]);
  // The poll is on the grid: its chip selects it.
  await chip(editor, "poll").click();
  await expect(settings(editor)).toHaveAttribute("data-comp-props", "poll");
  // Enter on the summary closes the group: its chips leave the tab sequence. The other group stays open.
  await content.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(content).toHaveJSProperty("open", false);
  await expect(chip(editor, "poll")).toBeHidden();
  await expect(chip(editor, "chat")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(grid).toBeFocused();
  // The layer stays selected. "Remove from grid" moves the focus to its chip, so the closed group opens.
  await expect(settings(editor)).toHaveAttribute("data-comp-props", "poll");
  const removed = saved(page);
  await settings(editor).getByRole("button", { name: "Remove from grid" }).click();
  await removed;
  await expect(content).toHaveJSProperty("open", true);
  await expect(chip(editor, "poll")).toBeFocused();
  await expect(chip(editor, "poll")).toHaveText("+ Poll");

  // The help for the grid is closed. Its text does not show.
  const help = editor.locator("[data-comp-help]");
  const summary = help.locator("summary");
  await expect(help).toHaveJSProperty("open", false);
  await expect(summary).toHaveText("How the grid works");
  await expect(help.getByText("Keyboard: arrow keys move the cursor", { exact: false })).toBeHidden();
  // While the help is closed, the grid has its description: a hidden text outside the help.
  const keys =
    "Select a placed layer to show its handles. Drag the layer to move it. Drag a handle to resize it. Drag the " +
    "layer onto “Layers · one of each” to remove it. Keyboard: arrow keys move the cursor, Space or Enter picks up " +
    "and puts down a layer, Shift + arrow moves the selected layer one cell, Alt + arrow resizes it one cell from " +
    "its bottom-right corner, Delete or Backspace removes the selected layer, Escape cancels.";
  await expect(grid).toHaveAccessibleDescription(keys);
  // The browser gives the same description to a screen reader, from its own accessibility tree.
  const session = await page.context().newCDPSession(page);
  const described = async (): Promise<string> => {
    const { root } = await session.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-comp-grid]" });
    const { nodes } = await session.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
    return String(nodes[0]?.description?.value ?? "");
  };
  expect(await described()).toBe(keys);
  // The summary is in the tab sequence after the settings. Enter opens the help, and all of its text shows.
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(help).toHaveJSProperty("open", true);
  await expect(help.locator("p")).toHaveText([
    "In “Layers · one of each”, select a layer to add it at the first free place. Or drag it onto the grid.",
    "Select a placed layer to show its handles. Drag the layer to move it. Drag a handle to resize it. Drag the layer onto “Layers · one of each” to remove it.",
    /^Keyboard: arrow keys move the cursor, .* Escape cancels\.$/,
    "A cell is 60 × 60 pixels. Set the OBS browser source to 1920 × 1080 for this orientation.",
  ]);
  await expect(help.locator("p").first()).toBeVisible();
  // The description of the grid is the same with the open help.
  await expect(grid).toHaveAccessibleDescription(keys);
  expect(await described()).toBe(keys);
  await page.keyboard.press("Enter");
  await expect(help).toHaveJSProperty("open", false);
  await close(owner);
});

test("the keyboard alone places, selects, changes and removes a layer", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", KEYS_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  const grid = gridButton(editor, "Layout grid, 32 columns by 18 rows");
  const status = editor.locator("[data-grid-status]");
  const panel = settings(editor);
  // Tab goes through the toolbar (the tabs, the layout list, the icon buttons), the preview background, then each
  // group of the palette with its chips in their order, then the grid. An icon button has no text: its name is its
  // label.
  await editor.getByRole("button", { name: "Horizontal", exact: true }).focus();
  const order: string[] = [];
  for (let step = 0; step < 17; step += 1) {
    await page.keyboard.press("Tab");
    order.push(
      await page.evaluate((): string => {
        const element: Element | null = document.activeElement;
        return (element?.getAttribute("aria-label") ?? element?.textContent ?? "").trim();
      }),
    );
  }
  expect(order).toEqual([
    "Vertical",
    "Your layout · not saved yet",
    "Save as a new layout",
    "Start test",
    "Transparent",
    "Sample game",
    "Picture · 3",
    "+ Chat",
    "+ Characters",
    "+ Camera frame",
    "Content · 6",
    "+ Poll",
    "+ Topic",
    "+ Up next",
    "+ Message banner",
    "+ Community card",
    "+ Support banner",
  ]);
  await page.keyboard.press("Tab");
  await expect(grid).toBeFocused();

  // Enter on a chip places its layer. The grid takes the focus, with the layer selected.
  await chip(editor, "topic").focus();
  let save = saved(page);
  await page.keyboard.press("Enter");
  await save;
  await expect(status).toHaveText("Topic placed at column 1, row 1, 8 × 4 cells.");
  await expect(grid).toBeFocused();
  await expect(panel).toHaveAttribute("data-comp-props", "topic");
  // The settings are a named region after the grid. Tab goes to its first control.
  await expect(page.getByRole("region", { name: "Topic" })).toBeVisible();
  await page.keyboard.press("Tab");
  const show = panel.getByRole("checkbox", { name: "Show on stream" });
  await expect(show).toBeFocused();
  save = saved(page);
  await page.keyboard.press("Space");
  await save;
  await expect(show).not.toBeChecked();
  expect((await storedLayers(page)).items.topic.enabled).toBe(false);
  save = saved(page);
  await page.keyboard.press("Space");
  await save;
  await expect(show).toBeChecked();

  // The picker opens and takes a choice with the keyboard.
  await page.keyboard.press("Tab");
  const picker = panel.getByRole("combobox", { name: "Topic" });
  await expect(picker).toBeFocused();
  // The layer took the newest topic of the page when it came on the grid, so the picker shows a topic.
  await expect(picker).not.toHaveText("Topic");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(picker).toBeFocused();
  // The QR code switch follows the Space key.
  await page.keyboard.press("Tab");
  const qr = panel.getByRole("checkbox", { name: "Show QR code" });
  await expect(qr).toBeFocused();
  save = saved(page);
  await page.keyboard.press("Space");
  await expect(qr).toBeChecked();
  await save;
  // The background slider follows the arrow keys.
  await page.keyboard.press("Tab");
  const slider = panel.getByRole("slider", { name: "Background" });
  await expect(slider).toBeFocused();
  save = saved(page);
  await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", "95%");
  await save;
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Remove from grid" })).toBeFocused();

  // Back on the grid: Shift + arrow moves the selected layer, Alt + arrow resizes it.
  await grid.focus();
  save = saved(page);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(status).toHaveText("Topic moved to column 1, row 2, 8 × 4 cells.");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(status).toHaveText("Topic resized to 9 × 4 cells at column 1, row 2.");
  await save;
  await expect.poll(async () => (await storedLayers(page)).cells.horizontal.topic).toEqual({ c: 0, r: 1, w: 9, h: 4 });

  // A second layer: the cursor selects it. Space picks up the layer at the cursor, and Escape puts it back.
  await chip(editor, "support").focus();
  save = saved(page);
  await page.keyboard.press("Space");
  await save;
  await expect(panel).toHaveAttribute("data-comp-props", "support");
  await expect(grid).toBeFocused();
  // The support banner is at the first free place: beside the topic, which has columns 1 to 9.
  await expect(grid).toHaveAccessibleName("Column 10, row 1: Support banner.");
  for (let step = 0; step < 9; step += 1) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveText("Column 1, row 2: Topic.");
  await page.keyboard.press("Space");
  await expect(status).toHaveText("Moving Topic. Move the cursor, then press Space or Enter.");
  await expect(panel).toHaveAttribute("data-comp-props", "topic");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-comp-props", "topic");

  // A chip of a placed layer selects the layer with Enter. "Remove from grid" returns the focus to the chip.
  await chip(editor, "support").focus();
  await page.keyboard.press("Enter");
  await expect(panel).toHaveAttribute("data-comp-props", "support");
  await expect(page.locator("#sb-announce-polite")).toHaveText("Support banner selected.");
  const remove = panel.getByRole("button", { name: "Remove from grid" });
  await remove.focus();
  save = saved(page);
  await page.keyboard.press("Enter");
  await save;
  await expect(chip(editor, "support")).toBeFocused();
  await expect(page.locator("#sb-announce-polite")).toHaveText("Support banner removed from the grid.");
  await expect(panel).toContainText("No layer selected");
  // Delete on the grid removes the selected layer.
  await grid.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Escape");
  save = saved(page);
  await page.keyboard.press("Delete");
  await save;
  await expect(status).toHaveText("Topic removed from the grid.");
  expect((await storedLayers(page)).cells.horizontal).toEqual(emptyCells());
  await close(owner);
});

/**
 * The opacity of the page at one point, from 0 (clear) to 255: the alpha of a screenshot of that one pixel without
 * the default white background of the browser. This is what OBS gets from a browser source.
 */
async function alphaAt(page: Page, x: number, y: number): Promise<number> {
  const png: Uint8Array = await page.screenshot({ omitBackground: true, clip: { x, y, width: 1, height: 1 } });
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // One PNG chunk: length, type, data, checksum. The data chunks together are one RGBA pixel after its filter byte.
  let offset = 8;
  const parts: Uint8Array[] = [];
  while (offset < png.length) {
    const length: number = view.getUint32(offset);
    const type: string = String.fromCodePoint(...png.subarray(offset + 4, offset + 8));
    if (type === "IDAT") parts.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const data = new Uint8Array(parts.reduce((sum: number, part: Uint8Array): number => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  const pixel: Uint8Array = inflateSync(data);
  // The browser writes a pixel without alpha as RGB or grey. Byte 25 of the file is the colour type.
  const colourType: number = png[25];
  if (colourType === 6) return pixel[4];
  if (colourType === 4) return pixel[2];
  if (colourType === 2 || colourType === 0) return 255;
  throw new Error(`The screenshot has colour type ${colourType}.`);
}

test("the camera frame has a clear window on stream at each size, and the editor tells where the camera goes", async ({
  browser,
}) => {
  const owner = await signedIn(browser, "featureowner", CAMERA_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  const frame = editor.getByRole("region", { name: "Composition preview" });
  await expect(frame).toHaveAttribute("data-scaled", "true");
  // The frame goes on the grid like each other layer, at its smallest size, and is on stream at once.
  await expect(chip(editor, "camera")).toHaveText("+ Camera frame");
  await placeLayer(page, editor, "camera");
  await expect(editor.locator("[data-grid-status]")).toHaveText("Camera frame placed at column 1, row 1, 6 × 4 cells.");
  await expect(frame.locator('[data-grid-box="camera"]')).toContainText("Camera frame · 360 × 240");
  const panel = settings(editor);
  await expect(panel).toHaveAttribute("data-comp-props", "camera");
  await expect(panel.getByRole("checkbox", { name: "Show on stream" })).toBeChecked();
  await expect(panel).toContainText(
    "In OBS, put your camera under the overlay source and make it as large as the window.",
  );
  await expect(panel.locator("[data-props-background], [data-props-qr]")).toHaveCount(0);
  expect(await storedLayers(page)).toMatchObject({
    camera: { enabled: true },
    cells: { horizontal: { camera: { c: 0, r: 0, w: 6, h: 4 } } },
  });
  // The preview marks the window for the owner.
  await expect(frame.locator('.ov-layer[data-layer="camera"] [data-camera-hint]')).toHaveText(
    "Your OBS camera shows here",
  );

  // OBS gets the frame without the text. The window is clear, and the band of the frame is not.
  const obs = await obsPage(browser, "/@feature_host/overlay");
  const layer = obs.locator('.ov-layer[data-layer="camera"]');
  await expect(layer.locator("[data-overlay-camera]")).toBeVisible();
  await expect(layer.locator("[data-camera-hint]")).toHaveCount(0);
  await expect(obs.getByText("Your OBS camera shows here")).toHaveCount(0);
  const clear = async (): Promise<{ window: number[]; band: number }> => {
    const box = await layer.boundingBox();
    if (!box) throw new Error("No camera frame.");
    const inside = (fx: number, fy: number): Promise<number> =>
      alphaAt(obs, Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy));
    return {
      // The middle of the window, and a point near each side of it.
      window: await Promise.all([
        inside(0.5, 0.5),
        inside(0.2, 0.5),
        inside(0.8, 0.5),
        inside(0.5, 0.25),
        inside(0.5, 0.75),
      ]),
      band: await alphaAt(obs, Math.round(box.x + box.width / 2), Math.round(box.y + 8)),
    };
  };
  expect(await layer.boundingBox()).toEqual({ x: 0, y: 0, width: 360, height: 240 });
  expect(await clear()).toEqual({ window: [0, 0, 0, 0, 0], band: 255 });

  // A larger frame, at odd cells: the window is clear again. OBS gets the change without a load.
  const moved = await owner.request.post("/api/overlay", {
    data: { action: "layers", cells: { horizontal: { camera: { c: 17, r: 5, w: 15, h: 9 } } } },
  });
  expect(moved.ok()).toBe(true);
  await expect.poll(async () => (await layer.boundingBox())?.width).toBe(900);
  expect(await layer.boundingBox()).toEqual({ x: 1020, y: 300, width: 900, height: 540 });
  expect(await clear()).toEqual({ window: [0, 0, 0, 0, 0], band: 255 });

  // "Show on stream" off takes the frame off the stream and keeps its place on the grid.
  const done = saved(page);
  await panel.getByRole("checkbox", { name: "Show on stream" }).uncheck();
  await done;
  await expect(layer).toHaveCount(0);
  await expect(frame.locator('[data-grid-box="camera"]')).toHaveAttribute("data-off", "true");
  await close(obs);
  await close(owner);
});

/** The answer of a layout action. */
function layoutSaved(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/overlay/layouts" &&
      response.ok(),
  );
}

test("the owner picks a preset in the list, changes it, resets it, and keeps layouts of their own, and OBS follows", async ({
  browser,
}) => {
  // The page has a layout from before the layouts: the chat on the horizontal grid.
  await runSql("overlay-studio-layouts", [
    layersSql({ chat: { enabled: true }, cells: { horizontal: { chat: CHAT_CELL } } }),
  ]);
  const owner = await signedIn(browser, "featureowner", LAYOUT_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  const frame = editor.getByRole("region", { name: "Composition preview" });
  const picker = editor.locator('[data-layout-picker="horizontal"]');
  const list = picker.getByRole("combobox", { name: "Layout" });
  const obs = await obsPage(browser);
  // The layout that the page has is on stream. It is not a saved layout yet.
  await expect(list).toHaveText("Your layout · not saved yet");
  await expect(obs.locator('.ov-layer[data-layer="chat"]')).toBeVisible();
  await expect(obs.locator('.ov-layer[data-layer="camera"]')).toHaveCount(0);

  // One step: the list is in the toolbar above the grid. A preset opens in the grid and goes on stream at once.
  await list.click();
  await expect(page.getByRole("option")).toHaveText([
    "Just chatting · preset",
    "Gameplay · preset",
    "Your layout · not saved yet",
    "New layout…",
  ]);
  let done = layoutSaved(page);
  await page.getByRole("option", { name: "Gameplay · preset" }).click();
  await done;
  await expect(list).toHaveText("Gameplay · preset");
  for (const layer of ["camera", "chat", "poll", "characters"])
    await expect(frame.locator(`[data-grid-box="${layer}"]`)).toHaveCount(1);
  // OBS shows the layout without a reload.
  await expect(obs.locator('.ov-layer[data-layer="camera"]')).toBeVisible();
  const loads: string[] = [];
  obs.on("framenavigated", (navigated) => loads.push(navigated.url()));

  // An edit of the grid changes the preset: the list says so, and an icon button brings the preset back.
  await expect(picker.locator("[data-layout-reset]")).toHaveCount(0);
  const removed = saved(page);
  await page.locator('[data-comp-layer="poll"]').click();
  await page.getByRole("button", { name: "Remove from grid" }).click();
  await removed;
  await expect(list).toHaveText("Gameplay · preset, changed by you");
  const reset = picker.getByRole("button", { name: "Reset to the preset" });
  await expect(reset).toHaveText("");
  await expect(reset).toHaveAttribute("title", "Reset to the preset");
  await expect(reset.locator("svg")).toHaveClass(/icon-reset/);
  done = layoutSaved(page);
  await reset.click();
  await done;
  await expect(frame.locator('[data-grid-box="poll"]')).toHaveCount(1);
  await expect(list).toHaveText("Gameplay · preset");
  await expect(picker.locator("[data-layout-reset]")).toHaveCount(0);

  // A copy with a name of the owner goes on stream.
  const saveAs = picker.getByRole("button", { name: "Save as a new layout" });
  await expect(saveAs).toHaveText("");
  await expect(saveAs).toHaveAttribute("title", "Save as a new layout");
  await expect(saveAs.locator("svg")).toHaveClass(/icon-save/);
  await saveAs.click();
  const fresh = page.getByRole("dialog", { name: "New layout" });
  const create = fresh.getByRole("button", { name: "Create and put on stream" });
  await expect(create).toBeDisabled();
  await fresh.getByLabel("Name").fill("Raid night");
  await expect(fresh.getByRole("radio", { name: "Start from a copy of the layout on stream" })).toBeChecked();
  done = layoutSaved(page);
  await create.click();
  await done;
  await expect(fresh).toHaveCount(0);
  await expect(list).toHaveText("Raid night");
  await expect(frame.locator('[data-grid-box="camera"]')).toHaveCount(1);

  // A second tab of the owner is open. It must get the new name and the deleted layout without a load.
  const other = await newPage(owner);
  await other.goto("/tools?view=overlay");
  const otherList = other.locator('[data-layout-picker="horizontal"]').getByRole("combobox", { name: "Layout" });
  await expect(otherList).toHaveText("Raid night");

  // The layout that the page had first is a layout of the owner now. It gets a new name, and then it goes. The
  // last entry of the list opens the layouts of the owner. It is not a layout: the list keeps its value.
  await list.click();
  await expect(page.getByRole("option")).toHaveText([
    "Just chatting · preset",
    "Gameplay · preset",
    "My layout",
    "Raid night",
    "New layout…",
    "Rename or delete layouts…",
  ]);
  await page.getByRole("option", { name: "Rename or delete layouts…" }).click();
  const mine = page.getByRole("dialog", { name: "Your layouts" });
  await expect(mine.locator("[data-layout-row]")).toHaveCount(2);
  const first = mine.locator("[data-layout-row]").filter({ has: page.getByLabel("Name of My layout") });
  const onStream = mine.locator("[data-layout-row]").filter({ has: page.getByLabel("Name of Raid night") });
  // The layout on stream cannot go.
  await expect(onStream.getByRole("button", { name: "Delete" })).toBeDisabled();
  await expect(onStream).toContainText("On stream. Select a different layout before you delete this one.");
  await first.getByLabel("Name of My layout").fill("Cozy");
  done = layoutSaved(page);
  await first.getByRole("button", { name: "Save name" }).click();
  await done;
  await otherList.click();
  await expect(other.getByRole("option", { name: "Cozy" })).toBeVisible();
  await other.keyboard.press("Escape");
  const cozy = mine.locator("[data-layout-row]").filter({ has: page.getByLabel("Name of Cozy") });
  done = layoutSaved(page);
  await cozy.getByRole("button", { name: "Delete" }).click();
  await done;
  await expect(mine.locator("[data-layout-row]")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(list).toHaveText("Raid night");
  await otherList.click();
  await expect(other.getByRole("option", { name: "Raid night" })).toBeVisible();
  await expect(other.getByRole("option", { name: "Cozy" })).toHaveCount(0);
  await other.keyboard.press("Escape");
  await close(other);

  // The layouts hold after a load, and the other output has its own list.
  await page.reload();
  await expect(list).toHaveText("Raid night");

  // A layout action waits for a grid edit that still saves. Else the edit would change the layout that comes.
  const order: string[] = [];
  await page.route("**/api/overlay", async (route) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 700));
    order.push("grid edit");
    await route.continue();
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/overlay/layouts") order.push("layout action");
  });
  await page.locator('[data-comp-layer="poll"]').click();
  const slider = page.locator("[data-props-background]").getByRole("slider", { name: "Background" });
  await slider.focus();
  await page.keyboard.press("ArrowLeft");
  await list.click();
  done = layoutSaved(page);
  await page.getByRole("option", { name: "Gameplay · preset" }).click();
  await done;
  expect(order).toEqual(["grid edit", "layout action"]);
  await page.unroute("**/api/overlay");
  await expect(list).toHaveText("Gameplay · preset");
  const outputSaved = saved(page);
  await editor.getByRole("button", { name: "Vertical", exact: true }).click();
  await outputSaved;
  const tall = editor.locator('[data-layout-picker="vertical"]').getByRole("combobox", { name: "Layout" });
  await tall.click();
  await expect(page.getByRole("option")).toHaveText([
    "Vertical · preset",
    "Your layout · not saved yet",
    "New layout…",
  ]);
  await page.keyboard.press("Escape");
  // OBS never loaded the page again.
  expect(loads).toEqual([]);
  await Promise.all([close(owner), close(obs)]);
});
