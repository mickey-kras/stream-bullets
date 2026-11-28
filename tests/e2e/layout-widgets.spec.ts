import { newPage, close, test, expect, type Browser, type BrowserContext, type Page } from "./coverage";
import { runSql } from "./fixtures";
import { signedIn } from "./live-helpers";
import { clientIp } from "./client-ips";
import {
  CHARACTERS_CELL,
  CHAT_CELL,
  chip,
  defaultLayers,
  gridButton,
  gridCells,
  gridLines,
  resetLayers,
  saved,
  settings,
  storedLayers,
} from "./grid-helpers";
import { emptyCells, type CellsPatch } from "../../app/lib/overlay-layers";
import type { Locator } from "@playwright/test";

// The layout grid of Overlay control: resize handles on the selected layer, and the palette of layers.
const RESIZE_IP = clientIp("layout-widgets", 251);
const PALETTE_IP = clientIp("layout-widgets", 252);
const TOUCH_IP = clientIp("layout-widgets", 253);
const REMOVE_IP = clientIp("layout-widgets", 254);

test.beforeEach(async () => {
  await runSql("layout-widgets-reset", [resetLayers]);
});

test.afterAll(async () => {
  await runSql("layout-widgets-cleanup", [defaultLayers]);
});

interface Editor {
  owner: BrowserContext;
  page: Page;
  editor: Locator;
  frame: Locator;
  grid: Locator;
  status: Locator;
}

/**
 * Overlay control of the feature owner, with these horizontal cells saved first. The chat is on stream: at the top
 * left, unless `cells` gives it another cell. The characters are on stream along the bottom only with `characters`.
 */
async function openEditor(
  browser: Browser,
  ip: number,
  cells: CellsPatch,
  viewport: { width: number; height: number },
  characters: boolean = false,
): Promise<Editor> {
  const owner = await signedIn(browser, "featureowner", ip);
  const placed = await owner.request.post("/api/overlay", {
    data: {
      action: "layers",
      chat: { enabled: true },
      characters: { enabled: characters },
      cells: { horizontal: { chat: CHAT_CELL, ...(characters ? { characters: CHARACTERS_CELL } : {}), ...cells } },
    },
  });
  expect(placed.ok()).toBe(true);
  const page = await newPage(owner);
  await page.setViewportSize(viewport);
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  const frame = editor.getByRole("region", { name: "Composition preview" });
  await expect(frame).toHaveAttribute("data-scaled", "true");
  const grid = gridButton(editor, "Layout grid, 32 columns by 18 rows");
  await expect(grid).toBeVisible();
  return { owner, page, editor, frame, grid, status: editor.locator("[data-grid-status]") };
}

/**
 * The chips of an empty grid, in the sequence of the groups of the palette: the picture, the recognition, then the
 * content.
 */
const ALL_CHIPS: readonly string[] = [
  "+ Chat",
  "+ Characters",
  "+ Camera frame",
  "+ Alerts",
  "+ Goal",
  "+ Poll",
  "+ Topic",
  "+ Up next",
  "+ Message banner",
  "+ Community card",
  "+ Support banner",
];

test("the owner resizes a placed layer by its handles and by the keyboard", async ({ browser }) => {
  // The chat is in columns 21 to 30. The poll is at the top-left corner, at its minimum size.
  const { owner, page, editor, frame, grid, status } = await openEditor(
    browser,
    RESIZE_IP,
    { chat: { c: 20, r: 0, w: 10, h: 14 }, poll: { c: 0, r: 0, w: 8, h: 4 } },
    { width: 1440, height: 900 },
  );
  // No layer is selected at first, so no layer shows handles. A press on a placed layer selects it. Nothing is saved.
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  await expect(frame.locator("[data-grid-handle]")).toHaveCount(0);
  const first = await gridCells(grid, 32, 18);
  await page.mouse.click(first(25, 7).x, first(25, 7).y);
  await expect(status).toHaveText("Chat selected.");
  await expect(frame.locator('[data-grid-box="chat"] [data-grid-handle]')).toHaveCount(8);
  await page.mouse.click(first(3, 1).x, first(3, 1).y + 6);
  await expect(status).toHaveText("Poll selected.");
  await expect(frame.locator('[data-grid-box="poll"] [data-grid-handle]')).toHaveCount(8);
  await expect(frame.locator('[data-grid-box="chat"] [data-grid-handle]')).toHaveCount(0);
  // A handle is at least 24 pixels to press, also where it shows smaller.
  const handle = await frame.locator('[data-grid-handle="se"]').boundingBox();
  expect(handle?.width).toBeCloseTo(12, 0);

  // Resize by a handle: the bottom-right corner goes four columns right and two rows down.
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  const at = await gridCells(grid, 32, 18);
  const line = await gridLines(grid, 32, 18);
  // The first line is 2 pixels inside the grid, so measure between two other lines.
  const cellWidth: number = (line(12, 0).x - line(2, 0).x) / 10;
  const pollLayer = frame.locator('.ov-layer[data-layer="poll"]');
  // The mouse cursor shows what a press would do.
  await page.mouse.move(line(8, 4).x, line(8, 4).y);
  await expect(grid).toHaveAttribute("data-hover", "se");
  await expect(grid).toHaveCSS("cursor", "nwse-resize");
  await page.mouse.move(at(3, 1).x, at(3, 1).y + 6);
  await expect(grid).toHaveAttribute("data-hover", "move");
  await page.mouse.move(line(8, 4).x, line(8, 4).y);
  await page.mouse.down();
  await page.mouse.move(line(12, 6).x, line(12, 6).y, { steps: 6 });
  // During the drag the layer, its label and its content follow the new size. Nothing is saved yet.
  await expect(frame.locator("[data-grid-preview]")).not.toHaveAttribute("data-invalid");
  await expect(frame.locator('[data-grid-box="poll"]')).toContainText("Poll · 720 × 360");
  await expect.poll(async () => Math.round(((await pollLayer.boundingBox())?.width ?? 0) / cellWidth)).toBe(12);
  expect((await storedLayers(page)).cells.horizontal.poll).toEqual({ c: 0, r: 0, w: 8, h: 4 });
  let save = saved(page);
  await page.mouse.up();
  await save;
  await expect(status).toHaveText("Poll resized to 12 × 6 cells at column 1, row 1.");
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  expect((await storedLayers(page)).cells.horizontal.poll).toEqual({ c: 0, r: 0, w: 12, h: 6 });

  // A resize stops at the minimum size. The minimum shows only then.
  await page.mouse.move(line(12, 6).x, line(12, 6).y);
  await page.mouse.down();
  await page.mouse.move(line(10, 6).x, line(10, 6).y, { steps: 3 });
  await expect(status).toHaveText("Poll resized to 12 × 6 cells at column 1, row 1.");
  await page.mouse.move(line(2, 2).x, line(2, 2).y, { steps: 6 });
  await expect(status).toHaveText("Poll needs at least 8 × 4 cells.");
  await expect(frame.locator('[data-grid-box="poll"]')).toContainText("Poll · 480 × 240");
  save = saved(page);
  await page.mouse.up();
  await save;
  await expect(status).toHaveText("Poll resized to 8 × 4 cells at column 1, row 1.");
  expect((await storedLayers(page)).cells.horizontal.poll).toEqual({ c: 0, r: 0, w: 8, h: 4 });

  // A resize onto another layer shows red and is not kept, like a move. The chat is in columns 21 to 30.
  await page.mouse.move(line(8, 2).x, line(8, 2).y);
  await expect(grid).toHaveAttribute("data-hover", "e");
  await page.mouse.down();
  await page.mouse.move(line(24, 2).x, line(24, 2).y, { steps: 6 });
  await expect(frame.locator("[data-grid-preview]")).toHaveAttribute("data-invalid", "true");
  await page.mouse.up();
  await expect(status).toHaveText("Not resized. It touches Chat.");
  await expect(status).toHaveAttribute("data-bad", "true");
  await expect(frame.locator('[data-grid-box="poll"]')).toContainText("Poll · 480 × 240");
  expect((await storedLayers(page)).cells.horizontal.poll).toEqual({ c: 0, r: 0, w: 8, h: 4 });
  // A press on a handle without a move changes nothing.
  await page.mouse.move(line(8, 2).x, line(8, 2).y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(status).toHaveText("Poll selected.");

  // Keyboard resize: Alt + arrow moves the bottom-right corner of the selected layer one cell.
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(status).toHaveText("Not resized. Poll needs at least 8 × 4 cells.");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(status).toHaveText("Not resized. Poll needs at least 8 × 4 cells.");
  await expect(page).toHaveURL(/\/tools\?view=overlay$/);
  save = saved(page);
  await page.keyboard.press("Alt+ArrowRight");
  await expect(status).toHaveText("Poll resized to 9 × 4 cells at column 1, row 1.");
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("Alt+ArrowDown");
  await expect(status).toHaveText("Poll resized to 10 × 5 cells at column 1, row 1.");
  // The steps save together after a short pause.
  await save;
  await expect(editor.getByRole("status")).toHaveText("Layout saved.");
  expect((await storedLayers(page)).cells.horizontal.poll).toEqual({ c: 0, r: 0, w: 10, h: 5 });
  // Ten columns are free between the poll and the chat. An eleventh step would touch the chat.
  for (let step = 0; step < 10; step++) await page.keyboard.press("Alt+ArrowRight");
  await expect(status).toHaveText("Poll resized to 20 × 5 cells at column 1, row 1.");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(status).toHaveText("Not resized. It touches Chat.");
  save = saved(page);
  for (let step = 0; step < 10; step++) await page.keyboard.press("Alt+ArrowLeft");
  await expect(status).toHaveText("Poll resized to 10 × 5 cells at column 1, row 1.");
  await save;
  await expect(editor.getByRole("status")).toHaveText("Layout saved.");
  expect((await storedLayers(page)).cells.horizontal.poll).toEqual({ c: 0, r: 0, w: 10, h: 5 });
  await close(owner);
});

test("the owner adds a layer from the palette by click, key and drag, and Remove returns its chip", async ({
  browser,
}) => {
  // The chat is in columns 23 to 32. No other layer is on the grid.
  const { owner, page, editor, frame, grid, status } = await openEditor(
    browser,
    PALETTE_IP,
    { chat: { c: 22, r: 0, w: 10, h: 14 } },
    { width: 1440, height: 900 },
  );
  const palette = editor.locator("[data-comp-palette]");
  const panel = settings(editor);
  const support = chip(editor, "support");
  // The palette has each layer one time. The chat is on the grid, and its chip says so.
  await expect(palette.getByRole("button")).toHaveText(["ChatPlaced", ...ALL_CHIPS.slice(1)]);
  await expect(panel.getByRole("button", { name: "Remove from grid" })).toHaveCount(0);
  // Drag the chip onto the grid: the layer drops at its minimum size around the pointed cell.
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  const at = await gridCells(grid, 32, 18);
  const dragChip = async (from: Locator, to: { x: number; y: number }): Promise<void> => {
    const box = await from.boundingBox();
    if (!box) throw new Error("No chip.");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
  };
  // Over the chat (columns 23 to 32) the place is red, and the drop is not kept.
  await dragChip(support, at(27, 7));
  await expect(support).toHaveAttribute("data-dragging", "true");
  await expect(frame.locator("[data-grid-preview]")).toHaveAttribute("data-invalid", "true");
  await page.mouse.up();
  await expect(status).toHaveText("Not placed. It touches Chat.");
  await expect(support).toBeVisible();
  await expect(support).not.toHaveAttribute("data-dragging");
  expect((await storedLayers(page)).cells.horizontal.support).toBeNull();
  // A drag that ends outside the grid adds nothing.
  await dragChip(support, { x: at(31, 1).x + 60, y: at(1, 17).y });
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  await page.mouse.up();
  await expect(status).toHaveText("Cancelled.");
  await expect(frame.locator('[data-grid-box="support"]')).toHaveCount(0);
  // On free cells the layer drops and is selected, and its chip says that it is on the grid.
  await dragChip(support, at(17, 9));
  await expect(frame.locator("[data-grid-preview]")).not.toHaveAttribute("data-invalid");
  let save = saved(page);
  await page.mouse.up();
  await save;
  await expect(status).toHaveText("Support banner placed at column 14, row 8, 8 × 4 cells.");
  await expect(frame.locator('[data-grid-box="support"]')).toHaveAttribute("data-selected", "true");
  await expect(support).toHaveText("Support bannerPlaced");
  await expect(support).toHaveAttribute("aria-pressed", "true");
  await expect(grid).toBeFocused();
  await expect(panel).toHaveAttribute("data-comp-props", "support");
  expect((await storedLayers(page)).cells.horizontal.support).toEqual({ c: 13, r: 7, w: 8, h: 4 });
  // Each layer can be on the grid one time: the chip of a placed layer does not drag a second one to the grid.
  await dragChip(support, at(5, 13));
  await expect(support).not.toHaveAttribute("data-dragging");
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  await page.mouse.up();
  await expect(frame.locator('[data-grid-box="support"]')).toHaveCount(1);
  expect((await storedLayers(page)).cells.horizontal.support).toEqual({ c: 13, r: 7, w: 8, h: 4 });
  // The chip also works from the keyboard. Remove moves the focus to it, and Enter adds the layer at the first free
  // place.
  save = saved(page);
  await panel.getByRole("button", { name: "Remove from grid" }).click();
  await save;
  await expect(support).toBeFocused();
  await expect(support).toHaveText("+ Support banner");
  save = saved(page);
  await page.keyboard.press("Enter");
  await save;
  await expect(status).toHaveText("Support banner placed at column 1, row 1, 8 × 4 cells.");
  save = saved(page);
  await panel.getByRole("button", { name: "Remove from grid" }).click();
  await save;
  await expect(support).toBeVisible();
  await expect(panel.getByRole("button", { name: "Remove from grid" })).toHaveCount(0);
  expect((await storedLayers(page)).cells.horizontal.support).toBeNull();
  await close(owner);
});

test("the owner takes each layer off the grid by a drag to the palette or by a key, and a chip puts it back", async ({
  browser,
}) => {
  // Three layers are on the grid: the chat at the left, the characters along the bottom, the poll between.
  const { owner, page, editor, frame, grid, status } = await openEditor(
    browser,
    REMOVE_IP,
    { poll: { c: 14, r: 2, w: 14, h: 8 } },
    { width: 1440, height: 1000 },
    true,
  );
  const palette = editor.locator("[data-comp-palette]");
  const drop = palette.locator("[data-comp-palette-drop]");
  const panel = settings(editor);
  await expect(frame.locator("[data-grid-box]")).toHaveCount(3);
  await expect(palette.getByRole("button")).toHaveText([
    "ChatPlaced",
    "CharactersPlaced",
    "+ Camera frame",
    "+ Alerts",
    "+ Goal",
    "PollPlaced",
    ...ALL_CHIPS.slice(6),
  ]);
  await expect(drop).toHaveCount(0);
  const cells = async (): Promise<(c: number, r: number) => { x: number; y: number }> => {
    await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
    return gridCells(grid, 32, 18);
  };
  let at = await cells();
  const paletteCentre = async (): Promise<{ x: number; y: number }> => {
    const box = await palette.boundingBox();
    if (!box) throw new Error("No palette.");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  // A press alone does not show the drop place. A drag does: the palette names what a drop there does.
  await page.mouse.move(at(17, 17).x, at(17, 17).y);
  await page.mouse.down();
  await expect(palette).not.toHaveAttribute("data-drop");
  await page.mouse.move(at(17, 13).x, at(17, 13).y, { steps: 4 });
  await expect(palette).toHaveAttribute("data-drop", "ready");
  await expect(drop).toHaveText("Drop here to remove");
  // The drop place is for the pointer only. A screen reader gets Delete on the grid.
  await expect(drop).toHaveAttribute("aria-hidden", "true");
  // Over the palette the place changes, and the grid shows no new cells for the layer.
  const before = await palette.boundingBox();
  const target = await paletteCentre();
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await expect(palette).toHaveAttribute("data-drop", "over");
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  // The palette keeps its box during the drag, so the grid does not move under the pointer.
  expect(await palette.boundingBox()).toEqual(before);
  let save = saved(page);
  await page.mouse.up();
  await save;
  await expect(status).toHaveText("Characters removed from the grid.");
  await expect(palette).not.toHaveAttribute("data-drop");
  await expect(frame.locator('[data-grid-box="characters"]')).toHaveCount(0);
  await expect(frame.locator('.ov-layer[data-layer="characters"]')).toHaveCount(0);
  await expect(chip(editor, "characters")).toHaveText("+ Characters");
  // The layer has no cell now. Its "Show on stream" setting stays.
  let stored = await storedLayers(page);
  expect(stored.characters.enabled).toBe(true);
  expect(stored.cells.horizontal.characters).toBeNull();
  // OBS does not show a removed layer.
  const obs = await newPage(owner);
  await obs.setViewportSize({ width: 1920, height: 1080 });
  await obs.goto("/@feature_host/overlay");
  await expect(obs.locator('.ov-layer[data-layer="chat"]')).toHaveCount(1);
  await expect(obs.locator('.ov-layer[data-layer="characters"]')).toHaveCount(0);
  await close(obs);

  // A layer that is off the grid takes no place: the poll moves onto the bottom rows.
  at = await cells();
  await page.mouse.move(at(17, 5).x, at(17, 5).y);
  await page.mouse.down();
  await page.mouse.move(at(17, 13).x, at(17, 13).y, { steps: 6 });
  await expect(frame.locator("[data-grid-preview]")).not.toHaveAttribute("data-invalid");
  save = saved(page);
  await page.mouse.up();
  await save;
  await expect(status).toHaveText("Poll moved to column 15, row 11, 14 × 8 cells.");
  stored = await storedLayers(page);
  expect(stored.cells.horizontal.poll).toEqual({ c: 14, r: 10, w: 14, h: 8 });
  expect(stored.cells.horizontal.characters).toBeNull();

  // Keyboard: Delete takes the selected layer off the grid. The grid keeps the focus.
  at = await cells();
  await page.mouse.click(at(3, 3).x, at(3, 3).y);
  await expect(status).toHaveText("Chat selected.");
  await expect(panel).toHaveAttribute("data-comp-props", "chat");
  save = saved(page);
  await page.keyboard.press("Delete");
  await save;
  await expect(status).toHaveText("Chat removed from the grid.");
  await expect(frame.locator('[data-grid-box="chat"]')).toHaveCount(0);
  await expect(grid).toBeFocused();
  await expect(panel).toHaveAttribute("data-comp-props", "");
  stored = await storedLayers(page);
  expect(stored.cells.horizontal.chat).toBeNull();
  expect(stored.chat.enabled).toBe(true);
  // No layer is selected now: a second key says so and saves nothing.
  await page.keyboard.press("Backspace");
  await expect(status).toHaveText("No layer is selected. Select a layer first.");
  await expect(status).toHaveAttribute("data-bad", "true");
  await expect(page).toHaveURL(/\/tools\?view=overlay$/);
  // Backspace during a keyboard move takes the carried layer off the grid.
  for (let step = 0; step < 12; step++) await page.keyboard.press("ArrowDown");
  for (let step = 0; step < 16; step++) await page.keyboard.press("ArrowRight");
  await expect(status).toHaveText("Column 20, row 16: Poll.");
  await page.keyboard.press("Space");
  await expect(status).toHaveText("Moving Poll. Move the cursor, then press Space or Enter.");
  save = saved(page);
  await page.keyboard.press("Backspace");
  await save;
  await expect(status).toHaveText("Poll removed from the grid.");
  await expect(frame.locator("[data-grid-box]")).toHaveCount(0);
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  expect((await storedLayers(page)).cells.horizontal.poll).toBeNull();
  await expect(palette.getByRole("button")).toHaveText([...ALL_CHIPS]);

  // A chip puts a layer back from the keyboard: Enter adds the chat at the first free place.
  await chip(editor, "chat").focus();
  save = saved(page);
  await page.keyboard.press("Enter");
  await save;
  await expect(status).toHaveText("Chat placed at column 1, row 1, 6 × 4 cells.");
  await expect(frame.locator('[data-grid-box="chat"]')).toHaveAttribute("data-selected", "true");
  await expect(grid).toBeFocused();
  await expect(panel.getByRole("checkbox", { name: "Show on stream" })).toBeChecked();
  stored = await storedLayers(page);
  expect(stored.chat.enabled).toBe(true);
  expect(stored.cells.horizontal.chat).toEqual({ c: 0, r: 0, w: 6, h: 4 });
  // A drag of the chip drops the characters at the pointer.
  at = await cells();
  const from = await chip(editor, "characters").boundingBox();
  if (!from) throw new Error("No chip.");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(at(21, 15).x, at(21, 15).y, { steps: 8 });
  // A chip on its way to the grid is not a layer to remove.
  await expect(palette).not.toHaveAttribute("data-drop");
  save = saved(page);
  await page.mouse.up();
  await save;
  await expect(status).toHaveText("Characters placed at column 16, row 14, 12 × 4 cells.");
  await expect(panel).toHaveAttribute("data-comp-props", "characters");
  await expect(panel.getByRole("checkbox", { name: "Show on stream" })).toBeChecked();
  stored = await storedLayers(page);
  expect(stored.characters.enabled).toBe(true);
  expect(stored.cells.horizontal.characters).toEqual({ c: 15, r: 13, w: 12, h: 4 });

  // "Show on stream" hides a layer in the preview and keeps it on the grid, with its chip marked.
  await chip(editor, "chat").click();
  const show = panel.getByRole("checkbox", { name: "Show on stream" });
  save = saved(page);
  await show.uncheck();
  await save;
  await expect(frame.locator('[data-grid-box="chat"]')).toHaveAttribute("data-off", "true");
  await expect(frame.locator('.ov-layer[data-layer="chat"]')).toHaveCount(0);
  await expect(chip(editor, "chat")).toHaveText("ChatPlaced");
  save = saved(page);
  await show.check();
  await save;
  await expect(frame.locator('[data-grid-box="chat"]')).toContainText("Chat · 360 × 240");
  await expect(frame.locator('[data-grid-box="chat"]')).not.toHaveAttribute("data-off");
  await expect(frame.locator('.ov-layer[data-layer="chat"]')).toHaveCount(1);
  // Escape ends a drag to the palette, and the layer stays.
  at = await cells();
  const away = await paletteCentre();
  await page.mouse.move(at(21, 15).x, at(21, 15).y);
  await page.mouse.down();
  await page.mouse.move(away.x, away.y, { steps: 8 });
  await expect(palette).toHaveAttribute("data-drop", "over");
  await page.keyboard.press("Escape");
  await expect(status).toHaveText("Cancelled.");
  await expect(palette).not.toHaveAttribute("data-drop");
  await page.mouse.up();
  await expect(frame.locator('[data-grid-box="characters"]')).toHaveCount(1);
  expect((await storedLayers(page)).cells.horizontal.characters).toEqual({ c: 15, r: 13, w: 12, h: 4 });
  await close(owner);
});

test("on a phone a finger resizes a layer and drags a chip, and the page does not scroll", async ({ browser }) => {
  const { owner, page, editor, frame, grid, status } = await openEditor(
    browser,
    TOUCH_IP,
    {},
    { width: 390, height: 844 },
  );
  const cdp = await owner.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const touch = async (type: "touchStart" | "touchMove" | "touchEnd", at?: { x: number; y: number }): Promise<void> => {
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: at ? [at] : [] });
  };
  /** A finger goes down at `from`, moves to `to` in steps, and stays down. */
  const swipe = async (from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> => {
    await touch("touchStart", from);
    for (let step = 1; step <= 6; step++)
      await touch("touchMove", {
        x: from.x + ((to.x - from.x) * step) / 6,
        y: from.y + ((to.y - from.y) * step) / 6,
      });
  };
  // The grid and the last chips of the palette above it are on the screen together.
  await grid.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  const support = chip(editor, "support");
  await expect(support).toBeInViewport({ ratio: 1 });
  await expect(grid).toBeInViewport({ ratio: 0.98 });
  const scrolled: number = await page.evaluate((): number => window.scrollY);
  const line = await gridLines(grid, 32, 18);
  const at = await gridCells(grid, 32, 18);
  // A cell is about 11 pixels here: smaller than the 28 pixels of a handle.
  expect(line(1, 0).x - line(0, 0).x).toBeLessThan(28);
  // A tap on the chat selects it and shows its handles.
  await touch("touchStart", at(5, 7));
  await touch("touchEnd");
  await expect(status).toHaveText("Chat selected.");
  await expect(frame.locator('[data-grid-box="chat"] [data-grid-handle]')).toHaveCount(8);
  // The right edge of the selected chat (10 x 14 cells) goes four columns right. The layer follows the finger.
  await swipe(line(10, 6), line(14, 6));
  await expect(frame.locator('[data-grid-box="chat"]')).toContainText("Chat · 840 × 840");
  let save = saved(page);
  await touch("touchEnd");
  await save;
  await expect(status).toHaveText("Chat resized to 14 × 14 cells at column 1, row 1.");
  // The middle of the layer still moves it: two columns right.
  save = saved(page);
  await swipe(at(7, 7), at(9, 7));
  await touch("touchEnd");
  await save;
  await expect(status).toHaveText("Chat moved to column 3, row 1, 14 × 14 cells.");
  // A finger carries the chip to the free cells at the right.
  const from = await support.boundingBox();
  if (!from) throw new Error("No chip.");
  await swipe({ x: from.x + from.width / 2, y: from.y + from.height / 2 }, at(25, 3));
  await expect(frame.locator("[data-grid-preview]")).not.toHaveAttribute("data-invalid");
  save = saved(page);
  await touch("touchEnd");
  await save;
  await expect(status).toHaveText("Support banner placed at column 22, row 2, 8 × 4 cells.");
  expect(await page.evaluate((): number => window.scrollY)).toBe(scrolled);
  expect((await storedLayers(page)).cells.horizontal).toEqual({
    ...emptyCells(),
    chat: { c: 2, r: 0, w: 14, h: 14 },
    support: { c: 21, r: 1, w: 8, h: 4 },
  });
  await close(owner);
});
