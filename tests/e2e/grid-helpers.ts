import type { Locator } from "@playwright/test";
import type { Page } from "./coverage";
import type { CellRect, GridLayer, LayersPatch, OverlayLayers } from "../../app/lib/overlay-layers";

/** Helpers for the specs of the overlay studio in Overlay control. */

export const FEATURE_HOST = "(SELECT id FROM streamers WHERE handle='feature_host')";

/**
 * SQL that saves layers for the feature host, as the current version stores them. Each layer that `layers` does not
 * name is off the grid and has its default settings. The new revision makes the live room read the row again.
 */
export function layersSql(layers: LayersPatch = {}): string {
  const text: string = JSON.stringify({ v: 2, ...layers }).replaceAll("'", "''");
  return `UPDATE overlay_state SET layers='${text}', chat_test_until=0, revision=revision+1 WHERE streamer_id=${FEATURE_HOST};`;
}

/** No layer on the grid, and the chat and the characters off. */
export const resetLayers: string = layersSql();

/** The old default cells of the chat and the characters: the chat at the top left, the characters along the bottom. */
export const CHAT_CELL: CellRect = { c: 0, r: 0, w: 5, h: 7 };
export const CHARACTERS_CELL: CellRect = { c: 0, r: 7, w: 16, h: 2 };
/** The space beside CHAT_CELL and above CHARACTERS_CELL. */
export const POLL_CELL: CellRect = { c: 5, r: 0, w: 11, h: 7 };

/**
 * The overlay of a page that the owner did not change: the poll layer shows the latest active poll. A spec that
 * changes the layers of the feature host restores this when it ends, for the specs after it.
 */
export const defaultLayers: string = layersSql({
  cells: { horizontal: { poll: POLL_CELL }, vertical: { poll: { c: 0, r: 0, w: 9, h: 8 } } },
});

export function saved(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/overlay" && response.ok(),
  );
}

/** The saved layers, read through the API with the page's session. */
export async function storedLayers(page: Page): Promise<OverlayLayers> {
  const response = await page.request.get("/api/overlay");
  return ((await response.json()) as { overlay: { layers: OverlayLayers } }).overlay.layers;
}

/** The grid button inside the application region that carries the grid name. */
export function gridButton(editor: Locator, name: string | RegExp): Locator {
  return editor.getByRole("application", { name }).getByRole("button");
}

/** Pointer helpers for the grid: the centre of a cell in screen pixels. */
export async function gridCells(
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

/** Pointer helpers for the grid: the crossing of a column line and a row line in screen pixels, inside the grid. */
export async function gridLines(
  grid: Locator,
  cols: number,
  rows: number,
): Promise<(c: number, r: number) => { x: number; y: number }> {
  const box = await grid.boundingBox();
  if (!box) throw new Error("No grid.");
  const inside = (value: number, start: number, size: number): number =>
    Math.round(Math.min(start + size - 2, Math.max(start + 2, value)));
  return (c: number, r: number) => ({
    x: inside(box.x + (c * box.width) / cols, box.x, box.width),
    y: inside(box.y + (r * box.height) / rows, box.y, box.height),
  });
}

/** The chip of a layer in the palette. A chip of a layer on the grid has `data-placed`. */
export function chip(editor: Locator, layer: GridLayer): Locator {
  return editor.locator(`[data-comp-palette] [data-comp-layer="${layer}"]`);
}

/** The settings of the selected layer. `data-comp-props` names the layer, and is empty without a selection. */
export function settings(editor: Locator): Locator {
  return editor.locator("[data-comp-props]");
}

/**
 * Puts a layer that is off the grid on it through its chip: at the first free place, at its minimum size. The
 * layer is then selected and its settings show.
 */
export async function placeLayer(page: Page, editor: Locator, layer: GridLayer): Promise<void> {
  const done: Promise<unknown> = saved(page);
  await chip(editor, layer).click();
  await done;
}

export const PALETTE_HINT =
  "Select a layer to add it at the first free place. Or drag it onto the grid. To remove a layer, drag it from the grid back here. Select a placed layer to change it.";
