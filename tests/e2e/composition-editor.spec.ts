import { newPage, close, test, expect, type Page } from "./coverage";
import { runSql } from "./fixtures";
import { signedIn } from "./live-helpers";
import { clientIp } from "./client-ips";
import { cellPixels, emptyCells, type LayersPatch, type OverlayLayers } from "../../app/lib/overlay-layers";
import { SAMPLE_INTERVAL_MS } from "../../app/components/overlay/use-chat";
import {
  CHARACTERS_CELL,
  CHAT_CELL,
  PALETTE_HINT,
  chip,
  defaultLayers,
  gridButton,
  gridCells,
  layersSql,
  placeLayer,
  resetLayers,
  saved,
  settings,
  storedLayers,
} from "./grid-helpers";

const OWNER_IP = clientIp("composition-editor", 245);
const MOTION_IP = clientIp("composition-editor", 246);
const LEAVE_IP = clientIp("composition-editor", 248);
const NAV_IP = clientIp("composition-editor", 249);

/** The chat on stream at the top left of the horizontal grid, and no other layer on the grid. */
const CHAT_ON: LayersPatch = { chat: { enabled: true }, cells: { horizontal: { chat: CHAT_CELL } } };
const chatOn: string = layersSql(CHAT_ON);

test.beforeEach(async () => {
  await runSql("composition-editor-reset", [resetLayers]);
});

test.afterAll(async () => {
  await runSql("composition-editor-cleanup", [defaultLayers]);
});

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
  await page.goto("/tools");
  const editor = page.locator("[data-composition-editor]");
  await expect(editor).toBeVisible();
  const frame = editor.getByRole("region", { name: "Composition preview" });
  await expect(frame).toHaveAttribute("data-scaled", "true");
  await expect(frame).toHaveAttribute("data-orientation", "horizontal");
  // The grid button sits in an application region, so screen readers pass the keys to it in browse mode. The region
  // names the grid; the button names the cursor cell, so a screen reader does not read the grid name twice.
  const app = editor.getByRole("application", { name: "Layout grid, 32 columns by 18 rows" });
  await expect(app.getByRole("button")).toHaveCount(1);
  const grid = gridButton(editor, "Layout grid, 32 columns by 18 rows");
  await expect(grid).toBeVisible();
  await expect(grid).toHaveAccessibleName("Column 1, row 1: empty.");
  // The button covers the frame. It stays transparent under the pointer, so the grid and the layers stay in view.
  await grid.hover();
  await expect(grid).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  // No layer is on the grid: the palette offers each layer, and no layer is selected.
  const palette = editor.getByRole("group", { name: "Layers · one of each" });
  await expect(frame.locator("[data-grid-box]")).toHaveCount(0);
  await expect(frame.locator(".ov-layer")).toHaveCount(0);
  await expect(palette.getByRole("button")).toHaveText([
    "+ Chat",
    "+ Characters",
    "+ Poll",
    "+ Topic",
    "+ Up next",
    "+ Message banner",
    "+ Community card",
    "+ Support banner",
    "+ Camera frame",
  ]);
  const panel = settings(editor);
  await expect(panel).toHaveAttribute("data-comp-props", "");
  await expect(panel).toContainText("Select a layer on the grid to change it.");
  expect((await storedLayers(page)).chat.enabled).toBe(false);
  await expect(editor.locator("[data-comp-frame-size]")).toHaveText(
    "Set the OBS browser source to 1920 × 1080 for this orientation.",
  );
  await expect(chip(editor, "chat")).toHaveAccessibleDescription(PALETTE_HINT);

  // Keep the whole preview clear of the sticky header and footer.
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  const status = editor.locator("[data-grid-status]");
  // A click on a chip adds its layer at the first free place, at its minimum size, turns it on and selects it.
  await placeLayer(page, editor, "chat");
  await expect(status).toHaveText("Chat placed at column 1, row 1, 6 × 4 cells.");
  await expect(frame.locator('[data-grid-box="chat"]')).toContainText("Chat · 360 × 240");
  await expect(frame.locator('[data-grid-box="chat"]')).toHaveAttribute("data-selected", "true");
  await expect(frame.locator('[data-grid-box="chat"]')).not.toHaveAttribute("data-off");
  await expect(grid).toHaveAccessibleName("Column 1, row 1: Chat.");
  // The chip says that the layer is on the grid, and the grid has the focus for the next keys.
  await expect(chip(editor, "chat")).toHaveText("ChatPlaced");
  await expect(chip(editor, "chat")).toHaveAttribute("aria-pressed", "true");
  await expect(grid).toBeFocused();
  await expect(panel).toHaveAttribute("data-comp-props", "chat");
  await expect(panel.getByRole("checkbox", { name: "Show on stream" })).toBeChecked();
  expect(await storedLayers(page)).toMatchObject({
    chat: { enabled: true },
    cells: { horizontal: { chat: { c: 0, r: 0, w: 6, h: 4 } } },
  });
  // The preview plays sample chat without an activity socket.
  await expect(frame.locator('.ov-layer[data-layer="chat"] .wl-chat')).toBeVisible();
  await expect(editor.locator("[data-comp-sample]")).toHaveText("The preview shows sample messages, not your chat.");
  // Alt + arrow moves the bottom-right corner of the selected layer one cell. It saves after a short pause.
  let save = saved(page);
  const steps = (key: string, count: number): string[] => Array.from({ length: count }, (): string => key);
  for (const key of [...steps("Alt+ArrowRight", 5), ...steps("Alt+ArrowDown", 10)]) await page.keyboard.press(key);
  await save;
  await expect(status).toHaveText("Chat resized to 11 × 14 cells at column 1, row 1.");

  // The characters go to the first free place: beside the chat.
  await placeLayer(page, editor, "characters");
  await expect(status).toHaveText("Characters placed at column 12, row 1, 12 × 4 cells.");
  await expect(frame.locator('[data-grid-box="characters"]')).toHaveText("Characters · 720 × 240");
  await expect(frame.locator('.ov-layer[data-layer="characters"] canvas.characters-layer')).toBeVisible();
  await expect(frame.locator('[data-grid-box="characters"] [data-grid-handle]')).toHaveCount(8);
  await expect(frame.locator('[data-grid-box="chat"] [data-grid-handle]')).toHaveCount(0);

  // Drag a placed layer to move it. The characters go to the bottom rows: the grid keeps them inside.
  let at = await gridCells(grid, 32, 18);
  save = saved(page);
  await dragCells(page, at(13, 1), at(13, 17));
  await save;
  await expect(status).toHaveText("Characters moved to column 12, row 15, 12 × 4 cells.");
  // The chat, grabbed at its cell (5, 7), moves 20 columns right.
  save = saved(page);
  await dragCells(page, at(5, 7), at(25, 7));
  await save;
  await expect(status).toHaveText("Chat moved to column 21, row 1, 11 × 14 cells.");
  expect((await storedLayers(page)).cells.horizontal.chat).toEqual({ c: 20, r: 0, w: 11, h: 14 });

  // A move onto the characters shows red and is not kept.
  await page.mouse.move(at(25, 7).x, at(25, 7).y);
  await page.mouse.down();
  await page.mouse.move(at(17, 13).x, at(17, 13).y, { steps: 4 });
  await expect(frame.locator("[data-grid-preview]")).toHaveAttribute("data-invalid", "true");
  await page.mouse.up();
  await expect(status).toHaveText("Not moved. It touches Characters.");
  await expect(status).toHaveAttribute("data-bad", "true");
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  expect((await storedLayers(page)).cells.horizontal.chat).toEqual({ c: 20, r: 0, w: 11, h: 14 });

  // A content layer comes on the grid in the same way, with its real content.
  await placeLayer(page, editor, "poll");
  await expect(status).toHaveText("Poll placed at column 1, row 1, 8 × 4 cells.");
  await expect(frame.locator('[data-grid-box="poll"]')).toContainText("Poll · 480 × 240");
  await expect(frame.locator('[data-grid-box="poll"]')).toHaveAttribute("data-selected", "true");
  await expect(frame.locator('[data-grid-box="poll"] [data-grid-handle]')).toHaveCount(8);
  await expect(frame.locator('[data-grid-box="characters"] [data-grid-handle]')).toHaveCount(0);
  await expect(frame.locator('.ov-layer[data-layer="poll"] [data-overlay-mash]')).toBeVisible();
  await expect(grid).toBeFocused();
  expect((await storedLayers(page)).cells.horizontal.poll).toEqual({ c: 0, r: 0, w: 8, h: 4 });

  // Keyboard: after a new page load no layer is selected and the cursor starts at the first cell.
  await page.reload();
  await expect(frame.locator("[data-grid-box][data-selected]")).toHaveCount(0);
  await expect(panel).toHaveAttribute("data-comp-props", "");
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  await grid.focus();
  await expect(frame.locator("[data-grid-cursor]")).toBeVisible();
  // Space picks up the poll at the cursor and selects it, an arrow carries it, Space puts it down.
  await page.keyboard.press("Space");
  await expect(status).toHaveText("Moving Poll. Move the cursor, then press Space or Enter.");
  await expect(panel).toHaveAttribute("data-comp-props", "poll");
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveText("Column 1, row 2: Poll.");
  save = saved(page);
  await page.keyboard.press("Space");
  await save;
  await expect(status).toHaveText("Poll moved to column 1, row 2, 8 × 4 cells.");
  // Escape cancels a pick.
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(status).toHaveText("Cancelled.");
  // A press on an empty cell clears the selection. An empty cell has nothing to pick up.
  at = await gridCells(grid, 32, 18);
  await page.mouse.click(at(17, 11).x, at(17, 11).y);
  await expect(frame.locator("[data-grid-box][data-selected]")).toHaveCount(0);
  await expect(panel).toContainText("No layer selected");
  await page.keyboard.press("Space");
  await expect(status).toHaveText("Column 18, row 12: empty.");
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  // Without a selection, the keys for the selected layer say so.
  await page.keyboard.press("Shift+ArrowRight");
  await expect(status).toHaveText("No layer is selected. Select a layer first.");
  await expect(status).toHaveAttribute("data-bad", "true");
  // A press on a placed layer selects it.
  await page.mouse.click(at(25, 7).x, at(25, 7).y);
  await expect(status).toHaveText("Chat selected.");
  await expect(frame.locator('[data-grid-box="chat"]')).toHaveAttribute("data-selected", "true");
  await expect(frame.locator('[data-grid-box="poll"]')).not.toHaveAttribute("data-selected");
  await expect(panel).toHaveAttribute("data-comp-props", "chat");
  // Shift + arrow moves the selected layer one cell; it saves after a short pause.
  save = saved(page);
  await page.keyboard.press("Shift+ArrowRight");
  await save;
  await expect(status).toHaveText("Chat moved to column 22, row 1, 11 × 14 cells.");
  // The chat is at the right edge of the grid: one more step keeps it there.
  await page.keyboard.press("Shift+ArrowRight");
  await expect(status).toHaveText("Chat moved to column 22, row 1, 11 × 14 cells.");
  expect((await storedLayers(page)).cells.horizontal).toMatchObject({
    chat: { c: 21, r: 0, w: 11, h: 14 },
    poll: { c: 0, r: 1, w: 8, h: 4 },
  });

  // The chip of a placed layer selects it. "Remove from grid" takes it off, and the chip offers it again.
  await chip(editor, "poll").click();
  await expect(panel).toHaveAttribute("data-comp-props", "poll");
  await expect(chip(editor, "poll")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(editor, "chat")).toHaveAttribute("aria-pressed", "false");
  save = saved(page);
  await panel.getByRole("button", { name: "Remove from grid" }).click();
  await save;
  await expect(frame.locator('[data-grid-box="poll"]')).toHaveCount(0);
  await expect(chip(editor, "poll")).toHaveText("+ Poll");
  await expect(chip(editor, "poll")).toBeFocused();

  // The vertical orientation has its own layout and frame. The horizontal layout stays.
  save = saved(page);
  await editor.getByRole("button", { name: "Vertical 18 × 32" }).click();
  await save;
  await expect(frame).toHaveAttribute("data-orientation", "vertical");
  const tall = gridButton(editor, "Layout grid, 18 columns by 32 rows");
  await expect(tall).toBeVisible();
  await expect(frame.locator("[data-grid-box]")).toHaveCount(0);
  await expect(chip(editor, "chat")).toHaveText("+ Chat");
  await expect(editor.locator("[data-comp-frame-size]")).toHaveText(
    "Set the OBS browser source to 1080 × 1920 for this orientation.",
  );
  await placeLayer(page, editor, "chat");
  await expect(frame.locator('[data-grid-box="chat"]')).toContainText("Chat · 360 × 240");
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  at = await gridCells(tall, 18, 32);
  save = saved(page);
  await dragCells(page, at(3, 1), at(9, 19));
  await save;
  expect((await storedLayers(page)).cells.vertical.chat).toEqual({ c: 6, r: 18, w: 6, h: 4 });

  save = saved(page);
  await panel.getByRole("checkbox", { name: "Hide chat commands (!jump)" }).uncheck();
  await save;
  await expect(editor.getByRole("status")).toHaveText("Layout saved.");

  await page.reload();
  await expect(frame).toHaveAttribute("data-orientation", "vertical");
  await chip(editor, "chat").click();
  await expect(panel.getByRole("checkbox", { name: "Show on stream" })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: "Hide chat commands (!jump)" })).not.toBeChecked();
  save = saved(page);
  await editor.getByRole("button", { name: "Horizontal 32 × 18" }).click();
  await save;
  const layers: OverlayLayers = await storedLayers(page);
  expect(layers.orientation).toBe("horizontal");
  expect(layers.cells.horizontal).toEqual({
    ...emptyCells(),
    chat: { c: 21, r: 0, w: 11, h: 14 },
    characters: { c: 11, r: 14, w: 12, h: 4 },
  });
  expect(layers.cells.vertical).toEqual({ ...emptyCells(), chat: { c: 6, r: 18, w: 6, h: 4 } });
  await close(owner);
});

test("a new orientation ends a drag and keeps the keyboard cursor inside its grid", async ({ browser }) => {
  await runSql("composition-editor-orientation", [chatOn]);
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tools");
  const editor = page.locator("[data-composition-editor]");
  const frame = editor.getByRole("region", { name: "Composition preview" });
  const status = editor.locator("[data-grid-status]");
  await expect(editor.locator("[data-comp-orientation-note]")).toHaveText(
    "OBS switches to this orientation at once. Each orientation keeps its own layout.",
  );
  await expect(editor.getByRole("button", { name: "Vertical 18 × 32" })).toHaveAccessibleDescription(
    "OBS switches to this orientation at once. Each orientation keeps its own layout.",
  );
  const bodies: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/overlay")
      bodies.push(request.postDataJSON());
  });
  // The poll goes to the first free place, beside the chat, and the grid takes the focus with the cursor there.
  await placeLayer(page, editor, "poll");
  await expect(status).toHaveText("Poll placed at column 11, row 1, 8 × 4 cells.");
  await expect(gridButton(editor, "Layout grid, 32 columns by 18 rows")).toBeFocused();
  // Space picks up the poll, and the cursor carries it to the last column.
  await page.keyboard.press("Space");
  await expect(status).toHaveText("Moving Poll. Move the cursor, then press Space or Enter.");
  for (let step = 0; step < 21; step++) await page.keyboard.press("ArrowRight");
  await expect(status).toHaveText("Column 32, row 1: empty.");
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(1);
  // Leaving the grid ends the move.
  const save = saved(page);
  await editor.getByRole("button", { name: "Vertical 18 × 32" }).click();
  await save;
  await expect(status).toHaveText("Cancelled.");
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  // The cursor is in the last column of the 18 columns now: the first key, Space, finds an empty cell there.
  const tall = gridButton(editor, "Layout grid, 18 columns by 32 rows");
  await tall.focus();
  await page.keyboard.press("Space");
  await expect(status).toHaveText("Column 18, row 1: empty.");
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  // The vertical layout has its own palette: the poll is not on this grid.
  await placeLayer(page, editor, "poll");
  await expect(status).toHaveText("Poll placed at column 1, row 1, 8 × 4 cells.");
  expect(withoutWrite(bodies)).toEqual([
    { action: "layers", cells: { horizontal: { poll: { c: 10, r: 0, w: 8, h: 4 } } } },
    { action: "layers", orientation: "vertical" },
    { action: "layers", cells: { vertical: { poll: { c: 0, r: 0, w: 8, h: 4 } } } },
  ]);
  expect((await storedLayers(page)).cells.vertical.poll).toEqual({ c: 0, r: 0, w: 8, h: 4 });
  // A click without a pointer (a screen reader's activation) acts as Space: it picks up the layer at the cursor.
  await expect(tall).toBeFocused();
  await tall.dispatchEvent("click");
  await expect(status).toHaveText("Moving Poll. Move the cursor, then press Space or Enter.");
  await page.keyboard.press("Escape");
  await expect(status).toHaveText("Cancelled.");
  // An orientation change from elsewhere (another tab, here a request) ends an open move without a blur.
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveText("Column 1, row 2: Poll.");
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
  const wide = gridButton(editor, "Layout grid, 32 columns by 18 rows");
  await expect(wide).toBeFocused();
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  // Space starts a new move at the cursor, so no move from the old grid was still open.
  await page.keyboard.press("Space");
  await expect(status).toHaveText(/^Moving Chat\./);
  await page.keyboard.press("Escape");
  await close(owner);
});

test("on a 390 × 844 phone the whole vertical frame fits between the header and the footer bar", async ({
  browser,
}) => {
  await runSql("composition-editor-vertical", [layersSql({ orientation: "vertical" })]);
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tools");
  const frame = page.locator(".ov-comp-frame");
  await expect(frame).toHaveAttribute("data-orientation", "vertical");
  // The phone has no dock over the page now: only the header and the footer bar take screen height.
  await expect(page.locator(".ov-take-dock")).toHaveCount(0);
  const space = await page.evaluate(() => {
    const bottom = (selector: string): number => document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0;
    const top = (selector: string): number => document.querySelector(selector)?.getBoundingClientRect().top ?? 0;
    return top("body > .site-footer") - bottom("header");
  });
  const box = await frame.boundingBox();
  expect(space).toBeGreaterThan(300);
  expect(box?.height).toBeGreaterThan(300);
  expect(box?.height).toBeLessThanOrEqual(space);
  await close(owner);
});

test("one test button starts and stops the test from the toolbar and shows the time left", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.goto("/tools");
  const editor = page.locator("[data-composition-editor]");
  const toggle = editor.locator("[data-test-toggle]");
  const status = editor.locator("[data-test-status]");
  const news = editor.locator("[data-test-news]");
  // One button for the chat and the characters: the old two test buttons are gone.
  await expect(editor.getByRole("button", { name: /test/i })).toHaveCount(1);
  const bodies: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/overlay")
      bodies.push(request.postDataJSON());
  });
  // The test needs the chat or the characters on stream. The button stays focusable and ignores a press until then.
  await expect(toggle).toHaveText("Start test");
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await expect(status).toHaveText("Put Chat or Characters on stream to start the test.");
  // Force: Playwright waits for an aria-disabled button to become enabled.
  await toggle.click({ force: true });
  // The server checks the saved layers, so the test stays unavailable until the layer save lands.
  let releaseLayer: (() => void) | undefined;
  await page.route("**/api/overlay", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise<void>((resolve) => {
      releaseLayer = resolve;
    });
    return route.fallback();
  });
  let save = saved(page);
  await chip(editor, "chat").click();
  await expect.poll(() => releaseLayer !== undefined).toBe(true);
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await page.unroute("**/api/overlay");
  releaseLayer?.();
  await save;
  expect(withoutWrite(bodies)).toEqual([
    { action: "layers", chat: { enabled: true }, cells: { horizontal: { chat: { c: 0, r: 0, w: 6, h: 4 } } } },
  ]);
  await expect(toggle).toHaveAttribute("aria-disabled", "false");
  await expect(toggle).toHaveAccessibleDescription(
    "Shows sample chat for 60 seconds and sample viewers as characters for 5 minutes in OBS. Nothing goes to your channels. Viewers see a TEST badge.",
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
  await expect(toggle).toHaveText("Stop test");
  await expect(toggle).toBeFocused();
  await expect(news).toHaveText("Test started. OBS shows sample data.");
  await expect(status).toHaveText(/^The test runs in OBS\. (60|59|58) s left\.$/);
  save = saved(page);
  await page.keyboard.press("Enter");
  await expect(toggle).toBeFocused();
  await save;
  await expect(toggle).toHaveText("Start test");
  await expect(toggle).toBeFocused();
  await expect(news).toHaveText("Test stopped.");
  // Taking the chat off stream ends a running test: the server clears the end time.
  save = saved(page);
  await page.keyboard.press("Enter");
  await save;
  await expect(toggle).toHaveText("Stop test");
  save = saved(page);
  await settings(editor).getByRole("checkbox", { name: "Show on stream" }).uncheck();
  await save;
  await expect(toggle).toHaveText("Start test");
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await expect(news).toHaveText("Test ended.");
  expect((await storedLayers(page)).chat.enabled).toBe(false);
  // Only the chat was on stream, so the button sent only the chat test.
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
  await page.goto("/tools");
  const editor = page.locator("[data-composition-editor]");
  await expect(chip(editor, "chat")).toHaveText("+ Chat");
  await page.route("**/api/overlay", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 429,
          headers: { "Retry-After": "60" },
          json: { error: "Too many requests. Wait one minute and try again." },
        })
      : route.fallback(),
  );
  // The layer shows on the grid at once and leaves it as soon as the save fails.
  await chip(editor, "chat").click();
  await expect(editor.getByRole("alert")).toContainText("Too many requests");
  await expect(editor.locator('[data-grid-box="chat"]')).toHaveCount(0);
  await expect(chip(editor, "chat")).toHaveText("+ Chat");
  await expect(settings(editor)).toContainText("No layer selected");
  await close(owner);
});

test("a save sends only the changed fields, and a failure rolls back only its own fields", async ({ browser }) => {
  // The chat is on the grid and off stream.
  await runSql("composition-editor-fields", [layersSql({ cells: { horizontal: { chat: CHAT_CELL } } })]);
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.goto("/tools");
  const editor = page.locator("[data-composition-editor]");
  await expect(editor.locator('[data-grid-box="chat"]')).toHaveAttribute("data-off", "true");
  await chip(editor, "chat").click();
  const panel = settings(editor);
  const show = panel.getByRole("checkbox", { name: "Show on stream" });
  const hide = panel.getByRole("checkbox", { name: "Hide chat commands (!jump)" });
  await expect(show).not.toBeChecked();
  await expect(hide).toBeChecked();
  // The chat source note links to the channel cards in the Channels section.
  const connect = panel.getByRole("link", { name: "Connect channels" });
  await expect(connect).toHaveAttribute("href", "/tools?view=channels#channels-title");
  await expect(connect).toHaveClass("text-link");
  await expect(panel.locator("[data-comp-chat-source]")).toHaveText(
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

/** The background and the text of the first chat card in the preview: the opacity of each and the text outline. */
function cardLook(page: Page): Promise<{ background: number; text: number; outline: string }> {
  return page
    .locator(".ov-comp-frame [data-overlay-chat] .wl-card")
    .first()
    .evaluate((card: Element) => {
      const line: Element = card.querySelector(".wl-line") ?? card;
      return {
        background: Number(getComputedStyle(card, "::after").opacity),
        text: Number(getComputedStyle(line).opacity) * Number(getComputedStyle(card).opacity),
        outline: getComputedStyle(line).textShadow,
      };
    });
}

test("the message background slider changes the chat cards in the preview and the value persists", async ({
  browser,
}) => {
  await runSql("composition-editor-background", [chatOn]);
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.goto("/tools");
  const editor = page.locator("[data-composition-editor]");
  // The slider is in the settings of the chat layer.
  await chip(editor, "chat").click();
  const range = settings(editor).locator("[data-props-background]");
  const slider = range.getByRole("slider", { name: "Message background" });
  await expect(slider).toHaveValue("100");
  await expect(range.locator("[data-props-background-value]")).toHaveText("100%");
  await expect.poll(() => cardLook(page)).toEqual({ background: 1, text: 1, outline: "none" });
  // Each key press is one step of 5. The preview follows at once and the save waits for a pause.
  const bodies: unknown[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "POST" && new URL(sent.url()).pathname === "/api/overlay") bodies.push(sent.postDataJSON());
  });
  const first = saved(page);
  await slider.focus();
  for (let step = 0; step < 8; step += 1) await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveValue("60");
  await expect(slider).toHaveAttribute("aria-valuetext", "60%");
  await expect(range.locator("[data-props-background-value]")).toHaveText("60%");
  await expect.poll(() => cardLook(page)).toEqual({ background: 0.6, text: 1, outline: "none" });
  await first;
  expect(withoutWrite(bodies)).toEqual([{ action: "layers", chat: { backgroundOpacity: 60 } }]);
  // At 0 the card background is gone. The text stays opaque and gets an outline.
  const second = saved(page);
  await page.keyboard.press("Home");
  await expect(range.locator("[data-props-background-value]")).toHaveText("0%");
  await expect.poll(async () => (await cardLook(page)).background).toBe(0);
  const bare = await cardLook(page);
  expect(bare.text).toBe(1);
  expect(bare.outline).not.toBe("none");
  await second;
  await expect.poll(async () => (await storedLayers(page)).chat.backgroundOpacity).toBe(0);
  await page.reload();
  await chip(editor, "chat").click();
  await expect(slider).toHaveValue("0");
  await expect.poll(async () => (await cardLook(page)).background).toBe(0);
  await close(owner);
});

test("a new overlay link lists one URL per layer", async ({ browser }) => {
  // The chat and the characters have a cell. They can be off stream: a layer URL shows the size of the cell.
  await runSql("composition-editor-link", [
    layersSql({ cells: { horizontal: { chat: CHAT_CELL, characters: CHARACTERS_CELL } } }),
  ]);
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.goto("/tools");
  await expect(page.locator("[data-ov-layer-urls]")).toHaveCount(0);
  await page.getByRole("button", { name: /^(Create overlay link|Regenerate link)$/ }).click();
  // An existing link asks for confirmation first.
  const confirm = page.getByRole("dialog", { name: "Regenerate the overlay link?" });
  await expect(confirm.or(page.locator("[data-ov-url]"))).toBeVisible();
  if (await confirm.isVisible()) await confirm.getByRole("button", { name: "Regenerate link" }).click();
  const url: string = await page.locator("[data-ov-url]").inputValue();
  expect(url).toMatch(/\/@feature_host\/overlay\?key=/);
  for (const layer of ["chat", "characters", "content"])
    await expect(page.locator(`[data-ov-layer-url="${layer}"]`)).toHaveValue(`${url}&layer=${layer}`);
  // Each layer URL names the source size: the cell of the layer, and the whole frame for the content layers.
  const { w, h } = cellPixels(CHAT_CELL);
  await expect(page.locator('[data-ov-layer-size="chat"]')).toHaveText(`Source size: ${w} × ${h}`);
  await expect(page.locator('[data-ov-layer-url="chat"]')).toHaveAccessibleDescription(`Source size: ${w} × ${h}`);
  const characters = cellPixels(CHARACTERS_CELL);
  await expect(page.locator('[data-ov-layer-size="characters"]')).toHaveText(
    `Source size: ${characters.w} × ${characters.h}`,
  );
  await expect(page.locator('[data-ov-layer-size="content"]')).toHaveText("Source size: 1920 × 1080");
  // A layer that is off the grid has no cell and names no size.
  const removed = saved(page);
  await page.locator('[data-comp-layer="chat"]').click();
  await page.getByRole("button", { name: "Remove from grid" }).click();
  await removed;
  await expect(page.locator('[data-ov-layer-size="chat"]')).toHaveCount(0);
  await expect(page.locator('[data-ov-layer-url="chat"]')).toHaveValue(`${url}&layer=chat`);
  await page.reload();
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
    // The sample emote comes from the Twitch CDN. Serve it here: without network its text fallback shows at an
    // unknown time and would change a row between the two reads.
    await page.route("https://static-cdn.jtvnw.net/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      }),
    );
    await page.goto("/tools");
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

test("closing the editor sends an edit that waits for the idle save", async ({ browser }) => {
  await runSql("composition-editor-leave", [chatOn]);
  const owner = await signedIn(browser, "featureowner", LEAVE_IP);
  const page = await newPage(owner);
  await page.clock.install();
  await page.goto("/tools");
  const editor = page.locator("[data-composition-editor]");
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

/**
 * Moves the chat layer one cell right with the keyboard: a change that waits for the idle save. Space picks up the
 * chat at the cursor cell, which selects it, and Escape puts it back.
 */
async function nudgeRight(page: Page): Promise<void> {
  await page.locator("[data-comp-grid]").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+ArrowRight");
}

/** Picks up the chat at the cursor cell, carries it one cell right and puts it down: a change that saves at once. */
async function carryRight(page: Page): Promise<void> {
  await page.locator("[data-comp-grid]").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
}

async function storedChatColumn(page: Page): Promise<number | undefined> {
  return (await storedLayers(page)).cells.horizontal.chat?.c;
}

test("leaving the editor by an in-app link sends the edit that waits for the idle save", async ({ browser }) => {
  await runSql("composition-editor-nav", [chatOn]);
  const owner = await signedIn(browser, "featureowner", NAV_IP);
  const page = await newPage(owner);
  await page.clock.install();
  await page.goto("/tools");
  const editor = page.locator("[data-composition-editor]");
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
  await page.goto("/tools");
  const editor = page.locator("[data-composition-editor]");
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
  await expect(chatBox).toHaveCSS("left", "120px");
  await leaveInApp(page);
  // The newer edit waits for the save in flight.
  expect(bodies).toHaveLength(1);
  gate.release?.();
  await expect.poll(() => bodies.length).toBe(2);
  const chat = (c: number) => ({ cells: { horizontal: { chat: { ...CHAT_CELL, c } } } });
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
    await page.goto("/tools");
    const editor = page.locator("[data-composition-editor]");
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
    const back = page.locator("[data-composition-editor]");
    await expect(back.locator("[data-comp-grid]")).toBeVisible();
    if (stale) await expect(back.getByRole("alert")).toHaveCount(0);
    else {
      const alert = back.getByRole("alert");
      await expect(alert).toHaveText(
        "Your last layout change was not saved. Make the change again. Reason: Too many requests. Wait a minute and try again.",
      );
      // The editor brings the error into view: it sits below the layer controls.
      await expect(alert).toBeInViewport();
    }
    await close(owner);
  });
}
