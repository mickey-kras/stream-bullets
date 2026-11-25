import { z } from "zod";
import { withEnabled } from "./layer-geometry";
import {
  GRID_LAYERS,
  emptyCells,
  layerEnabled,
  readCells,
  storedCells,
  type CellRect,
  type GridLayer,
  type LayerCells,
  type Orientation,
  type OverlayLayers,
} from "./overlay-layers";

/**
 * The layouts of the overlay. Each output, horizontal and vertical, has its own layouts and one layout on stream.
 * A layout is the cells of the layers of one output. The settings of a layer are not a part of a layout.
 *
 * The cells of the layout on stream are `layers.cells[output]`: each edit of the grid changes them, as before the
 * layouts. `OverlayLayouts` keeps the other layouts, and which layout is on stream. The stored cells of the layout
 * on stream are old until the streamer selects a different layout: then they take the cells of the grid.
 */

/** The largest number of layouts that a streamer can save for one output. The presets do not count. */
export const LAYOUT_LIMIT = 8;
export const LAYOUT_NAME_LENGTH = 40;
/** The largest length of the stored `layouts` text. All layouts of the two outputs at full size need less. */
export const STORED_LAYOUTS_LENGTH = 16_000;

export interface SavedLayout {
  /** A random ID, or the ID of a preset: then this is the version of the streamer of that preset. */
  id: string;
  /** The name that the streamer gave. A preset has its name in the interface, and none here. */
  name: string;
  cells: LayerCells;
}

export interface OutputLayouts {
  /** The ID of the layout on stream. Null: the layout on stream is not saved yet. */
  active: string | null;
  saved: SavedLayout[];
}

export type OverlayLayouts = Record<Orientation, OutputLayouts>;

export const EMPTY_LAYOUTS: OverlayLayouts = {
  horizontal: { active: null, saved: [] },
  vertical: { active: null, saved: [] },
};

export const PRESET_KEYS = ["chatting", "gameplay", "vertical"] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];

interface LayoutPreset {
  output: Orientation;
  cells: Partial<Record<GridLayer, CellRect>>;
}

/** The presets. Each one is for one output. A cell is 60 pixels. */
export const LAYOUT_PRESETS: Readonly<Record<PresetKey, LayoutPreset>> = {
  // The camera is the picture. The chat is at its side, and the poll and the message banner are below.
  chatting: {
    output: "horizontal",
    cells: {
      camera: { c: 1, r: 1, w: 21, h: 12 },
      chat: { c: 23, r: 1, w: 8, h: 12 },
      poll: { c: 1, r: 13, w: 12, h: 5 },
      message: { c: 13, r: 14, w: 18, h: 4 },
    },
  },
  // The game is the picture. The layers are at the edges: a small camera, the chat, the poll, and the characters.
  gameplay: {
    output: "horizontal",
    cells: {
      camera: { c: 0, r: 12, w: 8, h: 6 },
      chat: { c: 24, r: 6, w: 8, h: 12 },
      poll: { c: 22, r: 0, w: 10, h: 5 },
      characters: { c: 8, r: 14, w: 16, h: 4 },
    },
  },
  // The tall picture: the camera at the top, then the poll, the chat, and the characters.
  vertical: {
    output: "vertical",
    cells: {
      camera: { c: 1, r: 1, w: 16, h: 12 },
      poll: { c: 1, r: 13, w: 16, h: 6 },
      chat: { c: 0, r: 20, w: 18, h: 8 },
      characters: { c: 0, r: 28, w: 18, h: 4 },
    },
  },
};

const PRESET_PREFIX = "preset:";

export function presetId(key: PresetKey): string {
  return `${PRESET_PREFIX}${key}`;
}

/** The preset of a layout ID, or null for a layout of the streamer. */
export function presetOf(id: string): PresetKey | null {
  return PRESET_KEYS.find((key: PresetKey): boolean => presetId(key) === id) ?? null;
}

/** The cells of a preset as it comes. */
export function presetCells(key: PresetKey): LayerCells {
  return { ...emptyCells(), ...LAYOUT_PRESETS[key].cells };
}

/** The presets of one output, in their sequence. */
export function outputPresets(output: Orientation): PresetKey[] {
  return PRESET_KEYS.filter((key: PresetKey): boolean => LAYOUT_PRESETS[key].output === output);
}

function sameCells(a: LayerCells, b: LayerCells): boolean {
  return GRID_LAYERS.every((layer: GridLayer): boolean => {
    const one: CellRect | null = a[layer];
    const two: CellRect | null = b[layer];
    if (one === null || two === null) return one === two;
    return one.c === two.c && one.r === two.r && one.w === two.w && one.h === two.h;
  });
}

function hasCells(cells: LayerCells): boolean {
  return GRID_LAYERS.some((layer: GridLayer): boolean => cells[layer] !== null);
}

/** A layout name: one line of 1 to LAYOUT_NAME_LENGTH characters, without spaces at its ends. */
export const layoutNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(LAYOUT_NAME_LENGTH)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);

const layoutId = z.string().min(1).max(64);

function storedOutputSchema(output: Orientation): z.ZodType<OutputLayouts, unknown> {
  const saved = z
    .object({ id: layoutId, name: z.string().max(LAYOUT_NAME_LENGTH).catch(""), cells: z.unknown() })
    .transform(
      (layout: { id: string; name: string; cells: unknown }): SavedLayout => ({
        id: layout.id,
        name: layout.name,
        cells: readCells(output, layout.cells),
      }),
    );
  return z
    .object({ active: layoutId.nullable().catch(null), saved: z.array(z.unknown()).catch([]) })
    .transform((value: { active: string | null; saved: unknown[] }): OutputLayouts => {
      const kept: SavedLayout[] = [];
      for (const item of value.saved) {
        const layout = saved.safeParse(item);
        // A layout that is not valid, or that has the ID of an earlier one, is not a layout.
        if (layout.success && !kept.some((other: SavedLayout): boolean => other.id === layout.data.id))
          kept.push(layout.data);
      }
      // The layout on stream must be one of the layouts.
      const active: string | null = kept.some((layout: SavedLayout): boolean => layout.id === value.active)
        ? value.active
        : null;
      return { active, saved: kept };
    })
    .catch({ active: null, saved: [] });
}

/**
 * The stored layouts. The read is lenient, as for the layers: a value that is not valid reads as no layouts, and
 * the page then shows the layout on stream as a layout that is not saved yet. Thus an old value never stops the page.
 */
export function parseStoredLayouts(raw: string): OverlayLayouts {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = {};
  }
  const record: Record<string, unknown> = typeof value === "object" && value !== null ? { ...value } : {};
  return {
    horizontal: storedOutputSchema("horizontal").parse(record.horizontal ?? {}),
    vertical: storedOutputSchema("vertical").parse(record.vertical ?? {}),
  };
}

/** The `layouts` JSON text to store. A layout keeps only the layers on its grid. */
export function storedLayoutsText(layouts: OverlayLayouts): string {
  const output = (value: OutputLayouts): unknown => ({
    active: value.active,
    saved: value.saved.map((layout: SavedLayout) => ({ ...layout, cells: storedCells(layout.cells) })),
  });
  return JSON.stringify({ horizontal: output(layouts.horizontal), vertical: output(layouts.vertical) });
}

/** One entry of the layout list of an output. */
export interface LayoutChoice {
  id: string;
  /** The preset of the entry, or null for a layout of the streamer. */
  preset: PresetKey | null;
  /** The name that the streamer gave. Empty for a preset and for the layout that is not saved yet. */
  name: string;
  /** True for a preset that the streamer changed. */
  changed: boolean;
  /** True for the layout on stream. */
  active: boolean;
}

/** The ID of the list entry for a layout on stream that is not saved yet. It is not a stored ID. */
export const UNSAVED_LAYOUT = "unsaved";

/** The layouts of one output for the list: the presets, then the layouts of the streamer. */
export function layoutChoices(layouts: OverlayLayouts, layers: OverlayLayers, output: Orientation): LayoutChoice[] {
  const { active, saved } = layouts[output];
  const live: LayerCells = layers.cells[output];
  const presets: LayoutChoice[] = outputPresets(output).map((key: PresetKey): LayoutChoice => {
    const id: string = presetId(key);
    const mine: SavedLayout | undefined = saved.find((layout: SavedLayout): boolean => layout.id === id);
    // The cells of the layout on stream are the cells of the grid.
    const cells: LayerCells | undefined = active === id ? live : mine?.cells;
    return {
      id,
      preset: key,
      name: "",
      changed: cells !== undefined && !sameCells(cells, presetCells(key)),
      active: active === id,
    };
  });
  const own: LayoutChoice[] = saved
    .filter((layout: SavedLayout): boolean => presetOf(layout.id) === null)
    .map(
      (layout: SavedLayout): LayoutChoice => ({
        id: layout.id,
        preset: null,
        name: layout.name,
        changed: false,
        active: active === layout.id,
      }),
    );
  const unsaved: LayoutChoice[] =
    active === null ? [{ id: UNSAVED_LAYOUT, preset: null, name: "", changed: false, active: true }] : [];
  return [...presets, ...unsaved, ...own];
}

export type LayoutProblem = "unknown" | "limit" | "active" | "preset" | "not_preset";

/** A layout action that the rules do not allow. The server gives its `problem` to the client. */
export class LayoutError extends Error {
  constructor(readonly problem: LayoutProblem) {
    super(`Layout action refused: ${problem}`);
  }
}

export interface LayoutState {
  layouts: OverlayLayouts;
  layers: OverlayLayers;
}

/** A new layout of the streamer: its ID and its name. */
export interface NewLayout {
  id: string;
  name: string;
}

function ownCount(output: OutputLayouts): number {
  return output.saved.filter((layout: SavedLayout): boolean => presetOf(layout.id) === null).length;
}

/**
 * The layouts with the cells of the grid kept in the layout on stream, before a different layout goes on stream.
 * A layout on stream that is not saved yet becomes the layout `keep` of the streamer, if it has a layer.
 */
function keptLive(state: LayoutState, output: Orientation, keep: NewLayout): OutputLayouts {
  const { active, saved } = state.layouts[output];
  const live: LayerCells = state.layers.cells[output];
  if (active !== null)
    return {
      active,
      saved: saved.map(
        (layout: SavedLayout): SavedLayout => (layout.id === active ? { ...layout, cells: live } : layout),
      ),
    };
  if (!hasCells(live)) return { active, saved };
  if (ownCount({ active, saved }) >= LAYOUT_LIMIT) throw new LayoutError("limit");
  return { active, saved: [...saved, { id: keep.id, name: keep.name, cells: live }] };
}

/**
 * `layers` with `cells` as the layout of `output`. A layer that was off the grid of the output and is on it now
 * also gets "Show on stream", as a layer does when the streamer adds it to the grid.
 */
function withLayout(layers: OverlayLayers, output: Orientation, cells: LayerCells): OverlayLayers {
  let next: OverlayLayers = { ...layers, cells: { ...layers.cells, [output]: cells } };
  for (const layer of GRID_LAYERS)
    if (cells[layer] !== null && layers.cells[output][layer] === null && !layerEnabled(next, layer))
      next = withEnabled(next, layer, true);
  return next;
}

/**
 * Puts the layout `id` of `output` on stream. `id` is a layout of the streamer or a preset. `keep` names the layout
 * on stream when it is not saved yet: it then becomes a layout of the streamer.
 */
export function selectLayout(state: LayoutState, output: Orientation, id: string, keep: NewLayout): LayoutState {
  const kept: OutputLayouts = keptLive(state, output, keep);
  if (kept.active === id) return state;
  const preset: PresetKey | null = presetOf(id);
  const mine: SavedLayout | undefined = kept.saved.find((layout: SavedLayout): boolean => layout.id === id);
  if (!mine && (preset === null || LAYOUT_PRESETS[preset].output !== output)) throw new LayoutError("unknown");
  const cells: LayerCells = mine?.cells ?? presetCells(preset as PresetKey);
  const saved: SavedLayout[] = mine ? kept.saved : [...kept.saved, { id, name: "", cells }];
  return {
    layouts: { ...state.layouts, [output]: { active: id, saved } },
    layers: withLayout(state.layers, output, cells),
  };
}

/**
 * Makes the layout `made` of the streamer and puts it on stream: an empty grid, or a copy of the layout on stream.
 * The layout on stream before it stays as it is.
 */
export function createLayout(
  state: LayoutState,
  output: Orientation,
  made: NewLayout,
  from: "empty" | "current",
  keep: NewLayout,
): LayoutState {
  const kept: OutputLayouts = keptLive(state, output, keep);
  if (ownCount(kept) >= LAYOUT_LIMIT) throw new LayoutError("limit");
  const cells: LayerCells = from === "empty" ? emptyCells() : state.layers.cells[output];
  return {
    layouts: { ...state.layouts, [output]: { active: made.id, saved: [...kept.saved, { ...made, cells }] } },
    layers: withLayout(state.layers, output, cells),
  };
}

/** Gives a layout of the streamer a new name. A preset keeps its name. */
export function renameLayout(layouts: OverlayLayouts, output: Orientation, id: string, name: string): OverlayLayouts {
  if (presetOf(id) !== null) throw new LayoutError("preset");
  const { active, saved } = layouts[output];
  if (!saved.some((layout: SavedLayout): boolean => layout.id === id)) throw new LayoutError("unknown");
  return {
    ...layouts,
    [output]: {
      active,
      saved: saved.map((layout: SavedLayout): SavedLayout => (layout.id === id ? { ...layout, name } : layout)),
    },
  };
}

/**
 * Deletes a layout that is not on stream. For a preset, this deletes the version of the streamer: the preset stays
 * in the list as it comes.
 */
export function deleteLayout(layouts: OverlayLayouts, output: Orientation, id: string): OverlayLayouts {
  const { active, saved } = layouts[output];
  if (!saved.some((layout: SavedLayout): boolean => layout.id === id)) throw new LayoutError("unknown");
  if (active === id) throw new LayoutError("active");
  return {
    ...layouts,
    [output]: { active, saved: saved.filter((layout: SavedLayout): boolean => layout.id !== id) },
  };
}

/** Brings the preset on stream back to the cells that it comes with. */
export function resetLayout(state: LayoutState, output: Orientation): LayoutState {
  const { active, saved } = state.layouts[output];
  const preset: PresetKey | null = active === null ? null : presetOf(active);
  if (preset === null) throw new LayoutError("not_preset");
  const cells: LayerCells = presetCells(preset);
  return {
    layouts: {
      ...state.layouts,
      [output]: {
        active,
        saved: saved.map((layout: SavedLayout): SavedLayout => (layout.id === active ? { ...layout, cells } : layout)),
      },
    },
    layers: withLayout(state.layers, output, cells),
  };
}
