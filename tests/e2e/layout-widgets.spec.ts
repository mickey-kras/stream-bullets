import { newPage, close, test, expect, type Browser, type BrowserContext, type Page } from "./coverage";
import { runSql } from "./fixtures";
import { signedIn } from "./live-helpers";
import { clientIp } from "./client-ips";
import {
  PALETTE_EMPTY,
  gridButton,
  gridCells,
  gridLines,
  paletteChip,
  resetLayers,
  saved,
  storedLayers,
} from "./grid-helpers";
import { DEFAULT_LAYERS, type CellsPatch } from "../../app/lib/overlay-layers";
import type { Locator } from "@playwright/test";

// The layout grid of Overlay control: resize handles on the selected layer, and the palette of layers to add.
const RESIZE_IP = clientIp("layout-widgets", 251);
const PALETTE_IP = clientIp("layout-widgets", 252);
const TOUCH_IP = clientIp("layout-widgets", 253);
const REMOVE_IP = clientIp("layout-widgets", 254);

test.beforeEach(async () => {
  await runSql("layout-widgets-reset", [resetLayers]);
});

test.afterAll(async () => {
  await runSql("layout-widgets-cleanup", [resetLayers]);
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
 * Overlay control of the feature owner, with these horizontal cells saved first. The chat is on, so it is on the
 * grid. The characters are on the grid only with `characters`.
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
      ...(Object.keys(cells).length > 0 ? { cells: { horizontal: cells } } : {}),
    },
  });
  expect(placed.ok()).toBe(true);
  const page = await newPage(owner);
  await page.setViewportSize(viewport);
  await page.goto("/overlay-control");
  const editor = page.locator("[data-composition-editor]");
  const frame = editor.getByRole("region", { name: "Composition preview" });
  await expect(frame).toHaveAttribute("data-scaled", "true");
  const grid = gridButton(editor, "Layout grid, 16 columns by 9 rows");
  await expect(grid).toBeVisible();
  return { owner, page, editor, frame, grid, status: editor.locator("[data-grid-status]") };
}

test("the owner resizes a placed layer by its handles and by the keyboard", async ({ browser }) => {
  // The chat is in columns 11 to 15. The content is at the top-left corner, at its minimum size.
  const { owner, page, editor, frame, grid, status } = await openEditor(
    browser,
    RESIZE_IP,
    { chat: { c: 10, r: 0, w: 5, h: 7 }, content: { c: 0, r: 0, w: 4, h: 2 } },
    { width: 1440, height: 900 },
  );
  // A press on a placed layer selects it: the handles go from the chat to the content. Nothing is saved.
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  await expect(frame.locator('[data-grid-box="chat"] [data-grid-handle]')).toHaveCount(8);
  const first = await gridCells(grid, 16, 9);
  await page.mouse.click(first(1, 0).x, first(1, 0).y + 6);
  await expect(status).toHaveText("On-air content selected.");
  await expect(frame.locator('[data-grid-box="content"] [data-grid-handle]')).toHaveCount(8);
  await expect(frame.locator('[data-grid-box="chat"] [data-grid-handle]')).toHaveCount(0);
  // A handle is at least 24 pixels to press, also where it shows smaller.
  const handle = await frame.locator('[data-grid-handle="se"]').boundingBox();
  expect(handle?.width).toBeCloseTo(12, 0);

  // Resize by a handle: the bottom-right corner goes two columns right and one row down.
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  const at = await gridCells(grid, 16, 9);
  const line = await gridLines(grid, 16, 9);
  const cellWidth: number = line(1, 0).x - line(0, 0).x;
  const contentLayer = frame.locator('.ov-layer[data-layer="content"]');
  // The mouse cursor shows what a press would do.
  await page.mouse.move(line(4, 2).x, line(4, 2).y);
  await expect(grid).toHaveAttribute("data-hover", "se");
  await expect(grid).toHaveCSS("cursor", "nwse-resize");
  await page.mouse.move(at(1, 0).x, at(1, 0).y + 6);
  await expect(grid).toHaveAttribute("data-hover", "move");
  await page.mouse.move(line(4, 2).x, line(4, 2).y);
  await page.mouse.down();
  await page.mouse.move(line(6, 3).x, line(6, 3).y, { steps: 6 });
  // During the drag the layer, its label and its content follow the new size. Nothing is saved yet.
  await expect(frame.locator("[data-grid-preview]")).not.toHaveAttribute("data-invalid");
  await expect(frame.locator('[data-grid-box="content"]')).toContainText("On-air content · 720 × 360");
  await expect.poll(async () => Math.round(((await contentLayer.boundingBox())?.width ?? 0) / cellWidth)).toBe(6);
  expect((await storedLayers(page)).cells.horizontal.content).toEqual({ c: 0, r: 0, w: 4, h: 2 });
  let save = saved(page);
  await page.mouse.up();
  await save;
  await expect(status).toHaveText("On-air content resized to 6 × 3 cells at column 1, row 1.");
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  expect((await storedLayers(page)).cells.horizontal.content).toEqual({ c: 0, r: 0, w: 6, h: 3 });

  // A resize stops at the minimum size. The minimum shows only then.
  await page.mouse.move(line(6, 3).x, line(6, 3).y);
  await page.mouse.down();
  await page.mouse.move(line(5, 3).x, line(5, 3).y, { steps: 3 });
  await expect(status).toHaveText("On-air content resized to 6 × 3 cells at column 1, row 1.");
  await page.mouse.move(line(1, 1).x, line(1, 1).y, { steps: 6 });
  await expect(status).toHaveText("On-air content needs at least 4 × 2 cells.");
  await expect(frame.locator('[data-grid-box="content"]')).toContainText("On-air content · 480 × 240");
  save = saved(page);
  await page.mouse.up();
  await save;
  await expect(status).toHaveText("On-air content resized to 4 × 2 cells at column 1, row 1.");
  expect((await storedLayers(page)).cells.horizontal.content).toEqual({ c: 0, r: 0, w: 4, h: 2 });

  // A resize onto another layer shows red and is not kept, like a move. The chat is in columns 11 to 15.
  await page.mouse.move(line(4, 1).x, line(4, 1).y);
  await expect(grid).toHaveAttribute("data-hover", "e");
  await page.mouse.down();
  await page.mouse.move(line(12, 1).x, line(12, 1).y, { steps: 6 });
  await expect(frame.locator("[data-grid-preview]")).toHaveAttribute("data-invalid", "true");
  await page.mouse.up();
  await expect(status).toHaveText("Not resized. It touches Chat.");
  await expect(status).toHaveAttribute("data-bad", "true");
  await expect(frame.locator('[data-grid-box="content"]')).toContainText("On-air content · 480 × 240");
  expect((await storedLayers(page)).cells.horizontal.content).toEqual({ c: 0, r: 0, w: 4, h: 2 });
  // A press on a handle without a move changes nothing.
  await page.mouse.move(line(4, 1).x, line(4, 1).y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(status).toHaveText("On-air content selected.");

  // Keyboard resize: Alt + arrow moves the bottom-right corner of the selected layer one cell.
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(status).toHaveText("Not resized. On-air content needs at least 4 × 2 cells.");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(status).toHaveText("Not resized. On-air content needs at least 4 × 2 cells.");
  await expect(page).toHaveURL(/\/overlay-control$/);
  save = saved(page);
  await page.keyboard.press("Alt+ArrowRight");
  await expect(status).toHaveText("On-air content resized to 5 × 2 cells at column 1, row 1.");
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("Alt+ArrowDown");
  await expect(status).toHaveText("On-air content resized to 6 × 3 cells at column 1, row 1.");
  // The steps save together after a short pause.
  await save;
  await expect(editor.getByRole("status")).toHaveText("Layout saved.");
  expect((await storedLayers(page)).cells.horizontal.content).toEqual({ c: 0, r: 0, w: 6, h: 3 });
  // Four columns are free between the content and the chat. A fifth step would touch the chat.
  for (let step = 0; step < 4; step++) await page.keyboard.press("Alt+ArrowRight");
  await expect(status).toHaveText("On-air content resized to 10 × 3 cells at column 1, row 1.");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(status).toHaveText("Not resized. It touches Chat.");
  save = saved(page);
  for (let step = 0; step < 4; step++) await page.keyboard.press("Alt+ArrowLeft");
  await expect(status).toHaveText("On-air content resized to 6 × 3 cells at column 1, row 1.");
  await save;
  await expect(editor.getByRole("status")).toHaveText("Layout saved.");
  expect((await storedLayers(page)).cells.horizontal.content).toEqual({ c: 0, r: 0, w: 6, h: 3 });
  await close(owner);
});

test("the owner adds a layer from the palette by click, key and drag, and Remove returns its chip", async ({
  browser,
}) => {
  // The chat is in columns 12 to 16. The content is not on the grid.
  const { owner, page, editor, frame, grid, status } = await openEditor(
    browser,
    PALETTE_IP,
    { chat: { c: 11, r: 0, w: 5, h: 7 } },
    { width: 1440, height: 900 },
  );
  const content = editor.locator('[data-comp-layer="content"]');
  const palette = editor.locator("[data-comp-palette]");
  const chip = paletteChip(editor, "On-air content");
  // The chat is on the grid. The characters are off and the content has no cell, so each has a chip.
  await expect(palette.getByRole("button")).toHaveText(["+ Characters", "+ On-air content"]);
  await expect(content.getByRole("button", { name: "Remove from grid" })).toHaveAttribute("aria-disabled", "true");
  // Drag the chip onto the grid: the layer drops at its minimum size around the pointed cell.
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  const at = await gridCells(grid, 16, 9);
  const dragChip = async (to: { x: number; y: number }): Promise<void> => {
    const from = await chip.boundingBox();
    if (!from) throw new Error("No chip.");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
  };
  // Over the chat (columns 12 to 16) the place is red, and the drop is not kept.
  await dragChip(at(13, 3));
  await expect(chip).toHaveAttribute("data-dragging", "true");
  await expect(frame.locator("[data-grid-preview]")).toHaveAttribute("data-invalid", "true");
  await page.mouse.up();
  await expect(status).toHaveText("Not placed. It touches Chat.");
  await expect(chip).toBeVisible();
  await expect(chip).not.toHaveAttribute("data-dragging");
  expect((await storedLayers(page)).cells.horizontal.content).toBeNull();
  // A drag that ends outside the grid adds nothing.
  await dragChip({ x: at(0, 0).x - 60, y: at(0, 8).y });
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  await page.mouse.up();
  await expect(status).toHaveText("Cancelled.");
  await expect(frame.locator('[data-grid-box="content"]')).toHaveCount(0);
  // On free cells the layer drops, is selected, and its chip leaves the palette.
  await dragChip(at(8, 4));
  await expect(frame.locator("[data-grid-preview]")).not.toHaveAttribute("data-invalid");
  let save = saved(page);
  await page.mouse.up();
  await save;
  await expect(status).toHaveText("On-air content placed at column 7, row 4, 4 × 2 cells.");
  await expect(frame.locator('[data-grid-box="content"]')).toHaveAttribute("data-selected", "true");
  await expect(palette.getByRole("button")).toHaveText(["+ Characters"]);
  await expect(grid).toBeFocused();
  expect((await storedLayers(page)).cells.horizontal.content).toEqual({ c: 6, r: 3, w: 4, h: 2 });
  // The chip also works from the keyboard: Remove returns it, Enter adds the layer at the first free place.
  save = saved(page);
  await content.getByRole("button", { name: "Remove from grid" }).click();
  await save;
  await chip.focus();
  save = saved(page);
  await page.keyboard.press("Enter");
  await save;
  await expect(status).toHaveText("On-air content placed at column 1, row 1, 4 × 2 cells.");
  save = saved(page);
  await content.getByRole("button", { name: "Remove from grid" }).click();
  await save;
  await expect(chip).toBeVisible();
  await expect(content.getByRole("button", { name: "Remove from grid" })).toHaveAttribute("aria-disabled", "true");
  expect((await storedLayers(page)).cells.horizontal.content).toBeNull();
  await close(owner);
});

test("the owner takes each layer off the grid by a drag to the palette or by a key, and a chip puts it back", async ({
  browser,
}) => {
  // All three layers are on the grid: the chat at the left, the characters along the bottom, the content between.
  const { owner, page, editor, frame, grid, status } = await openEditor(
    browser,
    REMOVE_IP,
    { content: { c: 7, r: 1, w: 7, h: 4 } },
    { width: 1440, height: 1000 },
    true,
  );
  const palette = editor.locator("[data-comp-palette]");
  const drop = palette.locator("[data-comp-palette-drop]");
  const show = (layer: string): Locator =>
    editor.locator(`[data-comp-layer="${layer}"]`).getByRole("checkbox", { name: "Show on stream" });
  await expect(frame.locator("[data-grid-box]")).toHaveCount(3);
  await expect(palette.getByRole("button")).toHaveCount(0);
  await expect(palette.locator("[data-comp-palette-empty]")).toHaveText(PALETTE_EMPTY);
  await expect(drop).toHaveCount(0);
  // The chips change the height of the palette, so read the cell centres again after a layer leaves or comes back.
  const cells = async (): Promise<(c: number, r: number) => { x: number; y: number }> => {
    await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
    return gridCells(grid, 16, 9);
  };
  let at = await cells();
  const paletteCentre = async (): Promise<{ x: number; y: number }> => {
    const box = await palette.boundingBox();
    if (!box) throw new Error("No palette.");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  // A press alone does not show the drop place. A drag does: the palette names what a drop there does.
  await page.mouse.move(at(8, 8).x, at(8, 8).y);
  await page.mouse.down();
  await expect(palette).not.toHaveAttribute("data-drop");
  await page.mouse.move(at(8, 6).x, at(8, 6).y, { steps: 4 });
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
  await expect(paletteChip(editor, "Characters")).toBeVisible();
  // The switch shows the same state. The layer is off and keeps its cell.
  await expect(show("characters")).not.toBeChecked();
  let stored = await storedLayers(page);
  expect(stored.characters.enabled).toBe(false);
  expect(stored.cells.horizontal.characters).toEqual(DEFAULT_LAYERS.cells.horizontal.characters);
  // OBS does not show a removed layer.
  const obs = await newPage(owner);
  await obs.setViewportSize({ width: 1920, height: 1080 });
  await obs.goto("/@feature_host/overlay");
  await expect(obs.locator('.ov-layer[data-layer="chat"]')).toHaveCount(1);
  await expect(obs.locator('.ov-layer[data-layer="characters"]')).toHaveCount(0);
  await close(obs);

  // A layer that is off does not block its stored cell: the content moves onto the bottom rows.
  at = await cells();
  await page.mouse.move(at(8, 2).x, at(8, 2).y);
  await page.mouse.down();
  await page.mouse.move(at(8, 6).x, at(8, 6).y, { steps: 6 });
  await expect(frame.locator("[data-grid-preview]")).not.toHaveAttribute("data-invalid");
  save = saved(page);
  await page.mouse.up();
  await save;
  await expect(status).toHaveText("On-air content moved to column 8, row 6, 7 × 4 cells.");
  // The stored characters cell went to a free place in the same save, so the saved cells do not overlap.
  stored = await storedLayers(page);
  expect(stored.cells.horizontal.content).toEqual({ c: 7, r: 5, w: 7, h: 4 });
  expect(stored.cells.horizontal.characters).toEqual({ c: 5, r: 0, w: 6, h: 2 });
  expect(stored.characters.enabled).toBe(false);

  // Keyboard: Delete takes the selected layer off the grid. The grid keeps the focus.
  at = await cells();
  await page.mouse.click(at(1, 1).x, at(1, 1).y);
  await expect(status).toHaveText("Chat selected.");
  save = saved(page);
  await page.keyboard.press("Delete");
  await save;
  await expect(status).toHaveText("Chat removed from the grid.");
  await expect(frame.locator('[data-grid-box="chat"]')).toHaveCount(0);
  await expect(grid).toBeFocused();
  await expect(show("chat")).not.toBeChecked();
  expect((await storedLayers(page)).chat.enabled).toBe(false);
  // The selected layer is off the grid now: a second key says so and saves nothing.
  await page.keyboard.press("Backspace");
  await expect(status).toHaveText("Chat is not on the grid. Add it under “Add a layer” first.");
  await expect(status).toHaveAttribute("data-bad", "true");
  await expect(page).toHaveURL(/\/overlay-control$/);
  // Backspace during a keyboard move takes the carried layer off the grid.
  for (let step = 0; step < 6; step++) await page.keyboard.press("ArrowDown");
  for (let step = 0; step < 8; step++) await page.keyboard.press("ArrowRight");
  await expect(status).toHaveText("Column 10, row 8: On-air content.");
  await page.keyboard.press("Space");
  await expect(status).toHaveText("Moving On-air content. Move the cursor, then press Space or Enter.");
  save = saved(page);
  await page.keyboard.press("Backspace");
  await save;
  await expect(status).toHaveText("On-air content removed from the grid.");
  await expect(frame.locator("[data-grid-box]")).toHaveCount(0);
  await expect(frame.locator("[data-grid-preview]")).toHaveCount(0);
  expect((await storedLayers(page)).cells.horizontal.content).toBeNull();
  await expect(palette.getByRole("button")).toHaveText(["+ Chat", "+ Characters", "+ On-air content"]);

  // A chip puts a layer back from the keyboard: Enter adds the chat at the first free place and turns it on.
  await paletteChip(editor, "Chat").focus();
  save = saved(page);
  await page.keyboard.press("Enter");
  await save;
  await expect(status).toHaveText("Chat placed at column 1, row 1, 3 × 2 cells.");
  await expect(frame.locator('[data-grid-box="chat"]')).toHaveAttribute("data-selected", "true");
  await expect(grid).toBeFocused();
  await expect(show("chat")).toBeChecked();
  stored = await storedLayers(page);
  expect(stored.chat.enabled).toBe(true);
  expect(stored.cells.horizontal.chat).toEqual({ c: 0, r: 0, w: 3, h: 2 });
  // A drag of the chip drops the characters at the pointer and turns them on.
  at = await cells();
  const chip = await paletteChip(editor, "Characters").boundingBox();
  if (!chip) throw new Error("No chip.");
  await page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2);
  await page.mouse.down();
  await page.mouse.move(at(10, 7).x, at(10, 7).y, { steps: 8 });
  // A chip on its way to the grid is not a layer to remove.
  await expect(palette).not.toHaveAttribute("data-drop");
  save = saved(page);
  await page.mouse.up();
  await save;
  await expect(status).toHaveText("Characters placed at column 8, row 7, 6 × 2 cells.");
  await expect(show("characters")).toBeChecked();
  stored = await storedLayers(page);
  expect(stored.characters.enabled).toBe(true);
  expect(stored.cells.horizontal.characters).toEqual({ c: 7, r: 6, w: 6, h: 2 });

  // The switch and the grid are two views of one state.
  save = saved(page);
  await show("chat").uncheck();
  await save;
  await expect(frame.locator('[data-grid-box="chat"]')).toHaveCount(0);
  await expect(paletteChip(editor, "Chat")).toBeVisible();
  save = saved(page);
  await show("chat").check();
  await save;
  await expect(frame.locator('[data-grid-box="chat"]')).toContainText("Chat · 360 × 240");
  await expect(paletteChip(editor, "Chat")).toHaveCount(0);
  // Escape ends a drag to the palette, and the layer stays.
  at = await cells();
  const away = await paletteCentre();
  await page.mouse.move(at(10, 7).x, at(10, 7).y);
  await page.mouse.down();
  await page.mouse.move(away.x, away.y, { steps: 8 });
  await expect(palette).toHaveAttribute("data-drop", "over");
  await page.keyboard.press("Escape");
  await expect(status).toHaveText("Cancelled.");
  await expect(palette).not.toHaveAttribute("data-drop");
  await page.mouse.up();
  await expect(frame.locator('[data-grid-box="characters"]')).toHaveCount(1);
  expect((await storedLayers(page)).characters.enabled).toBe(true);
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
  // The palette and the whole grid are on the screen together.
  await editor
    .locator("[data-comp-palette]")
    .evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  const chip = paletteChip(editor, "On-air content");
  await expect(chip).toBeInViewport({ ratio: 1 });
  await expect(grid).toBeInViewport({ ratio: 0.98 });
  const scrolled: number = await page.evaluate((): number => window.scrollY);
  const line = await gridLines(grid, 16, 9);
  const at = await gridCells(grid, 16, 9);
  // A cell is about 22 pixels here: smaller than the 28 pixels of a handle.
  expect(line(1, 0).x - line(0, 0).x).toBeLessThan(28);
  // The right edge of the selected chat (5 x 7 cells) goes two columns right. The layer follows the finger.
  await swipe(line(5, 3), line(7, 3));
  await expect(frame.locator('[data-grid-box="chat"]')).toContainText("Chat · 840 × 840");
  let save = saved(page);
  await touch("touchEnd");
  await save;
  await expect(status).toHaveText("Chat resized to 7 × 7 cells at column 1, row 1.");
  // The middle of the layer still moves it: one column right.
  save = saved(page);
  await swipe(at(3, 3), at(4, 3));
  await touch("touchEnd");
  await save;
  await expect(status).toHaveText("Chat moved to column 2, row 1, 7 × 7 cells.");
  // A finger carries the chip to the free cells at the right.
  const from = await chip.boundingBox();
  if (!from) throw new Error("No chip.");
  await swipe({ x: from.x + from.width / 2, y: from.y + from.height / 2 }, at(12, 1));
  await expect(frame.locator("[data-grid-preview]")).not.toHaveAttribute("data-invalid");
  save = saved(page);
  await touch("touchEnd");
  await save;
  await expect(status).toHaveText("On-air content placed at column 11, row 1, 4 × 2 cells.");
  expect(await page.evaluate((): number => window.scrollY)).toBe(scrolled);
  expect((await storedLayers(page)).cells.horizontal).toEqual({
    chat: { c: 1, r: 0, w: 7, h: 7 },
    characters: DEFAULT_LAYERS.cells.horizontal.characters,
    content: { c: 10, r: 0, w: 4, h: 2 },
  });
  await close(owner);
});
