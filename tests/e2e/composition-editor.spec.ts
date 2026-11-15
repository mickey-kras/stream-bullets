import { newPage, close, test, expect, type Page } from "./coverage";
import { runSql } from "./fixtures";
import { signedIn } from "./live-helpers";
import { clientIp } from "./client-ips";
import { DEFAULT_LAYERS, cellPixels, type OverlayLayers } from "../../app/lib/overlay-layers";
import { SAMPLE_INTERVAL_MS } from "../../app/components/overlay/use-chat";
import type { Locator } from "@playwright/test";

const OWNER_IP = clientIp("composition-editor", 245);
const MOTION_IP = clientIp("composition-editor", 246);
const OVERLAP_IP = clientIp("composition-editor", 247);
const LEAVE_IP = clientIp("composition-editor", 248);
const NAV_IP = clientIp("composition-editor", 249);

const FEATURE_HOST = "(SELECT id FROM streamers WHERE handle='feature_host')";
const resetLayers = `UPDATE overlay_state SET layers='{}', revision=revision+1 WHERE streamer_id=${FEATURE_HOST};`;
const chatOn = `UPDATE overlay_state SET layers='{"chat":{"enabled":true}}', revision=revision+1 WHERE streamer_id=${FEATURE_HOST};`;
// The seeded on-air content: the Mash Battle poll. It fills the top half of the stage (about y 48 to 550).
const seededAir = `UPDATE overlay_state SET air=json_object('type','poll','ref',(SELECT id FROM entries WHERE streamer_id=${FEATURE_HOST} AND title='Which boss first?')), revision=revision+1 WHERE streamer_id=${FEATURE_HOST};`;
const OVERLAP_NOTE = "Chat covers part of the on-air content. Move it to a free area.";

test.beforeEach(async () => {
  await runSql("composition-editor-reset", [resetLayers]);
});

test.afterAll(async () => {
  await runSql("composition-editor-cleanup", [resetLayers]);
});

function saved(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/overlay" && response.ok(),
  );
}

/** The saved layers, read through the API with the page's session. */
async function storedLayers(page: Page): Promise<OverlayLayers> {
  const response = await page.request.get("/api/overlay");
  return ((await response.json()) as { overlay: { layers: OverlayLayers } }).overlay.layers;
}

/** The grid button inside the application region that carries the grid name. */
function gridButton(editor: Locator, name: string | RegExp): Locator {
  return editor.getByRole("application", { name }).getByRole("button");
}

/** Pointer helpers for the grid: the centre of a cell in screen pixels. */
async function gridCells(
  grid: Locator,
  cols: number,
  rows: number,
): Promise<(c: number, r: number) => { x: number; y: number }> {
  const box = await grid.boundingBox();
  if (!box) throw new Error("No grid.");
  return (c: number, r: number) => ({
    x: Math.round(box.x + ((c + 0.5) * box.width) / cols),
    y: Math.round(box.y + ((r + 0.5) * box.height) / rows),
  });
}

async function dragCells(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

/** Strips the write order from request bodies: each editor sends its own random id. */
function withoutWrite(bodies: unknown[]): unknown[] {
  return bodies.map((value) => Object.fromEntries(Object.entries(value as object).filter(([key]) => key !== "write")));
}

/** The write order of each request body. */
function writes(bodies: unknown[]): { writer: string; seq: number }[] {
  return bodies.map((value) => (value as { write: { writer: string; seq: number } }).write);
}

test("the owner places layers on the grid by mouse and keyboard, and the layout persists", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  await expect(editor).toBeVisible();
  const frame = editor.getByRole("region", { name: "Composition preview" });
  await expect(frame).toHaveAttribute("data-scaled", "true");
  await expect(frame).toHaveAttribute("data-orientation", "horizontal");
  // The grid button sits in an application region, so screen readers pass the keys to it in browse mode. The region
  // names the grid; the button names the cursor cell, so a screen reader does not read the grid name twice.
  const app = editor.getByRole("application", { name: "Layout grid, 16 columns by 9 rows" });
  await expect(app.getByRole("button")).toHaveCount(1);
  const grid = gridButton(editor, "Layout grid, 16 columns by 9 rows");
  await expect(grid).toBeVisible();
  await expect(grid).toHaveAccessibleName("Column 1, row 1: Chat.");
  // The default places: chat on the left, the characters slot along the bottom, the content without a cell.
  await expect(frame.locator('[data-grid-box="chat"]')).toContainText("Chat · 600 × 840");
  await expect(frame.locator('[data-grid-box="characters"]')).toContainText("Characters · Coming soon");
  await expect(frame.locator('[data-grid-box="content"]')).toHaveCount(0);
  // Characters wait for the playground; chat is off by default.
  const chatLayer = editor.locator('[data-comp-layer="chat"]');
  await expect(editor.locator('[data-comp-layer="characters"]').getByRole("checkbox")).toBeDisabled();
  await expect(chatLayer.getByRole("checkbox", { name: "Show on stream" })).not.toBeChecked();
  await expect(frame.locator('.ov-layer[data-layer="chat"]')).toHaveCount(0);
  // Beside the toggle: chat on puts the on-air content in the layout of the preview.
  await expect(chatLayer.locator("[data-comp-scale]")).toContainText("turning on chat changes the size of the on-air");
  await expect(editor.locator("[data-comp-frame-size]")).toHaveText(
    "Set the OBS browser source to 1920 × 1080 for this orientation.",
  );

  let save = saved(page);
  await chatLayer.getByRole("checkbox", { name: "Show on stream" }).check();
  await save;
  // The preview plays sample chat without an activity socket.
  await expect(frame.locator('.ov-layer[data-layer="chat"] .wl-chat')).toBeVisible();

  // Keep the whole preview clear of the sticky header and footer.
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  let at = await gridCells(grid, 16, 9);
  const status = editor.locator("[data-grid-status]");

  // Drag a placed layer to move it: grabbed at its cell (2, 3), it moves 10 columns right.
  save = saved(page);
  await dragCells(page, at(2, 3), at(12, 3));
  await save;
  await expect(status).toHaveText("Chat moved to column 11, row 1, 5 × 7 cells.");
  expect((await storedLayers(page)).cells.horizontal.chat).toEqual({ c: 10, r: 0, w: 5, h: 7 });

  // A move onto the characters slot shows red and is not kept.
  await page.mouse.move(at(12, 3).x, at(12, 3).y);
  await page.mouse.down();
  await page.mouse.move(at(12, 6).x, at(12, 6).y, { steps: 4 });
  await expect(frame.locator("[data-grid-preview]")).toHaveAttribute("data-invalid", "true");
  await page.mouse.up();
  await expect(status).toHaveText("Not moved. It touches Characters.");
  await expect(status).toHaveAttribute("data-bad", "true");
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  expect((await storedLayers(page)).cells.horizontal.chat).toEqual({ c: 10, r: 0, w: 5, h: 7 });

  // Drag on empty cells to draw the selected layer: the content gets a cell.
  const content = editor.locator('[data-comp-layer="content"]');
  await expect(content.locator("[data-comp-content-note]")).toContainText("The content has no cell.");
  await editor.getByRole("button", { name: "On-air content (min. 4 × 2)" }).click();
  // The click scrolls the layer buttons into view: centre the preview again and measure the grid.
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  at = await gridCells(grid, 16, 9);
  save = saved(page);
  await dragCells(page, at(0, 0), at(5, 2));
  await save;
  await expect(status).toHaveText("On-air content placed at column 1, row 1, 6 × 3 cells.");
  await expect(frame.locator('[data-grid-box="content"]')).toContainText("On-air content · 720 × 360");
  await expect(content.locator("[data-comp-content-note]")).toContainText(
    "The position setting applies only when the content has no cell.",
  );
  // A shape below the minimum size is not kept.
  await dragCells(page, at(0, 4), at(1, 5));
  await expect(status).toHaveText("Not placed. On-air content needs at least 4 × 2 cells.");
  expect((await storedLayers(page)).cells.horizontal.content).toEqual({ c: 0, r: 0, w: 6, h: 3 });

  // Keyboard: the cursor starts at the first cell after a new page load.
  await page.reload();
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  await grid.focus();
  await expect(frame.locator("[data-grid-cursor]")).toBeVisible();
  // Space picks up the content at the cursor, an arrow carries it, Space puts it down.
  await page.keyboard.press("Space");
  await expect(status).toHaveText("Moving On-air content. Move the cursor, then press Space or Enter.");
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveText("Column 1, row 2: On-air content.");
  save = saved(page);
  await page.keyboard.press("Space");
  await save;
  await expect(status).toHaveText("On-air content moved to column 1, row 2, 6 × 3 cells.");
  // Escape cancels a pick.
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(status).toHaveText("Cancelled.");
  // Shift + arrow moves the selected layer one cell; it saves after a short pause.
  await editor.getByRole("button", { name: "Chat (min. 3 × 2)" }).click();
  await grid.focus();
  save = saved(page);
  await page.keyboard.press("Shift+ArrowRight");
  await save;
  await expect(status).toHaveText("Chat moved to column 12, row 1, 5 × 7 cells.");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(status).toHaveText("Chat moved to column 12, row 1, 5 × 7 cells.");
  expect((await storedLayers(page)).cells.horizontal).toMatchObject({
    chat: { c: 11, r: 0, w: 5, h: 7 },
    content: { c: 0, r: 1, w: 6, h: 3 },
  });

  // Remove takes the content off the grid: it uses the full frame again.
  save = saved(page);
  await content.getByRole("button", { name: "Remove from grid" }).click();
  await save;
  await expect(content.locator("[data-comp-content-note]")).toContainText("The content has no cell.");
  await expect(content.getByRole("button", { name: "Remove from grid" })).toHaveAttribute("aria-disabled", "true");
  await expect(content.getByRole("button", { name: "Remove from grid" })).toBeFocused();

  // The vertical orientation has its own layout and frame. The horizontal layout stays.
  save = saved(page);
  await editor.getByRole("button", { name: "Vertical 9 × 16" }).click();
  await save;
  await expect(frame).toHaveAttribute("data-orientation", "vertical");
  await expect(gridButton(editor, "Layout grid, 9 columns by 16 rows")).toBeVisible();
  await expect(frame.locator('[data-grid-box="chat"]')).toContainText("Chat · 1080 × 600");
  await expect(editor.locator("[data-comp-frame-size]")).toHaveText(
    "Set the OBS browser source to 1080 × 1920 for this orientation.",
  );
  const tall = gridButton(editor, "Layout grid, 9 columns by 16 rows");
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  at = await gridCells(tall, 9, 16);
  save = saved(page);
  await dragCells(page, at(4, 9), at(4, 1));
  await save;
  expect((await storedLayers(page)).cells.vertical.chat).toEqual({ c: 0, r: 0, w: 9, h: 5 });

  save = saved(page);
  await chatLayer.getByRole("checkbox", { name: "Hide chat commands (!jump)" }).uncheck();
  await save;
  await expect(editor.getByRole("status")).toHaveText("Layout saved.");

  await page.reload();
  await expect(frame).toHaveAttribute("data-orientation", "vertical");
  await expect(chatLayer.getByRole("checkbox", { name: "Show on stream" })).toBeChecked();
  await expect(chatLayer.getByRole("checkbox", { name: "Hide chat commands (!jump)" })).not.toBeChecked();
  save = saved(page);
  await editor.getByRole("button", { name: "Horizontal 16 × 9" }).click();
  await save;
  const layers: OverlayLayers = await storedLayers(page);
  expect(layers.orientation).toBe("horizontal");
  expect(layers.cells.horizontal).toEqual({
    chat: { c: 11, r: 0, w: 5, h: 7 },
    characters: DEFAULT_LAYERS.cells.horizontal.characters,
    content: null,
  });
  expect(layers.cells.vertical.chat).toEqual({ c: 0, r: 0, w: 9, h: 5 });
  await close(owner);
});

test("a new orientation ends a drag and keeps the keyboard cursor inside its grid", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  const frame = editor.getByRole("region", { name: "Composition preview" });
  const status = editor.locator("[data-grid-status]");
  await expect(editor.locator("[data-comp-orientation-note]")).toHaveText(
    "OBS switches to this orientation at once. Each orientation keeps its own layout.",
  );
  await expect(editor.getByRole("button", { name: "Vertical 9 × 16" })).toHaveAccessibleDescription(
    "OBS switches to this orientation at once. Each orientation keeps its own layout.",
  );
  const bodies: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/overlay")
      bodies.push(request.postDataJSON());
  });
  await editor.getByRole("button", { name: "On-air content (min. 4 × 2)" }).click();
  await gridButton(editor, "Layout grid, 16 columns by 9 rows").focus();
  // The cursor goes to the last column, and a drawing starts there.
  for (let step = 0; step < 15; step++) await page.keyboard.press("ArrowRight");
  await expect(status).toHaveText("Column 16, row 1: empty.");
  await page.keyboard.press("Space");
  await expect(status).toHaveText(
    "Drawing On-air content from column 16, row 1. Move the cursor, then press Space or Enter.",
  );
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(1);
  // Leaving the grid ends the drawing.
  const save = saved(page);
  await editor.getByRole("button", { name: "Vertical 9 × 16" }).click();
  await save;
  await expect(status).toHaveText("Cancelled.");
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  // The cursor is in the last column of the 9 columns now: the first key, Space, draws from there.
  const tall = gridButton(editor, "Layout grid, 9 columns by 16 rows");
  await tall.focus();
  await page.keyboard.press("Space");
  await expect(status).toHaveText(
    "Drawing On-air content from column 9, row 1. Move the cursor, then press Space or Enter.",
  );
  // Every cell of the drawing stays inside the vertical grid.
  for (const key of ["ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowDown"]) await page.keyboard.press(key);
  const placed = saved(page);
  await page.keyboard.press("Space");
  await placed;
  await expect(status).toHaveText("On-air content placed at column 6, row 1, 4 × 2 cells.");
  expect(withoutWrite(bodies)).toEqual([
    { action: "layers", orientation: "vertical" },
    { action: "layers", cells: { vertical: { content: { c: 5, r: 0, w: 4, h: 2 } } } },
  ]);
  expect((await storedLayers(page)).cells.vertical.content).toEqual({ c: 5, r: 0, w: 4, h: 2 });
  // A click without a pointer (a screen reader's activation) acts as Space: it picks up the layer at the cursor.
  await tall.dispatchEvent("click");
  await expect(status).toHaveText("Moving On-air content. Move the cursor, then press Space or Enter.");
  await page.keyboard.press("Escape");
  await expect(status).toHaveText("Cancelled.");
  // An orientation change from elsewhere (another tab, here a request) ends an open drawing without a blur.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveText("Column 6, row 4: empty.");
  await page.keyboard.press("Space");
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(1);
  const switched: number = await page.evaluate(async (): Promise<number> => {
    const response = await fetch("/api/overlay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "layers", orientation: "horizontal" }),
    });
    return response.status;
  });
  expect(switched).toBe(200);
  await expect(frame).toHaveAttribute("data-orientation", "horizontal");
  const wide = gridButton(editor, "Layout grid, 16 columns by 9 rows");
  await expect(wide).toBeFocused();
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  // Space starts a new drawing, so no drawing from the old grid was still open.
  await page.keyboard.press("Space");
  await expect(status).toHaveText(/^Drawing On-air content from column 6, row 4\./);
  await page.keyboard.press("Escape");
  await close(owner);
});

// The Take dock is taller where its title wraps (German, Russian), so check those languages too.
for (const locale of ["en", "de", "ru"]) {
  test(`on a 390 × 844 phone the whole vertical frame fits between the header and the Take dock (${locale})`, async ({
    browser,
  }) => {
    await runSql("composition-editor-vertical", [
      `UPDATE overlay_state SET layers='{"orientation":"vertical"}', revision=revision+1 WHERE streamer_id=${FEATURE_HOST};`,
    ]);
    const owner = await signedIn(browser, "featureowner", OWNER_IP);
    await owner.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/", sameSite: "Lax" }]);
    const page = await newPage(owner);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/overlay-control");
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const frame = page.locator(".ov-comp-frame");
    await expect(frame).toHaveAttribute("data-orientation", "vertical");
    const space = await page.evaluate(() => {
      const bottom = (selector: string): number =>
        document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0;
      const top = (selector: string): number => document.querySelector(selector)?.getBoundingClientRect().top ?? 0;
      return top(".ov-take-dock") - bottom("header");
    });
    const box = await frame.boundingBox();
    expect(box?.height).toBeGreaterThan(300);
    expect(box?.height).toBeLessThanOrEqual(space);
    await close(owner);
  });
}

test("the chat test starts and stops from the editor and shows the time left", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.goto("/overlay-control");
  const chatLayer = page.locator('[data-comp-layer="chat"]');
  const toggle = chatLayer.locator("[data-chat-test-toggle]");
  const status = chatLayer.locator("[data-chat-test-status]");
  const news = chatLayer.locator("[data-chat-test-news]");
  const bodies: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/overlay")
      bodies.push(request.postDataJSON());
  });
  // The test needs the chat layer on. The button stays focusable and ignores a press until then.
  await expect(toggle).toHaveText("Start chat test");
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await expect(status).toHaveText("Turn on “Show on stream” to test the chat.");
  // Force: Playwright waits for an aria-disabled button to become enabled.
  await toggle.click({ force: true });
  // The server checks the saved layer, so the test stays unavailable until the layer save lands.
  let releaseLayer: (() => void) | undefined;
  await page.route("**/api/overlay", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise<void>((resolve) => {
      releaseLayer = resolve;
    });
    return route.fallback();
  });
  let save = saved(page);
  const show = chatLayer.getByRole("checkbox", { name: "Show on stream" });
  await show.check();
  await expect.poll(() => releaseLayer !== undefined).toBe(true);
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await page.unroute("**/api/overlay");
  releaseLayer?.();
  await save;
  expect(withoutWrite(bodies)).toEqual([{ action: "layers", chat: { enabled: true } }]);
  await expect(toggle).toHaveAttribute("aria-disabled", "false");
  await expect(toggle).toHaveAccessibleDescription(
    "Shows sample chat in OBS for 60 seconds. Nothing goes to your channels.",
  );
  // The polite region is empty on load and speaks once for a start and once for a stop.
  await expect(news).toHaveText("");
  await expect(news).toHaveAttribute("aria-live", "polite");
  // Keyboard: focus stays on the toggle during its own request and after it. Hold the start request to see that.
  let release: (() => void) | undefined;
  await page.route("**/api/overlay", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return route.fallback();
  });
  await toggle.focus();
  save = saved(page);
  await page.keyboard.press("Enter");
  await expect.poll(() => release !== undefined).toBe(true);
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await expect(toggle).toBeFocused();
  // A second press during the request sends nothing.
  await page.keyboard.press("Enter");
  await page.unroute("**/api/overlay");
  release?.();
  await save;
  await expect(toggle).toHaveText("Stop");
  await expect(toggle).toBeFocused();
  await expect(news).toHaveText("Chat test started. OBS shows sample chat.");
  await expect(status).toHaveText(/^Sample chat shows in OBS\. (60|59|58) s left\.$/);
  save = saved(page);
  await page.keyboard.press("Enter");
  await expect(toggle).toBeFocused();
  await save;
  await expect(toggle).toHaveText("Start chat test");
  await expect(toggle).toBeFocused();
  await expect(news).toHaveText("Chat test stopped.");
  // Turning off the chat layer ends a running test: the server clears the end time.
  save = saved(page);
  await page.keyboard.press("Enter");
  await save;
  await expect(toggle).toHaveText("Stop");
  save = saved(page);
  await show.uncheck();
  await save;
  await expect(toggle).toHaveText("Start chat test");
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await expect(news).toHaveText("Chat test ended.");
  expect((await storedLayers(page)).chat.enabled).toBe(false);
  expect(withoutWrite(bodies).slice(1)).toEqual([
    { action: "chatTest", on: true },
    { action: "chatTest", on: false },
    { action: "chatTest", on: true },
    { action: "layers", chat: { enabled: false } },
  ]);
  await close(owner);
});

test("a rejected layer save rolls back and shows an error", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  const show = editor.locator('[data-comp-layer="chat"]').getByRole("checkbox", { name: "Show on stream" });
  await expect(show).not.toBeChecked();
  await page.route("**/api/overlay", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 429,
          headers: { "Retry-After": "60" },
          json: { error: "Too many requests. Wait one minute and try again." },
        })
      : route.fallback(),
  );
  // The optimistic tick rolls back as soon as the save fails.
  await show.click();
  await expect(editor.getByRole("alert")).toContainText("Too many requests");
  await expect(show).not.toBeChecked();
  await expect(editor.locator('.ov-layer[data-layer="chat"]')).toHaveCount(0);
  await close(owner);
});

test("a save sends only the changed fields, and a failure rolls back only its own fields", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  const chatLayer = editor.locator('[data-comp-layer="chat"]');
  const show = chatLayer.getByRole("checkbox", { name: "Show on stream" });
  const hide = chatLayer.getByRole("checkbox", { name: "Hide chat commands (!jump)" });
  await expect(show).not.toBeChecked();
  await expect(hide).toBeChecked();
  // The chat source note links to the channel connections on the same page.
  const connect = chatLayer.getByRole("link", { name: "Connect channels" });
  await expect(connect).toHaveAttribute("href", "#channels-title");
  await expect(connect).toHaveClass("text-link");
  await expect(chatLayer.locator("[data-comp-chat-source]")).toHaveText(
    "Chat shows messages from the channels you connect. Connect channels",
  );
  const bodies: unknown[] = [];
  const gate: { release?: () => void; next?: () => void } = {};
  await page.route("**/api/overlay", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) {
      // Hold the first save, then fail it while a later edit waits.
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return route.fulfill({ status: 429, json: { error: "Too many requests. Wait one minute and try again." } });
    }
    // Hold the second save until the error was seen: its success clears the error.
    await new Promise<void>((resolve) => {
      gate.next = resolve;
    });
    return route.fallback();
  });
  await show.click();
  await expect.poll(() => bodies.length).toBe(1);
  await hide.click();
  await expect(show).toBeChecked();
  await expect(hide).not.toBeChecked();
  expect(gate.release).toBeDefined();
  gate.release?.();
  await expect(editor.getByRole("alert")).toContainText("Too many requests");
  // Only the failed field rolls back. The later edit is kept and saved on its own.
  await expect.poll(() => bodies.length).toBe(2);
  gate.next?.();
  expect(withoutWrite(bodies)).toEqual([
    { action: "layers", chat: { enabled: true } },
    { action: "layers", chat: { hideCommands: false } },
  ]);
  // One editor id, and each request a higher number.
  const [first, second] = writes(bodies);
  expect(second.writer).toBe(first.writer);
  expect(second.seq).toBeGreaterThan(first.seq);
  await expect(show).not.toBeChecked();
  await expect(hide).not.toBeChecked();
  await expect(editor.getByRole("status")).toHaveText("Layout saved.");
  await close(owner);
});

test("a new overlay link lists one URL per layer", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.goto("/overlay-control");
  await page.getByText("Setup", { exact: true }).click();
  await expect(page.locator("[data-ov-layer-urls]")).toHaveCount(0);
  await page.getByRole("button", { name: /^(Create overlay link|Regenerate link)$/ }).click();
  // An existing link asks for confirmation first.
  const confirm = page.getByRole("dialog", { name: "Regenerate the overlay link?" });
  await expect(confirm.or(page.locator("[data-ov-url]"))).toBeVisible();
  if (await confirm.isVisible()) await confirm.getByRole("button", { name: "Regenerate link" }).click();
  const url: string = await page.locator("[data-ov-url]").inputValue();
  expect(url).toMatch(/\/@feature_host\/overlay\?key=/);
  for (const layer of ["chat", "content"])
    await expect(page.locator(`[data-ov-layer-url="${layer}"]`)).toHaveValue(`${url}&layer=${layer}`);
  // The chat URL names the source size; the characters row only says it is coming.
  const { w, h } = cellPixels(DEFAULT_LAYERS.cells.horizontal.chat);
  await expect(page.locator('[data-ov-layer-size="chat"]')).toHaveText(`Source size: ${w} × ${h}`);
  await expect(page.locator('[data-ov-layer-url="chat"]')).toHaveAccessibleDescription(`Source size: ${w} × ${h}`);
  await expect(page.locator('[data-ov-layer-url="characters"]')).toHaveCount(0);
  await expect(page.locator('[data-ov-layer-row="characters"]')).toContainText("Coming soon");
  await page.reload();
  await page.getByText("Setup", { exact: true }).click();
  await expect(page.locator(".ov-url")).toContainText("&layer=chat");
  await expect(page.locator("[data-ov-layer-url]")).toHaveCount(0);
  await close(owner);
  // Other specs start without an overlay key.
  await runSql("composition-editor-key", [
    `DELETE FROM overlay_keys WHERE streamer_id=(SELECT id FROM streamers WHERE handle='feature_host');`,
  ]);
});

/** Lets the page run one real task: a MessageChannel message is not a timer, so the fake clock does not hold it. */
function realTask(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (): void => resolve();
        channel.port2.postMessage(null);
      }),
  );
}

for (const reduced of [true, false]) {
  test(`with${reduced ? "" : "out"} reduced motion the preview ${reduced ? "keeps a still set of" : "adds"} sample rows`, async ({
    browser,
  }) => {
    await runSql("composition-editor-motion", [chatOn]);
    const owner = await signedIn(browser, "featureowner", MOTION_IP);
    const page = await newPage(owner);
    await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
    await page.clock.install();
    await page.goto("/overlay-control");
    const frame = page.getByRole("region", { name: "Composition preview" });
    const rows = frame.locator('.ov-layer[data-layer="chat"] li.wl-item');
    await expect(rows.first()).toBeVisible();
    const count: number = await rows.count();
    expect(count).toBeGreaterThan(1);
    const texts: string[] = await rows.locator(".wl-msg").allTextContents();
    // A moving preview adds a sample row each SAMPLE_INTERVAL_MS. The still one keeps the same rows.
    await page.clock.runFor(SAMPLE_INTERVAL_MS * 3);
    // Let React commit what the timers dispatched before the checks.
    await realTask(page);
    if (reduced) {
      await expect(rows).toHaveCount(count);
      expect(await rows.locator(".wl-msg").allTextContents()).toEqual(texts);
      await expect(frame.locator('li[data-phase="entering"]')).toHaveCount(0);
    } else {
      // The positive control: the same steps without reduced motion add rows.
      await expect.poll(() => rows.count()).toBeGreaterThan(count);
    }
    await close(owner);
  });
}

test("a note shows while the chat covers the on-air content and goes when the chat moves away", async ({ browser }) => {
  await runSql("composition-editor-overlap", [seededAir, chatOn]);
  const owner = await signedIn(browser, "featureowner", OVERLAP_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  const frame = editor.getByRole("region", { name: "Composition preview" });
  await expect(frame.locator(".ov-stage > *").first()).toBeVisible();
  // The default chat cell (columns 1 to 5, rows 1 to 7) covers the left part of the poll.
  const note = editor.locator("[data-comp-overlap]");
  await expect(note).toHaveText(OVERLAP_NOTE);
  // The note does not speak on page load, only after a change.
  await expect(note).toHaveAttribute("aria-live", "off");

  // Below the poll is free: draw the chat again in rows 6 and 7, beside its old place.
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  const grid = gridButton(editor, /^Layout grid/);
  let at = await gridCells(grid, 16, 9);
  let save = saved(page);
  await dragCells(page, at(6, 5), at(11, 6));
  await save;
  // The note stays mounted as a live region; it is empty when nothing is covered.
  await expect(note).toHaveText("");
  await expect(note).toHaveAttribute("aria-live", "polite");

  // Back over the poll, the note shows again. A hidden chat covers nothing.
  save = saved(page);
  await dragCells(page, at(8, 6), at(8, 1));
  await save;
  await expect(note).toHaveText(OVERLAP_NOTE);
  save = saved(page);
  await editor.locator('[data-comp-layer="chat"]').getByRole("checkbox", { name: "Show on stream" }).uncheck();
  await save;
  await expect(note).toHaveText("");
  // With a content cell, the content has its own place: the chat cannot cover it.
  save = saved(page);
  await editor.locator('[data-comp-layer="chat"]').getByRole("checkbox", { name: "Show on stream" }).check();
  await save;
  await expect(note).toHaveText(OVERLAP_NOTE);
  await editor.getByRole("button", { name: "On-air content (min. 4 × 2)" }).click();
  // The clicks above can scroll the page: measure the grid again.
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  at = await gridCells(grid, 16, 9);
  save = saved(page);
  await dragCells(page, at(0, 0), at(5, 4));
  await save;
  await expect(note).toHaveText("");
  await close(owner);
});

test("the characters slot label stays fully visible in its cell", async ({ browser }) => {
  await runSql("composition-editor-label", [chatOn]);
  const owner = await signedIn(browser, "featureowner", OVERLAP_IP);
  const cases: [string, string, number][] = [
    ["en", "Characters · Coming soon", 1440],
    ["de", "Figuren · Demnächst", 1440],
    ["ja", "キャラクター · 近日公開", 1440],
    ["en", "Characters · Coming soon", 390],
    ["de", "Figuren · Demnächst", 390],
    ["ja", "キャラクター · 近日公開", 390],
  ];
  for (const [locale, text, width] of cases) {
    await owner.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/" }]);
    const page = await newPage(owner);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/overlay-control");
    const frame = page.locator(".ov-comp-frame");
    await expect(frame).toHaveAttribute("data-scaled", "true");
    const slot = frame.locator('[data-grid-box="characters"]');
    const label = slot.locator(".ov-grid-soon");
    await expect(label).toHaveText(text);
    const box = await label.boundingBox();
    const cell = await slot.boundingBox();
    if (!box || !cell) throw new Error("No characters slot or label.");
    // The label is inside its slot, and no part of it is cut off.
    expect(box.x, `${locale} ${width}`).toBeGreaterThanOrEqual(cell.x - 1);
    expect(box.x + box.width, `${locale} ${width}`).toBeLessThanOrEqual(cell.x + cell.width + 1);
    expect(await label.evaluate((element: Element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await close(page);
  }
  await close(owner);
});

test("closing the editor sends an edit that waits for the idle save", async ({ browser }) => {
  await runSql("composition-editor-leave", [chatOn]);
  const owner = await signedIn(browser, "featureowner", LEAVE_IP);
  const page = await newPage(owner);
  await page.clock.install();
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  await expect(editor.getByRole("region", { name: "Composition preview" })).toHaveAttribute("data-scaled", "true");
  // A key edit saves after a short idle time. Stop the clock, so only leaving the page can send it.
  await page.clock.pauseAt(Date.now() + 1000);
  await nudgeRight(page);
  await page.goto("/settings");
  // The request left with the page, so read the saved layout from a new page load.
  await expect.poll(() => storedChatColumn(page)).toBe(1);
  await close(owner);
});

/** The footer link to the privacy page: an in-app navigation, so the editor unmounts and the page stays. */
async function leaveInApp(page: Page): Promise<void> {
  await page.evaluate(() => document.documentElement.setAttribute("data-e2e-loaded", "1"));
  await page.locator('footer a[href="/privacy"]').first().click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.locator("html")).toHaveAttribute("data-e2e-loaded", "1");
}

/** Moves the selected chat layer one cell right with the keyboard: a change that waits for the idle save. */
async function nudgeRight(page: Page): Promise<void> {
  await page.locator("[data-comp-grid]").focus();
  await page.keyboard.press("Shift+ArrowRight");
}

/** Picks up the chat at the cursor cell, carries it one cell right and puts it down: a change that saves at once. */
async function carryRight(page: Page): Promise<void> {
  await page.locator("[data-comp-grid]").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
}

async function storedChatColumn(page: Page): Promise<number> {
  return (await storedLayers(page)).cells.horizontal.chat.c;
}

test("leaving the editor by an in-app link sends the edit that waits for the idle save", async ({ browser }) => {
  await runSql("composition-editor-nav", [chatOn]);
  const owner = await signedIn(browser, "featureowner", NAV_IP);
  const page = await newPage(owner);
  await page.clock.install();
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  await expect(editor.getByRole("region", { name: "Composition preview" })).toHaveAttribute("data-scaled", "true");
  // Stop the clock, so only closing the editor can send the key edit.
  await page.clock.pauseAt(Date.now() + 1000);
  const sent = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/overlay",
  );
  await nudgeRight(page);
  await leaveInApp(page);
  expect((await sent).ok()).toBe(true);
  await expect.poll(() => storedChatColumn(page)).toBe(1);
  await close(owner);
});

test("leaving the editor during a save sends the newer edit after it, so the newer value is stored", async ({
  browser,
}) => {
  await runSql("composition-editor-race", [chatOn]);
  const owner = await signedIn(browser, "featureowner", NAV_IP);
  const page = await newPage(owner);
  await page.clock.install();
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  await expect(editor.getByRole("region", { name: "Composition preview" })).toHaveAttribute("data-scaled", "true");
  await page.clock.pauseAt(Date.now() + 1000);
  const bodies: unknown[] = [];
  const gate: { release?: () => void } = {};
  await page.route("**/api/overlay", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postDataJSON());
    // Hold the first save until the editor is closed.
    if (bodies.length === 1)
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    return route.fallback();
  });
  const chatBox = editor.locator('[data-grid-box="chat"]');
  await carryRight(page);
  await expect.poll(() => bodies.length).toBe(1);
  await nudgeRight(page);
  await expect(chatBox).toHaveCSS("left", "240px");
  await leaveInApp(page);
  // The newer edit waits for the save in flight.
  expect(bodies).toHaveLength(1);
  gate.release?.();
  await expect.poll(() => bodies.length).toBe(2);
  const chat = (c: number) => ({ cells: { horizontal: { chat: { ...DEFAULT_LAYERS.cells.horizontal.chat, c } } } });
  expect(withoutWrite(bodies)).toEqual([
    { action: "layers", ...chat(1) },
    { action: "layers", ...chat(2) },
  ]);
  await page.unroute("**/api/overlay");
  await expect.poll(() => storedChatColumn(page)).toBe(2);
  await close(owner);
});

for (const stale of [false, true]) {
  test(`a failed edit sent while leaving ${stale ? "is not shown after 60 seconds" : "shows its error when the owner comes back"}`, async ({
    browser,
  }) => {
    await runSql("composition-editor-leave-error", [chatOn]);
    const owner = await signedIn(browser, "featureowner", NAV_IP);
    const page = await newPage(owner);
    await page.clock.install();
    await page.goto("/overlay-control");
    const editor = page.getByRole("region", { name: "Composition", exact: true });
    await expect(editor.getByRole("region", { name: "Composition preview" })).toHaveAttribute("data-scaled", "true");
    await page.clock.pauseAt(Date.now() + 1000);
    await page.route("**/api/overlay", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 429, json: { error: "Too many requests. Wait one minute and try again." } })
        : route.fallback(),
    );
    const failed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/overlay");
    await nudgeRight(page);
    await leaveInApp(page);
    expect((await failed).status()).toBe(429);
    // The error of a change sent while leaving is stale after 60 seconds.
    if (stale) await page.clock.fastForward(61_000);
    // Back in the app (no page load), the editor shows the error with its own prefix, unless it is stale.
    await page.goBack();
    await expect(page.locator("html")).toHaveAttribute("data-e2e-loaded", "1");
    const back = page.getByRole("region", { name: "Composition", exact: true });
    await expect(back.locator("[data-comp-grid]")).toBeVisible();
    if (stale) await expect(back.getByRole("alert")).toHaveCount(0);
    else {
      const alert = back.getByRole("alert");
      await expect(alert).toHaveText(
        "Your last layout change was not saved. Make the change again. Reason: Too many requests. Wait one minute and try again.",
      );
      // The editor brings the error into view: it sits below the layer controls.
      await expect(alert).toBeInViewport();
    }
    await close(owner);
  });
}
