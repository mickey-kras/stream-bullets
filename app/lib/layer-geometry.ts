import {
  GRID,
  GRID_LAYERS,
  MIN_CELLS,
  ORIENTATIONS,
  cellFits,
  cellsOverlap,
  copyCell,
  type CellRect,
  type CellsPatch,
  type GridLayer,
  type LayerCells,
  type LayersPatch,
  type Orientation,
  type OverlayLayers,
} from "./overlay-layers";

/**
 * Pure helpers for the composition editor (issue #663): grid edits and the field-level patches the editor saves.
 * A patch names only the fields the streamer changed, so a save never writes back a field that another tab changed
 * in the meantime. Each layer cell is one field and is always sent whole.
 */

/** Orders the layer writes of one editor: the server ignores a write with a `seq` it already passed. */
export interface LayersWrite {
  writer: string;
  seq: number;
}

/** POST /api/overlay {action: "layers"}: only the changed fields. */
export interface LayersAction extends LayersPatch {
  action: "layers";
  write: LayersWrite;
}

export interface Cell {
  c: number;
  r: number;
}

/** A point on the grid in cells, with fractions: (0, 0) is the top-left corner of the grid. */
export interface GridPoint {
  x: number;
  y: number;
}

function sameCell(a: CellRect | null | undefined, b: CellRect | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.c === b.c && a.r === b.r && a.w === b.w && a.h === b.h;
}

function setCell(cells: CellsPatch, layer: GridLayer, rect: CellRect | null): void {
  if (layer === "content") cells.content = rect ? copyCell(rect) : null;
  else if (rect) cells[layer] = copyCell(rect);
}

function copyCells(cells: CellsPatch): CellsPatch {
  const copy: CellsPatch = {};
  for (const layer of GRID_LAYERS) {
    const rect: CellRect | null | undefined = cells[layer];
    if (rect !== undefined) setCell(copy, layer, rect);
  }
  return copy;
}

function compact(patch: LayersPatch): LayersPatch {
  const result: LayersPatch = {};
  if (patch.orientation !== undefined) result.orientation = patch.orientation;
  if (patch.chat && Object.keys(patch.chat).length > 0) result.chat = { ...patch.chat };
  if (patch.characters && Object.keys(patch.characters).length > 0) result.characters = { ...patch.characters };
  const cells: Partial<Record<Orientation, CellsPatch>> = {};
  for (const orientation of ORIENTATIONS) {
    const layout: CellsPatch | undefined = patch.cells?.[orientation];
    if (layout && Object.keys(layout).length > 0) cells[orientation] = copyCells(layout);
  }
  if (Object.keys(cells).length > 0) result.cells = cells;
  return result;
}

/** The fields that differ from `before` to `after`, with their `after` values. */
export function diffLayers(before: OverlayLayers, after: OverlayLayers): LayersPatch {
  const patch: LayersPatch = { chat: {}, characters: {}, cells: {} };
  if (before.orientation !== after.orientation) patch.orientation = after.orientation;
  if (before.chat.enabled !== after.chat.enabled) patch.chat = { enabled: after.chat.enabled };
  if (before.chat.hideCommands !== after.chat.hideCommands)
    patch.chat = { ...patch.chat, hideCommands: after.chat.hideCommands };
  if (before.chat.backgroundOpacity !== after.chat.backgroundOpacity)
    patch.chat = { ...patch.chat, backgroundOpacity: after.chat.backgroundOpacity };
  if (before.characters.enabled !== after.characters.enabled) patch.characters = { enabled: after.characters.enabled };
  if (before.characters.timeout !== after.characters.timeout)
    patch.characters = { ...patch.characters, timeout: after.characters.timeout };
  for (const orientation of ORIENTATIONS) {
    const layout: CellsPatch = {};
    for (const layer of GRID_LAYERS) {
      const rect: CellRect | null = after.cells[orientation][layer];
      if (!sameCell(before.cells[orientation][layer], rect)) setCell(layout, layer, rect);
    }
    patch.cells = { ...patch.cells, [orientation]: layout };
  }
  return compact(patch);
}

/** Both patches in one. A field in `next` wins. */
export function mergePatches(base: LayersPatch, next: LayersPatch): LayersPatch {
  return compact({
    orientation: next.orientation ?? base.orientation,
    chat: { ...base.chat, ...next.chat },
    characters: { ...base.characters, ...next.characters },
    cells: {
      horizontal: { ...base.cells?.horizontal, ...next.cells?.horizontal },
      vertical: { ...base.cells?.vertical, ...next.cells?.vertical },
    },
  });
}

function removeSentCells(layout: CellsPatch, sent: CellsPatch): void {
  for (const layer of GRID_LAYERS)
    if (layout[layer] !== undefined && sent[layer] !== undefined && sameCell(layout[layer], sent[layer]))
      delete layout[layer];
}

function removeSentFields<T extends object>(
  target: T | undefined,
  sent: T | undefined,
  keys: readonly (keyof T)[],
): void {
  if (!target || !sent) return;
  for (const key of keys) if (target[key] !== undefined && target[key] === sent[key]) delete target[key];
}

/**
 * `draft` without the fields that still hold the value `sent` saved (or failed to save). A field edited again
 * since then has another value and stays.
 */
export function withoutSent(draft: LayersPatch, sent: LayersPatch): LayersPatch {
  const result: LayersPatch = compact(draft);
  removeSentFields(result, sent, ["orientation"]);
  removeSentFields(result.chat, sent.chat, ["enabled", "hideCommands", "backgroundOpacity"]);
  removeSentFields(result.characters, sent.characters, ["enabled"]);
  for (const orientation of ORIENTATIONS) {
    const layout: CellsPatch | undefined = result.cells?.[orientation];
    const done: CellsPatch | undefined = sent.cells?.[orientation];
    if (!layout || !done) continue;
    removeSentCells(layout, done);
  }
  return compact(result);
}

export function isEmptyPatch(patch: LayersPatch): boolean {
  return Object.keys(compact(patch)).length === 0;
}

/** The request for a patch: only its fields, each cell copied whole. */
export function layersAction(patch: LayersPatch, write: LayersWrite): LayersAction {
  return { action: "layers", write: { ...write }, ...compact(patch) };
}

/** `layers` with one layer's cell in one orientation replaced. Null removes the content cell. */
export function withCell(
  layers: OverlayLayers,
  orientation: Orientation,
  layer: GridLayer,
  rect: CellRect | null,
): OverlayLayers {
  const cells: LayerCells = { ...layers.cells[orientation] };
  if (layer === "content") cells.content = rect;
  else if (rect) cells[layer] = rect;
  return { ...layers, cells: { ...layers.cells, [orientation]: cells } };
}

/** The rectangle between two cells, both included. */
export function spanCells(from: Cell, to: Cell): CellRect {
  return {
    c: Math.min(from.c, to.c),
    r: Math.min(from.r, to.r),
    w: Math.abs(to.c - from.c) + 1,
    h: Math.abs(to.r - from.r) + 1,
  };
}

/** `rect` moved so that the cell it was grabbed at (`grab`, relative to its corner) is at `at`, inside the grid. */
export function moveCell(orientation: Orientation, rect: CellRect, grab: Cell, at: Cell): CellRect {
  const { cols, rows } = GRID[orientation];
  return {
    ...rect,
    c: Math.max(0, Math.min(cols - rect.w, at.c - grab.c)),
    r: Math.max(0, Math.min(rows - rect.h, at.r - grab.r)),
  };
}

/** The cells the layout grid draws. A layer that is not on the grid has null. */
export type GridCells = Readonly<Record<GridLayer, CellRect | null>>;

/** The layers that leave the grid by their `enabled` setting. Their cells stay stored. */
const SWITCHED_LAYERS = ["chat", "characters"] as const;

/** True when the grid draws `layer`: a chat or characters layer that is on, or content with a cell. */
export function onGrid(layers: OverlayLayers, orientation: Orientation, layer: GridLayer): boolean {
  return layer === "content" ? layers.cells[orientation].content !== null : layers[layer].enabled;
}

/** The cells of the layers on the grid in `orientation`. A chat or characters layer that is off has null. */
export function gridCells(layers: OverlayLayers, orientation: Orientation): GridCells {
  const cells: LayerCells = layers.cells[orientation];
  return {
    chat: layers.chat.enabled ? cells.chat : null,
    characters: layers.characters.enabled ? cells.characters : null,
    content: cells.content,
  };
}

function withEnabled(layers: OverlayLayers, layer: GridLayer, enabled: boolean): OverlayLayers {
  if (layer === "chat") return { ...layers, chat: { ...layers.chat, enabled } };
  if (layer === "characters") return { ...layers, characters: { ...layers.characters, enabled } };
  return layers;
}

/** `layers` with `layer` off the grid. Content loses its cell. Chat and characters go off and keep their cells. */
export function withRemoved(layers: OverlayLayers, orientation: Orientation, layer: GridLayer): OverlayLayers {
  return layer === "content" ? withCell(layers, orientation, "content", null) : withEnabled(layers, layer, false);
}

/** The placed layer at a cell, or null for an empty cell. */
export function layerAt(cells: GridCells, cell: Cell): GridLayer | null {
  for (const layer of GRID_LAYERS) {
    const rect: CellRect | null = cells[layer];
    if (rect && cell.c >= rect.c && cell.c < rect.c + rect.w && cell.r >= rect.r && cell.r < rect.r + rect.h)
      return layer;
  }
  return null;
}

export type PlaceProblem =
  | { kind: "outside" }
  | { kind: "overlap"; other: GridLayer }
  | { kind: "small" }
  | { kind: "noRoom"; other: GridLayer };

/**
 * Why `rect` cannot be the cell of `layer` in `orientation` (it leaves the grid, touches another layer or is below
 * the minimum), or null. The server refuses the same cells.
 */
export function placeProblem(
  orientation: Orientation,
  cells: GridCells,
  layer: GridLayer,
  rect: CellRect,
): PlaceProblem | null {
  const { cols, rows } = GRID[orientation];
  if (rect.c < 0 || rect.r < 0 || rect.c + rect.w > cols || rect.r + rect.h > rows) return { kind: "outside" };
  for (const other of GRID_LAYERS) {
    const place: CellRect | null = cells[other];
    if (other !== layer && place && cellsOverlap(rect, place)) return { kind: "overlap", other };
  }
  return cellFits(orientation, layer, rect) ? null : { kind: "small" };
}

/** The resize handles of a placed layer: its four corners and four edges, by compass direction. */
export const RESIZE_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type ResizeHandle = (typeof RESIZE_HANDLES)[number];

type Side = -1 | 0 | 1;

/** The edges a handle moves: `x` -1 is the left edge and 1 the right edge, `y` -1 the top edge and 1 the bottom. */
const HANDLE_SIDES: Readonly<Record<ResizeHandle, Readonly<{ x: Side; y: Side }>>> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
};

/** A resized cell. `min` is true when the request was below the minimum size, so the cell stopped at the minimum. */
export interface Resize {
  rect: CellRect;
  min: boolean;
}

interface Span {
  start: number;
  size: number;
  min: boolean;
}

/** One axis of a resize: the edge on `side` goes to grid line `to`, not past the grid or the minimum size. */
function resizeSpan(start: number, size: number, side: Side, to: number, least: number, lines: number): Span {
  const end: number = start + size;
  if (side === 1) {
    const stop: number = Math.max(start + least, Math.min(lines, to));
    return { start, size: stop - start, min: to < start + least };
  }
  if (side === -1) {
    const from: number = Math.min(end - least, Math.max(0, to));
    return { start: from, size: end - from, min: to > end - least };
  }
  return { start, size, min: false };
}

/**
 * `rect` of `layer` with the edges of `handle` moved to the grid lines of `to` (`c` 0 is the left edge of the grid,
 * `c` equal to the number of columns its right edge; rows the same). The other edges stay. The cell stays inside the
 * grid and never goes below the minimum size of the layer. It does not check the overlap rule: see placeProblem.
 */
export function resizeCell(
  orientation: Orientation,
  layer: GridLayer,
  rect: CellRect,
  handle: ResizeHandle,
  to: Cell,
): Resize {
  const { cols, rows } = GRID[orientation];
  const least = MIN_CELLS[layer];
  const sides = HANDLE_SIDES[handle];
  const across: Span = resizeSpan(rect.c, rect.w, sides.x, to.c, least.w, cols);
  const down: Span = resizeSpan(rect.r, rect.h, sides.y, to.r, least.h, rows);
  return { rect: { c: across.start, r: down.start, w: across.size, h: down.size }, min: across.min || down.min };
}

/** `rect` with its bottom-right corner moved by `step` cells: the keyboard resize. */
export function growCell(orientation: Orientation, layer: GridLayer, rect: CellRect, step: Cell): Resize {
  return resizeCell(orientation, layer, rect, "se", { c: rect.c + rect.w + step.c, r: rect.r + rect.h + step.r });
}

/** The grid line that the edges of `handle` are on: the start of a resize. */
export function handleLines(rect: CellRect, handle: ResizeHandle): Cell {
  const sides = HANDLE_SIDES[handle];
  return { c: sides.x === -1 ? rect.c : rect.c + rect.w, r: sides.y === -1 ? rect.r : rect.r + rect.h };
}

/**
 * The side of a span that `at` is on: -1 near its start, 1 near its end, 0 between them and null outside. An edge
 * takes `reach` outside the span, and inside it `reach` or a quarter of the span, so that the middle of a small
 * span stays free.
 */
function sideAt(at: number, start: number, size: number, reach: number): Side | null {
  const end: number = start + size;
  const inner: number = Math.min(reach, size / 4);
  if (at < start - reach || at > end + reach) return null;
  if (at <= start + inner) return -1;
  return at >= end - inner ? 1 : 0;
}

/**
 * The resize handle of `rect` at `point`, or null. A handle is a band along an edge, `reach` cells to each side
 * (see sideAt for the inner side). Two bands meet in a corner handle. The middle of the cell has no handle.
 */
export function handleAt(rect: CellRect, point: GridPoint, reach: GridPoint): ResizeHandle | null {
  const x: Side | null = sideAt(point.x, rect.c, rect.w, reach.x);
  const y: Side | null = sideAt(point.y, rect.r, rect.h, reach.y);
  if (x === null || y === null) return null;
  return (
    RESIZE_HANDLES.find(
      (handle: ResizeHandle): boolean => HANDLE_SIDES[handle].x === x && HANDLE_SIDES[handle].y === y,
    ) ?? null
  );
}

/** The minimum-size cell of `layer` with its middle at the cell `at`, moved inside the grid: a drop from the palette. */
export function dropCell(orientation: Orientation, layer: GridLayer, at: Cell): CellRect {
  const { w, h } = MIN_CELLS[layer];
  return moveCell(orientation, { c: 0, r: 0, w, h }, { c: Math.floor(w / 2), r: Math.floor(h / 2) }, at);
}

/**
 * The first free place for `layer` at `size` (default: its minimum size), row by row from the top-left corner, or
 * null when no place is free.
 */
export function firstFreeCell(
  orientation: Orientation,
  cells: GridCells,
  layer: GridLayer,
  size: Readonly<{ w: number; h: number }> = MIN_CELLS[layer],
): CellRect | null {
  const { cols, rows } = GRID[orientation];
  const { w, h } = size;
  for (let r = 0; r + h <= rows; r += 1)
    for (let c = 0; c + w <= cols; c += 1) {
      const rect: CellRect = { c, r, w, h };
      if (placeProblem(orientation, cells, layer, rect) === null) return rect;
    }
  return null;
}

/** The stored cells after a placement, or the layer off the grid that has no free place for its stored cell. */
type Parked = { cells: LayerCells; stuck: null } | { cells: null; stuck: GridLayer };

// Stored cells never overlap, also the cell of a layer that is off. So such a cell moves away from a new cell.
function parkedCells(orientation: Orientation, layers: OverlayLayers, layer: GridLayer, rect: CellRect): Parked {
  const cells: LayerCells = { ...layers.cells[orientation] };
  if (layer === "content") cells.content = rect;
  else cells[layer] = rect;
  for (const other of SWITCHED_LAYERS) {
    const kept: CellRect = cells[other];
    if (other === layer || layers[other].enabled || !cellsOverlap(kept, rect)) continue;
    const free: CellRect | null =
      firstFreeCell(orientation, cells, other, kept) ?? firstFreeCell(orientation, cells, other);
    if (!free) return { cells: null, stuck: other };
    cells[other] = free;
  }
  return { cells, stuck: null };
}

/**
 * Why `rect` cannot be the cell of `layer` on the grid of `layers`, or null. Only the layers on the grid are in the
 * way. `noRoom` names a layer off the grid whose stored cell is under `rect` and has no other free place.
 */
export function layoutProblem(
  layers: OverlayLayers,
  orientation: Orientation,
  layer: GridLayer,
  rect: CellRect,
): PlaceProblem | null {
  const problem: PlaceProblem | null = placeProblem(orientation, gridCells(layers, orientation), layer, rect);
  if (problem) return problem;
  const { stuck } = parkedCells(orientation, layers, layer, rect);
  return stuck ? { kind: "noRoom", other: stuck } : null;
}

/**
 * `layers` with `layer` on the grid at `rect`: a chat or characters layer goes on. The stored cell of a layer that
 * is off the grid moves to a free place when `rect` covers it. Null when layoutProblem refuses `rect`.
 */
export function withPlaced(
  layers: OverlayLayers,
  orientation: Orientation,
  layer: GridLayer,
  rect: CellRect,
): OverlayLayers | null {
  if (placeProblem(orientation, gridCells(layers, orientation), layer, rect) !== null) return null;
  const { cells } = parkedCells(orientation, layers, layer, rect);
  if (!cells) return null;
  return { ...withEnabled(layers, layer, true), cells: { ...layers.cells, [orientation]: cells } };
}
