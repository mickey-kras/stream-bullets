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
  await page.goto("/overlay-control");
  const editor = page.locator("[data-composition-editor]");
  const frame = editor.getByRole("region", { name: "Composition preview" });
  await expect(frame).toHaveAttribute("data-scaled", "true");
  const status = editor.locator("[data-grid-status]");
  // Each chip puts its layer at the first free place: four in the first two rows, then the next two rows.
  const places: Record<ContentLayer, string> = {
    poll: "column 1, row 1",
    topic: "column 5, row 1",
    next: "column 9, row 1",
    message: "column 13, row 1",
    card: "column 1, row 3",
    support: "column 5, row 3",
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
    await expect(status).toHaveText(`${names[layer]} placed at ${places[layer]}, 4 × 2 cells.`);
    await expect(chip(editor, layer)).toHaveText(`${names[layer]}Placed`);
    await expect(settings(editor)).toHaveAttribute("data-comp-props", layer);
    await expect(settings(editor).getByRole("checkbox", { name: "Show on stream" })).toBeChecked();
    // No layer has a QR setting yet.
    await expect(settings(editor).getByText(/QR/i)).toHaveCount(0);
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
    poll: { c: 0, r: 0, w: 4, h: 2 },
    topic: { c: 4, r: 0, w: 4, h: 2 },
    next: { c: 8, r: 0, w: 4, h: 2 },
    message: { c: 12, r: 0, w: 4, h: 2 },
    card: { c: 0, r: 2, w: 4, h: 2 },
    support: { c: 4, r: 2, w: 4, h: 2 },
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
  await page.goto("/overlay-control");
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
  await page.goto("/overlay-control");
  const editor = page.locator("[data-composition-editor]");
  await expect.poll(() => controls).toEqual(["status"]);
  // The studio has one test button, in the toolbar.
  await expect(page.getByRole("button", { name: /test/i })).toHaveCount(1);
  const toggle = editor.locator(".ov-comp-bar").getByRole("button", { name: "Start test" });
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
    await page.goto("/overlay-control");
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
      horizontal: { ...emptyCells(), chat: CHAT_CELL, message: { c: 5, r: 0, w: 11, h: 3 } },
      vertical: { ...emptyCells(), chat: { c: 0, r: 8, w: 9, h: 5 }, message: { c: 0, r: 0, w: 9, h: 3 } },
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
    expect((await storedLayers(page)).cells.horizontal.poll).toEqual({ c: 0, r: 0, w: 16, h: 9 });
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
  await page.goto("/overlay-control");
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
  await editor.getByRole("button", { name: "Vertical 9 × 16" }).click();
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

  // On a wide screen the three parts are side by side.
  await page.setViewportSize({ width: 1440, height: 1000 });
  save = saved(page);
  await editor.getByRole("button", { name: "Horizontal 16 × 9" }).click();
  await save;
  await expect(frame).toHaveAttribute("data-scaled", "true");
  const wide = {
    palette: await rect(editor.locator("[data-comp-palette]")),
    grid: await rect(frame),
    side: await rect(panel),
  };
  expect(wide.palette.x + wide.palette.width).toBeLessThanOrEqual(wide.grid.x);
  expect(wide.grid.x + wide.grid.width).toBeLessThanOrEqual(wide.side.x);
  expect(Math.abs(wide.palette.y - wide.grid.y)).toBeLessThan(40);
  expect(await sideways()).toBe(0);
  await close(owner);
});

test("the keyboard alone places, selects, changes and removes a layer", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", KEYS_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/overlay-control");
  const editor = page.locator("[data-composition-editor]");
  const grid = gridButton(editor, "Layout grid, 16 columns by 9 rows");
  const status = editor.locator("[data-grid-status]");
  const panel = settings(editor);
  // Tab goes through the toolbar, then the chips in their order, then the grid.
  await editor.getByRole("button", { name: "Horizontal 16 × 9" }).focus();
  const order: string[] = [];
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    order.push(await page.evaluate(() => (document.activeElement?.textContent ?? "").trim()));
  }
  expect(order).toEqual([
    "Vertical 9 × 16",
    "Transparent",
    "Sample game",
    "Start test",
    "+ Chat",
    "+ Characters",
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
  await expect(status).toHaveText("Topic placed at column 1, row 1, 4 × 2 cells.");
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
  await expect(status).toHaveText("Topic moved to column 1, row 2, 4 × 2 cells.");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(status).toHaveText("Topic resized to 5 × 2 cells at column 1, row 2.");
  await save;
  await expect.poll(async () => (await storedLayers(page)).cells.horizontal.topic).toEqual({ c: 0, r: 1, w: 5, h: 2 });

  // A second layer: the cursor selects it. Space picks up the layer at the cursor, and Escape puts it back.
  await chip(editor, "support").focus();
  save = saved(page);
  await page.keyboard.press("Space");
  await save;
  await expect(panel).toHaveAttribute("data-comp-props", "support");
  await expect(grid).toBeFocused();
  // The support banner is at the first free place: column 1, row 1 is free above the topic.
  await expect(grid).toHaveAccessibleName("Column 6, row 1: Support banner.");
  for (let step = 0; step < 5; step += 1) await page.keyboard.press("ArrowLeft");
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
