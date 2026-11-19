import { catch as fallback, z } from "zod";

// Overlay layers sit on a grid of square cells. The streamer picks the orientation of the frame: horizontal is
// 1920x1080 (16 x 9 cells), vertical is 1080x1920 (9 x 16 cells). Each orientation keeps its own layout.
export const CELL_PX = 120;

export const ORIENTATIONS = ["horizontal", "vertical"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export const GRID: Readonly<Record<Orientation, Readonly<{ cols: number; rows: number }>>> = {
  horizontal: { cols: 16, rows: 9 },
  vertical: { cols: 9, rows: 16 },
};

export const OVERLAY_LAYERS = ["content", "chat", "characters"] as const;
export type OverlayLayer = (typeof OVERLAY_LAYERS)[number];

/** The layers on the grid, in the order the lenient read resolves them. */
export const GRID_LAYERS = ["chat", "characters", "content"] as const;
export type GridLayer = (typeof GRID_LAYERS)[number];

/** A place in whole cells: column, row, width and height. `c + w <= cols` and `r + h <= rows`. */
export interface CellRect {
  c: number;
  r: number;
  w: number;
  h: number;
}

/** A place in design pixels. */
export interface LayerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The cells of one orientation. Content null: it fills the whole frame and keeps its position and size settings. */
export interface LayerCells {
  chat: CellRect;
  characters: CellRect;
  content: CellRect | null;
}

export interface ChatLayer {
  enabled: boolean;
  hideCommands: boolean;
  /** Percent of the card background that shows behind each message (CHAT_BACKGROUND). */
  backgroundOpacity: number;
}

/** The message background opacity in percent: the one source for the layers, the editor and the chat. */
export const CHAT_BACKGROUND = { min: 0, max: 100, step: 5, default: 100 } as const;

export interface CharactersLayer {
  enabled: boolean;
  /** Seconds without chat before a character walks out (CHARACTERS_TIMEOUT). */
  timeout: number;
}

/** The characters inactivity timeout in seconds: the one source for the layers, the editor and the playground. */
export const CHARACTERS_TIMEOUT = { min: 10, max: 600, default: 60 } as const;

export interface OverlayLayers {
  orientation: Orientation;
  chat: ChatLayer;
  characters: CharactersLayer;
  cells: Record<Orientation, LayerCells>;
}

export type CellsPatch = Partial<LayerCells>;

export interface LayersPatch {
  orientation?: Orientation;
  chat?: Partial<ChatLayer>;
  characters?: Partial<CharactersLayer>;
  cells?: Partial<Record<Orientation, CellsPatch>>;
}

export const MIN_CELLS: Readonly<Record<GridLayer, Readonly<{ w: number; h: number }>>> = {
  chat: { w: 3, h: 2 },
  characters: { w: 6, h: 2 },
  content: { w: 4, h: 2 },
};

// Chat and characters stay off by default, so existing OBS scenes do not change. Content has no cell by default.
export const DEFAULT_LAYERS: OverlayLayers = {
  orientation: "horizontal",
  chat: { enabled: false, hideCommands: true, backgroundOpacity: CHAT_BACKGROUND.default },
  characters: { enabled: false, timeout: CHARACTERS_TIMEOUT.default },
  cells: {
    horizontal: { chat: { c: 0, r: 0, w: 5, h: 7 }, characters: { c: 0, r: 7, w: 16, h: 2 }, content: null },
    vertical: { chat: { c: 0, r: 8, w: 9, h: 5 }, characters: { c: 0, r: 13, w: 9, h: 3 }, content: null },
  },
};

/** The design size of a frame. */
export function frameSize(orientation: Orientation): { w: number; h: number } {
  return { w: GRID[orientation].cols * CELL_PX, h: GRID[orientation].rows * CELL_PX };
}

export function cellPixels(rect: CellRect): LayerRect {
  return { x: rect.c * CELL_PX, y: rect.r * CELL_PX, w: rect.w * CELL_PX, h: rect.h * CELL_PX };
}

export function copyCell(rect: CellRect): CellRect {
  return { c: rect.c, r: rect.r, w: rect.w, h: rect.h };
}

export function cellsOverlap(a: CellRect, b: CellRect): boolean {
  return a.c < b.c + b.w && b.c < a.c + a.w && a.r < b.r + b.h && b.r < a.r + a.h;
}

/** Inside the grid of `orientation` and at least the minimum size of `layer`. */
export function cellFits(orientation: Orientation, layer: GridLayer, rect: CellRect): boolean {
  const { cols, rows } = GRID[orientation];
  const min = MIN_CELLS[layer];
  return rect.c + rect.w <= cols && rect.r + rect.h <= rows && rect.w >= min.w && rect.h >= min.h;
}

/** The first pair of placed layers that overlap, or null. */
export function overlappingPair(cells: Partial<LayerCells>): [GridLayer, GridLayer] | null {
  const placed = GRID_LAYERS.flatMap((layer: GridLayer): [GridLayer, CellRect][] => {
    const rect: CellRect | null | undefined = cells[layer];
    return rect ? [[layer, rect]] : [];
  });
  for (let i = 0; i < placed.length; i += 1)
    for (let j = i + 1; j < placed.length; j += 1)
      if (cellsOverlap(placed[i][1], placed[j][1])) return [placed[i][0], placed[j][0]];
  return null;
}

/** The design-pixel place of a layer in the selected orientation. Null for content without a cell. */
export function layerPixels(layers: OverlayLayers, layer: GridLayer): LayerRect | null {
  const rect: CellRect | null = layers.cells[layers.orientation][layer];
  return rect ? cellPixels(rect) : null;
}

const cellShape = {
  c: z.number().int().nonnegative(),
  r: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
};

function cellSchema(orientation: Orientation, layer: GridLayer): z.ZodType<CellRect> {
  const min = MIN_CELLS[layer];
  return z
    .object(cellShape)
    .strict()
    .refine((rect: CellRect): boolean => cellFits(orientation, layer, rect), {
      message: `Keep the layer inside the ${GRID[orientation].cols}x${GRID[orientation].rows} grid, at least ${min.w}x${min.h} cells.`,
    });
}

function cellsPatchSchema(orientation: Orientation): z.ZodType<CellsPatch> {
  return z
    .object({
      chat: cellSchema(orientation, "chat").optional(),
      characters: cellSchema(orientation, "characters").optional(),
      content: cellSchema(orientation, "content").nullable().optional(),
    })
    .strict()
    .refine((cells: CellsPatch): boolean => overlappingPair(cells) === null, { message: "Layers must not overlap." });
}

const characterTimeout = z.number().int().min(CHARACTERS_TIMEOUT.min).max(CHARACTERS_TIMEOUT.max);
const chatBackground = z
  .number()
  .int()
  .min(CHAT_BACKGROUND.min)
  .max(CHAT_BACKGROUND.max)
  .multipleOf(CHAT_BACKGROUND.step);

// Writes are strict: unknown keys, cells outside the grid, below the minimum size or over each other return 400.
// The server also checks the merged layout, so a cell never covers a saved cell of another layer.
export const layersPatchSchema = z
  .object({
    orientation: z.enum(ORIENTATIONS).optional(),
    chat: z
      .object({
        enabled: z.boolean().optional(),
        hideCommands: z.boolean().optional(),
        backgroundOpacity: chatBackground.optional(),
      })
      .strict()
      .optional(),
    characters: z.object({ enabled: z.boolean().optional(), timeout: characterTimeout.optional() }).strict().optional(),
    cells: z
      .object({
        horizontal: cellsPatchSchema("horizontal").optional(),
        vertical: cellsPatchSchema("vertical").optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const storedCell = z.object(cellShape);

/** A stored cell of `layer`, or null when it is not a valid cell of this grid. */
function readCell(orientation: Orientation, layer: GridLayer, value: unknown): CellRect | null {
  const parsed = storedCell.safeParse(value);
  return parsed.success && cellFits(orientation, layer, parsed.data) ? copyCell(parsed.data) : null;
}

function defaultCells(orientation: Orientation): LayerCells {
  const cells: LayerCells = DEFAULT_LAYERS.cells[orientation];
  return { chat: copyCell(cells.chat), characters: copyCell(cells.characters), content: null };
}

/**
 * A stored layout. An invalid chat or characters cell takes its default. When the chat and characters cells overlap,
 * both take their defaults. A content cell that is invalid or overlaps another layer reads as no cell.
 */
function readCells(orientation: Orientation, value: unknown): LayerCells {
  const raw: Record<string, unknown> = typeof value === "object" && value !== null ? { ...value } : {};
  const fallback: LayerCells = defaultCells(orientation);
  let chat: CellRect = readCell(orientation, "chat", raw.chat) ?? fallback.chat;
  let characters: CellRect = readCell(orientation, "characters", raw.characters) ?? fallback.characters;
  if (cellsOverlap(chat, characters)) {
    chat = fallback.chat;
    characters = fallback.characters;
  }
  const content: CellRect | null = readCell(orientation, "content", raw.content);
  const free: boolean = content !== null && !cellsOverlap(content, chat) && !cellsOverlap(content, characters);
  return { chat, characters, content: free ? content : null };
}

// Stored and broadcast layers. This schema never throws: older and newer versions must not break the overlay.
// Missing keys take defaults, so `{}` reads as DEFAULT_LAYERS. Unknown keys are dropped. An invalid field reads as
// its default (see readCells for the cells). Writes use the strict layersPatchSchema.
export const storedLayersSchema: z.ZodType<OverlayLayers, unknown> = fallback(
  z.object({
    orientation: fallback(z.enum(ORIENTATIONS), DEFAULT_LAYERS.orientation),
    chat: fallback(
      z.object({
        enabled: fallback(z.boolean(), DEFAULT_LAYERS.chat.enabled),
        hideCommands: fallback(z.boolean(), DEFAULT_LAYERS.chat.hideCommands),
        backgroundOpacity: fallback(chatBackground, DEFAULT_LAYERS.chat.backgroundOpacity),
      }),
      (): ChatLayer => ({ ...DEFAULT_LAYERS.chat }),
    ),
    characters: fallback(
      z.object({
        enabled: fallback(z.boolean(), DEFAULT_LAYERS.characters.enabled),
        timeout: fallback(characterTimeout, DEFAULT_LAYERS.characters.timeout),
      }),
      (): CharactersLayer => ({ ...DEFAULT_LAYERS.characters }),
    ),
    cells: fallback(z.object({ horizontal: z.unknown().optional(), vertical: z.unknown().optional() }), {
      horizontal: undefined,
      vertical: undefined,
    }).transform(
      (cells: { horizontal?: unknown; vertical?: unknown }): Record<Orientation, LayerCells> => ({
        horizontal: readCells("horizontal", cells.horizontal),
        vertical: readCells("vertical", cells.vertical),
      }),
    ),
  }),
  (): OverlayLayers => ({
    orientation: DEFAULT_LAYERS.orientation,
    chat: { ...DEFAULT_LAYERS.chat },
    characters: { ...DEFAULT_LAYERS.characters },
    cells: { horizontal: defaultCells("horizontal"), vertical: defaultCells("vertical") },
  }),
);

// Reads a stored `layers` JSON text. Invalid JSON reads as the defaults, the same as an invalid value.
export function parseStoredLayers(raw: string): OverlayLayers {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  return storedLayersSchema.parse(value);
}

function mergeCells(current: LayerCells, patch: CellsPatch | undefined): LayerCells {
  const content: CellRect | null = patch?.content === undefined ? current.content : patch.content;
  return {
    chat: copyCell(patch?.chat ?? current.chat),
    characters: copyCell(patch?.characters ?? current.characters),
    content: content ? copyCell(content) : null,
  };
}

export function mergeLayers(current: OverlayLayers, patch: LayersPatch): OverlayLayers {
  return {
    orientation: patch.orientation ?? current.orientation,
    chat: {
      enabled: patch.chat?.enabled ?? current.chat.enabled,
      hideCommands: patch.chat?.hideCommands ?? current.chat.hideCommands,
      backgroundOpacity: patch.chat?.backgroundOpacity ?? current.chat.backgroundOpacity,
    },
    characters: {
      enabled: patch.characters?.enabled ?? current.characters.enabled,
      timeout: patch.characters?.timeout ?? current.characters.timeout,
    },
    cells: {
      horizontal: mergeCells(current.cells.horizontal, patch.cells?.horizontal),
      vertical: mergeCells(current.cells.vertical, patch.cells?.vertical),
    },
  };
}

// `?layer=`: null renders the whole composition; "unknown" renders an empty page.
export function parseLayerParam(value: string | null): OverlayLayer | null | "unknown" {
  if (value === null) return null;
  const layer: OverlayLayer | undefined = OVERLAY_LAYERS.find((name: OverlayLayer): boolean => name === value);
  return layer ?? "unknown";
}

// Adds, replaces, or (for null) removes `layer` and keeps the other query parameters, such as `key`.
export function layerUrl(overlayUrl: string, layer: OverlayLayer | null): string {
  const absolute: boolean = /^[a-z][a-z\d+.-]*:/i.test(overlayUrl);
  const base = "https://overlay.invalid";
  const url = new URL(overlayUrl, base);
  if (layer === null) url.searchParams.delete("layer");
  else url.searchParams.set("layer", layer);
  return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}
