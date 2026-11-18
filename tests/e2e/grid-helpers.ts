import type { Locator } from "@playwright/test";
import type { Page } from "./coverage";
import type { OverlayLayers } from "../../app/lib/overlay-layers";

/** Helpers for the specs of the layout grid in Overlay control. */

export const FEATURE_HOST = "(SELECT id FROM streamers WHERE handle='feature_host')";
export const resetLayers = `UPDATE overlay_state SET layers='{}', revision=revision+1 WHERE streamer_id=${FEATURE_HOST};`;

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

/** The chip of a layer that is not on the grid. */
export function paletteChip(editor: Locator, name: string): Locator {
  return editor.locator("[data-comp-palette]").getByRole("button", { name });
}

export const PALETTE_HINT = "Select a layer to add it at the first free place. Or drag it onto the grid.";
