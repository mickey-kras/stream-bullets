import type { OverlayPosition, OverlaySize, OverlaySourceRef } from "../types";
import { firstFreeCell, placeProblem, withCell, withItem } from "./layer-geometry";
import {
  CONTENT_LAYERS,
  LAYERS_VERSION,
  MIN_CELLS,
  ORIENTATIONS,
  REF_LAYERS,
  cellsOverlap,
  readCell,
  storedLayersSchema,
  type CellRect,
  type ContentLayer,
  type LayerCells,
  type Orientation,
  type OverlayLayers,
} from "./overlay-layers";

/**
 * Older overlay state. A stored `layers` text without the current version (`v`) is old, and the functions here
 * convert it. See docs/overlay-composition.md for the mapping.
 *
 * Version 2 had cells of 120 px: 16 x 9 across. Each old cell is 2 x 2 cells now (issue #1032).
 *
 * A text without a version is from before the overlay studio (issue #864). Then one source was on air
 * (`overlay_state.air`) with a position and a size, the chat and characters layers always had a cell, and a `content`
 * cell could hold the source on the grid. Now the overlay shows only layers on the grid.
 */

/** The version with cells of 120 px. A text without a version has cells of that size too. */
const COARSE_VERSION = 2;
/** The cells of today for each side of a cell of 120 px. */
const COARSE = 2;

/** The columns of `overlay_state` that held the source on air. */
export interface LegacyContent {
  air: OverlaySourceRef;
  position: OverlayPosition;
  size: OverlaySize;
}

/** A page without an `overlay_state` row showed Auto, the latest active poll, in the lower position at size M. */
export const LEGACY_DEFAULT: LegacyContent = { air: { type: "auto", ref: null }, position: "lower", size: "m" };

type Place = OverlayPosition | "full";

/** A cell of today from a place in cells of 120 px. The tables below keep the numbers of the old grid. */
function cell(c: number, r: number, w: number, h: number): CellRect {
  return { c: c * COARSE, r: r * COARSE, w: w * COARSE, h: h * COARSE };
}

/** The chat and characters cells that an old text without a valid cell read as. */
const LEGACY_CELLS: Readonly<Record<Orientation, Readonly<{ chat: CellRect; characters: CellRect }>>> = {
  horizontal: { chat: cell(0, 0, 5, 7), characters: cell(0, 7, 16, 2) },
  vertical: { chat: cell(0, 8, 9, 5), characters: cell(0, 13, 9, 3) },
};

/**
 * The cell for each old position and size. A poll filled the frame (`full`) and ignored the position: at sizes S and
 * M its cell is beside the old default chat cell and above the old default characters cell. The other sources used
 * the lower third, the top bar, the bottom-right corner or the centre.
 */
const LEGACY_PLACES: Readonly<Record<Orientation, Readonly<Record<Place, Readonly<Record<OverlaySize, CellRect>>>>>> = {
  horizontal: {
    full: { s: cell(5, 0, 9, 5), m: cell(5, 0, 11, 7), l: cell(0, 0, 16, 9) },
    lower: { s: cell(0, 7, 8, 2), m: cell(0, 6, 10, 3), l: cell(0, 5, 12, 4) },
    top: { s: cell(0, 0, 12, 2), m: cell(0, 0, 16, 2), l: cell(0, 0, 16, 3) },
    corner: { s: cell(11, 7, 5, 2), m: cell(10, 6, 6, 3), l: cell(8, 5, 8, 4) },
    center: { s: cell(5, 3, 6, 3), m: cell(4, 3, 8, 3), l: cell(3, 2, 10, 5) },
  },
  vertical: {
    full: { s: cell(0, 0, 7, 6), m: cell(0, 0, 9, 8), l: cell(0, 0, 9, 10) },
    lower: { s: cell(0, 14, 7, 2), m: cell(0, 13, 9, 3), l: cell(0, 12, 9, 4) },
    top: { s: cell(0, 0, 7, 2), m: cell(0, 0, 9, 2), l: cell(0, 0, 9, 3) },
    corner: { s: cell(5, 14, 4, 2), m: cell(4, 13, 5, 3), l: cell(3, 12, 6, 4) },
    center: { s: cell(2, 7, 5, 2), m: cell(1, 6, 7, 3), l: cell(0, 6, 9, 4) },
  },
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function jsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** True for a stored `layers` text of an older version: the server then stores the converted layers. */
export function legacyLayersText(raw: string): boolean {
  return record(jsonValue(raw)).v !== LAYERS_VERSION;
}

/** The old chat and characters cells of one orientation: an invalid cell took its default, and so did both on overlap. */
function legacyPair(
  orientation: Orientation,
  cells: Record<string, unknown>,
): { chat: CellRect; characters: CellRect } {
  const usual = LEGACY_CELLS[orientation];
  const chat: CellRect = readCell(orientation, "chat", cells.chat) ?? usual.chat;
  const characters: CellRect = readCell(orientation, "characters", cells.characters) ?? usual.characters;
  return cellsOverlap(chat, characters) ? usual : { chat, characters };
}

/**
 * The layers of an old value. A chat or characters layer that was on keeps its old cells. One that was off leaves
 * the grid: its old cell only kept a place free.
 */
function legacyLayers(value: unknown): OverlayLayers {
  const raw: Record<string, unknown> = record(value);
  const old: Record<string, unknown> = record(raw.cells);
  const read: OverlayLayers = storedLayersSchema.parse(raw);
  const cells: Record<string, unknown> = {};
  for (const orientation of ORIENTATIONS) {
    const pair = legacyPair(orientation, record(old[orientation]));
    cells[orientation] = {
      ...record(old[orientation]),
      chat: read.chat.enabled ? pair.chat : null,
      characters: read.characters.enabled ? pair.characters : null,
    };
  }
  return storedLayersSchema.parse({ ...raw, cells });
}

/**
 * The cell for a content layer: `wanted` when it is free. Else the largest free cell that is not larger than
 * `wanted` and not below the minimum size, at its first free place. Null when the grid has no such cell. The search
 * tries each `step` cells of width and height: COARSE gives the cell that the grid of 120 px gave.
 */
function freeCell(
  orientation: Orientation,
  cells: LayerCells,
  layer: ContentLayer,
  wanted: CellRect,
  step: number,
): CellRect | null {
  if (placeProblem(orientation, cells, layer, wanted) === null) return wanted;
  const least = MIN_CELLS[layer];
  let best: CellRect | null = null;
  for (let h = wanted.h; h >= least.h; h -= step)
    for (let w = wanted.w; w >= least.w; w -= step) {
      // A smaller size cannot give a larger cell.
      if (best && w * h <= best.w * best.h) break;
      best = firstFreeCell(orientation, cells, layer, { w, h }) ?? best;
    }
  return best;
}

/** `layers` with the content layer `layer` at a free cell near `wanted` in each orientation. */
function withContentPlaced(
  layers: OverlayLayers,
  layer: ContentLayer,
  wanted: (orientation: Orientation) => CellRect,
  step: number,
): OverlayLayers {
  let placed: OverlayLayers = layers;
  for (const orientation of ORIENTATIONS) {
    const cells: LayerCells = placed.cells[orientation];
    placed = withCell(placed, orientation, layer, freeCell(orientation, cells, layer, wanted(orientation), step));
  }
  return placed;
}

function usesContentLayers(layers: OverlayLayers): boolean {
  return ORIENTATIONS.some((orientation: Orientation): boolean =>
    CONTENT_LAYERS.some((layer: ContentLayer): boolean => layers.cells[orientation][layer] !== null),
  );
}

/** The content layer for an old source on air, or null for a source that showed nothing. */
function legacyLayer(air: OverlaySourceRef): ContentLayer | null {
  if (air.type === "hidden") return null;
  if (air.type === "auto") return "poll";
  // "A specific poll" without a poll showed nothing. A poll layer without a ref shows the latest active poll.
  return air.type === "poll" && air.ref === null ? null : air.type;
}

/**
 * `layers` with the old source on air as a content layer on the grid, in both orientations. It goes to the old
 * `content` cell of `value` when one exists, else to the cell for the old position and size. Layers that already use
 * a content layer stay as they are.
 */
function withLegacyContent(layers: OverlayLayers, value: unknown, legacy: LegacyContent): OverlayLayers {
  const layer: ContentLayer | null = legacyLayer(legacy.air);
  if (layer === null || usesContentLayers(layers)) return layers;
  const old: Record<string, unknown> = record(record(value).cells);
  const place: Place = layer === "poll" ? "full" : legacy.position;
  const ref: string | null = REF_LAYERS.has(layer) ? legacy.air.ref : null;
  return withContentPlaced(
    withItem(layers, layer, { enabled: true, ref }),
    layer,
    (orientation: Orientation): CellRect =>
      readCell(orientation, layer, record(old[orientation]).content) ?? LEGACY_PLACES[orientation][place][legacy.size],
    COARSE,
  );
}

/** A stored cell of 120 px as cells of today. A value that is not four whole numbers stays as it is: it is no cell. */
function fineCell(value: unknown): unknown {
  const { c, r, w, h } = record(value);
  const whole: boolean = [c, r, w, h].every((part: unknown): boolean => Number.isInteger(part));
  return whole ? { ...record(value), ...cell(Number(c), Number(r), Number(w), Number(h)) } : value;
}

/** A stored value with cells of 120 px, with each cell in cells of today. */
function fineValue(value: unknown): unknown {
  const raw: Record<string, unknown> = record(value);
  const old: Record<string, unknown> = record(raw.cells);
  const cells: Record<string, unknown> = {};
  for (const orientation of ORIENTATIONS) {
    const layout: Record<string, unknown> = record(old[orientation]);
    cells[orientation] = Object.fromEntries(
      Object.entries(layout).map(([layer, rect]: [string, unknown]): [string, unknown] => [layer, fineCell(rect)]),
    );
  }
  return { ...raw, cells };
}

/**
 * Reads a stored `layers` JSON text. Invalid JSON reads as the defaults, the same as an invalid value. An old text
 * is converted: its cells of 120 px become cells of today. Then, for a text without a version and with `legacy`, the
 * old source on air becomes a content layer on the grid.
 */
export function parseStoredLayers(raw: string, legacy?: LegacyContent): OverlayLayers {
  const value: unknown = jsonValue(raw);
  const version: unknown = record(value).v;
  if (version === LAYERS_VERSION) return storedLayersSchema.parse(value);
  const fine: unknown = fineValue(value);
  if (version === COARSE_VERSION) return storedLayersSchema.parse(fine);
  const layers: OverlayLayers = legacyLayers(fine);
  return legacy ? withLegacyContent(layers, fine, legacy) : layers;
}

/**
 * `layers` for an OBS URL with `?poll=`: the poll layer shows the poll `ref` and no other content layer shows. A
 * poll layer that is off the grid goes to the cell of a full-frame poll.
 */
export function withPollOverride(layers: OverlayLayers, ref: string): OverlayLayers {
  let only: OverlayLayers = withItem(layers, "poll", { enabled: true, ref });
  for (const orientation of ORIENTATIONS)
    for (const layer of CONTENT_LAYERS) if (layer !== "poll") only = withCell(only, orientation, layer, null);
  return withContentPlaced(
    only,
    "poll",
    (orientation: Orientation): CellRect =>
      only.cells[orientation].poll ?? LEGACY_PLACES[orientation].full[LEGACY_DEFAULT.size],
    1,
  );
}
