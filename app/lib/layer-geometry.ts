import {
  GRID,
  GRID_LAYERS,
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

/**
 * `draft` without the fields that still hold the value `sent` saved (or failed to save). A field edited again
 * since then has another value and stays.
 */
export function withoutSent(draft: LayersPatch, sent: LayersPatch): LayersPatch {
  const result: LayersPatch = compact(draft);
  if (result.orientation !== undefined && result.orientation === sent.orientation) delete result.orientation;
  if (result.chat) {
    if (result.chat.enabled !== undefined && result.chat.enabled === sent.chat?.enabled) delete result.chat.enabled;
    if (result.chat.hideCommands !== undefined && result.chat.hideCommands === sent.chat?.hideCommands)
      delete result.chat.hideCommands;
  }
  if (result.characters?.enabled !== undefined && result.characters.enabled === sent.characters?.enabled)
    delete result.characters.enabled;
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

/** The placed layer at a cell, or null for an empty cell. */
export function layerAt(cells: LayerCells, cell: Cell): GridLayer | null {
  for (const layer of GRID_LAYERS) {
    const rect: CellRect | null = cells[layer];
    if (rect && cell.c >= rect.c && cell.c < rect.c + rect.w && cell.r >= rect.r && cell.r < rect.r + rect.h)
      return layer;
  }
  return null;
}

export type PlaceProblem = { kind: "outside" } | { kind: "overlap"; other: GridLayer } | { kind: "small" };

/**
 * Why `rect` cannot be the cell of `layer` in `orientation` (it leaves the grid, touches another layer or is below
 * the minimum), or null. The server refuses the same cells.
 */
export function placeProblem(
  orientation: Orientation,
  cells: LayerCells,
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
