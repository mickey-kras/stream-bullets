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

/** The values of `?layer=` on the OBS URL. `content` is all the content layers together. */
export const OVERLAY_LAYERS = ["content", "chat", "characters"] as const;
export type OverlayLayer = (typeof OVERLAY_LAYERS)[number];

/** The layers that show one content source each. The streamer places each layer on the grid at most once. */
export const CONTENT_LAYERS = ["poll", "topic", "next", "message", "card", "support"] as const;
export type ContentLayer = (typeof CONTENT_LAYERS)[number];

/** The layers on the grid, in the order the lenient read resolves them. */
export const GRID_LAYERS = ["chat", "characters", ...CONTENT_LAYERS] as const;
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

/** The cells of one orientation. A layer with null is not on the grid. */
export type LayerCells = Record<GridLayer, CellRect | null>;

export interface ChatLayer {
  enabled: boolean;
  hideCommands: boolean;
  /** Percent of the card background that shows behind each message (CHAT_BACKGROUND). */
  backgroundOpacity: number;
}

/** The card background opacity of a layer in percent: the one source for the layers, the editor and the overlay. */
export const LAYER_BACKGROUND = { min: 0, max: 100, step: 5, default: 100 } as const;
/** The message background opacity of the chat. */
export const CHAT_BACKGROUND = LAYER_BACKGROUND;

export interface CharactersLayer {
  enabled: boolean;
  /** Seconds without chat before a character walks out (CHARACTERS_TIMEOUT). */
  timeout: number;
}

/** The characters inactivity timeout in seconds: the one source for the layers, the editor and the playground. */
export const CHARACTERS_TIMEOUT = { min: 10, max: 600, default: 60 } as const;

/** The settings of one content layer. */
export interface ContentItem {
  enabled: boolean;
  /** The poll, topic or card to show. Null: the latest active poll, or the first card. Other layers have null. */
  ref: string | null;
  /** Percent of the card background that shows (LAYER_BACKGROUND). */
  backgroundOpacity: number;
  /** The card shows a QR code of the public page of its item. The message banner never shows one. */
  qr: boolean;
}

/** The content layers that use `ref`. */
export const REF_LAYERS: ReadonlySet<ContentLayer> = new Set<ContentLayer>(["poll", "topic", "card"]);

export interface OverlayLayers {
  orientation: Orientation;
  chat: ChatLayer;
  characters: CharactersLayer;
  items: Record<ContentLayer, ContentItem>;
  cells: Record<Orientation, LayerCells>;
}

export type CellsPatch = Partial<LayerCells>;

export interface LayersPatch {
  orientation?: Orientation;
  chat?: Partial<ChatLayer>;
  characters?: Partial<CharactersLayer>;
  items?: Partial<Record<ContentLayer, Partial<ContentItem>>>;
  cells?: Partial<Record<Orientation, CellsPatch>>;
}

const CONTENT_MIN = { w: 4, h: 2 } as const;

export const MIN_CELLS: Readonly<Record<GridLayer, Readonly<{ w: number; h: number }>>> = {
  chat: { w: 3, h: 2 },
  characters: { w: 6, h: 2 },
  poll: CONTENT_MIN,
  topic: CONTENT_MIN,
  next: CONTENT_MIN,
  message: CONTENT_MIN,
  card: CONTENT_MIN,
  support: CONTENT_MIN,
};

/** One value for each content layer. */
function contentRecord<T>(value: (layer: ContentLayer) => T): Record<ContentLayer, T> {
  return {
    poll: value("poll"),
    topic: value("topic"),
    next: value("next"),
    message: value("message"),
    card: value("card"),
    support: value("support"),
  };
}

/** The cells of an orientation with no layer on the grid. */
export function emptyCells(): LayerCells {
  return { chat: null, characters: null, ...contentRecord((): null => null) };
}

function defaultItem(layer: ContentLayer): ContentItem {
  return { enabled: true, ref: null, backgroundOpacity: LAYER_BACKGROUND.default, qr: layer === "poll" };
}

// No layer has a cell by default. A layer shows on stream when it is enabled and has a cell in the selected
// orientation. Chat and characters are off until the streamer puts them on the grid.
export const DEFAULT_LAYERS: OverlayLayers = {
  orientation: "horizontal",
  chat: { enabled: false, hideCommands: true, backgroundOpacity: CHAT_BACKGROUND.default },
  characters: { enabled: false, timeout: CHARACTERS_TIMEOUT.default },
  items: contentRecord(defaultItem),
  cells: {
    horizontal: emptyCells(),
    vertical: emptyCells(),
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

/** The design-pixel place of a layer in the selected orientation. Null for a layer without a cell. */
export function layerPixels(layers: OverlayLayers, layer: GridLayer): LayerRect | null {
  const rect: CellRect | null = layers.cells[layers.orientation][layer];
  return rect ? cellPixels(rect) : null;
}

/** What a content layer shows. A poll layer without a ref shows the latest active poll: the "auto" source. */
export interface ContentSource {
  type: ContentLayer | "auto";
  ref: string | null;
}

/** A content layer on stream: it has a cell in the selected orientation and it is enabled. */
export interface PlacedContent {
  layer: ContentLayer;
  rect: CellRect;
  item: ContentItem;
  source: ContentSource;
}

/** The "Show on stream" setting of a layer. */
export function layerEnabled(layers: OverlayLayers, layer: GridLayer): boolean {
  return layer === "chat" || layer === "characters" ? layers[layer].enabled : layers.items[layer].enabled;
}

/** True when `layer` shows on stream: it is enabled and has a cell in the selected orientation. */
export function onStream(layers: OverlayLayers, layer: GridLayer): boolean {
  return layerEnabled(layers, layer) && layers.cells[layers.orientation][layer] !== null;
}

/** The content layers on stream, in the order of CONTENT_LAYERS. */
export function placedContent(layers: OverlayLayers): PlacedContent[] {
  const cells: LayerCells = layers.cells[layers.orientation];
  return CONTENT_LAYERS.flatMap((layer: ContentLayer): PlacedContent[] => {
    const rect: CellRect | null = cells[layer];
    const item: ContentItem = layers.items[layer];
    if (!rect || !item.enabled) return [];
    const auto: boolean = layer === "poll" && item.ref === null;
    return [{ layer, rect, item, source: { type: auto ? "auto" : layer, ref: item.ref } }];
  });
}

/** The sources of the content layers on stream. */
export function contentSources(layers: OverlayLayers): ContentSource[] {
  return placedContent(layers).map((placed: PlacedContent): ContentSource => placed.source);
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
      chat: cellSchema(orientation, "chat").nullable().optional(),
      characters: cellSchema(orientation, "characters").nullable().optional(),
      ...contentRecord((layer: ContentLayer) => cellSchema(orientation, layer).nullable().optional()),
    })
    .strict()
    .refine((cells: CellsPatch): boolean => overlappingPair(cells) === null, { message: "Layers must not overlap." });
}

const characterTimeout = z.number().int().min(CHARACTERS_TIMEOUT.min).max(CHARACTERS_TIMEOUT.max);
const layerBackground = z
  .number()
  .int()
  .min(LAYER_BACKGROUND.min)
  .max(LAYER_BACKGROUND.max)
  .multipleOf(LAYER_BACKGROUND.step);

/** The `ref` of a content layer. The length limit matches `overlaySourceSchema`. Layers without a ref take null only. */
function refSchema(layer: ContentLayer): z.ZodType<string | null> {
  return REF_LAYERS.has(layer) ? z.string().min(1).max(64).nullable() : z.null();
}

function itemPatchSchema(layer: ContentLayer): z.ZodOptional<z.ZodType<Partial<ContentItem>>> {
  const item: z.ZodType<Partial<ContentItem>> = z
    .object({
      enabled: z.boolean().optional(),
      ref: refSchema(layer).optional(),
      backgroundOpacity: layerBackground.optional(),
      qr: z.boolean().optional(),
    })
    .strict();
  return item.optional();
}

// Writes are strict: unknown keys, cells outside the grid, below the minimum size or over each other return 400.
// A ref on a content layer that has none also returns 400.
// The server also checks the merged layout, so a cell never covers a saved cell of another layer.
export const layersPatchSchema = z
  .object({
    orientation: z.enum(ORIENTATIONS).optional(),
    chat: z
      .object({
        enabled: z.boolean().optional(),
        hideCommands: z.boolean().optional(),
        backgroundOpacity: layerBackground.optional(),
      })
      .strict()
      .optional(),
    characters: z.object({ enabled: z.boolean().optional(), timeout: characterTimeout.optional() }).strict().optional(),
    items: z.object(contentRecord(itemPatchSchema)).strict().optional(),
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
export function readCell(orientation: Orientation, layer: GridLayer, value: unknown): CellRect | null {
  const parsed = storedCell.safeParse(value);
  return parsed.success && cellFits(orientation, layer, parsed.data) ? copyCell(parsed.data) : null;
}

/**
 * A stored layout. A cell that is invalid reads as no cell. The same applies when it overlaps a layer earlier in
 * GRID_LAYERS.
 */
function readCells(orientation: Orientation, value: unknown): LayerCells {
  const raw: Record<string, unknown> = typeof value === "object" && value !== null ? { ...value } : {};
  const kept: CellRect[] = [];
  const free = (layer: GridLayer): CellRect | null => {
    const rect: CellRect | null = readCell(orientation, layer, raw[layer]);
    if (rect === null || kept.some((other: CellRect): boolean => cellsOverlap(rect, other))) return null;
    kept.push(rect);
    return rect;
  };
  // In the order of GRID_LAYERS.
  const chat: CellRect | null = free("chat");
  const characters: CellRect | null = free("characters");
  return { chat, characters, ...contentRecord(free) };
}

function defaultItems(): Record<ContentLayer, ContentItem> {
  return contentRecord((layer: ContentLayer): ContentItem => ({ ...DEFAULT_LAYERS.items[layer] }));
}

/** A stored content layer. An invalid field reads as its default. */
function storedItemSchema(layer: ContentLayer): z.ZodType<ContentItem, unknown> {
  const item: ContentItem = DEFAULT_LAYERS.items[layer];
  return fallback(
    z.object({
      enabled: fallback(z.boolean(), item.enabled),
      ref: fallback(refSchema(layer), item.ref),
      backgroundOpacity: fallback(layerBackground, item.backgroundOpacity),
      qr: fallback(z.boolean(), item.qr),
    }),
    (): ContentItem => ({ ...item }),
  );
}

// Stored and broadcast layers. This schema never throws: older and newer versions must not break the overlay.
// Missing keys take defaults, so `{}` reads as DEFAULT_LAYERS. Unknown keys are dropped. An invalid field reads as
// its default (see readCells for the cells). Unknown keys include `v`: this schema reads the current version, and
// app/lib/overlay-legacy.ts converts an older text first. Writes use the strict layersPatchSchema.
export const storedLayersSchema: z.ZodType<OverlayLayers, unknown> = fallback(
  z.object({
    orientation: fallback(z.enum(ORIENTATIONS), DEFAULT_LAYERS.orientation),
    chat: fallback(
      z.object({
        enabled: fallback(z.boolean(), DEFAULT_LAYERS.chat.enabled),
        hideCommands: fallback(z.boolean(), DEFAULT_LAYERS.chat.hideCommands),
        backgroundOpacity: fallback(layerBackground, DEFAULT_LAYERS.chat.backgroundOpacity),
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
    items: fallback(z.object(contentRecord(storedItemSchema)), defaultItems),
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
    items: defaultItems(),
    cells: { horizontal: emptyCells(), vertical: emptyCells() },
  }),
);

/**
 * The version of the stored `layers` JSON text that storedLayersText writes (`v`). A text without this version is
 * from before the overlay studio: see app/lib/overlay-legacy.ts.
 */
export const LAYERS_VERSION = 2;

// Match `overlay_state_layers_check`.
export const STORED_LAYERS_LENGTH = 4000;

function storedCells(cells: LayerCells): CellsPatch {
  const stored: CellsPatch = {};
  for (const layer of GRID_LAYERS) {
    const rect: CellRect | null = cells[layer];
    if (rect) stored[layer] = rect;
  }
  return stored;
}

function storedItem(layer: ContentLayer, item: ContentItem): Partial<ContentItem> {
  const usual: ContentItem = DEFAULT_LAYERS.items[layer];
  const stored: Partial<ContentItem> = {};
  if (item.enabled !== usual.enabled) stored.enabled = item.enabled;
  if (item.ref !== usual.ref) stored.ref = item.ref;
  if (item.backgroundOpacity !== usual.backgroundOpacity) stored.backgroundOpacity = item.backgroundOpacity;
  if (item.qr !== usual.qr) stored.qr = item.qr;
  return stored;
}

/**
 * The `layers` JSON text to store. It leaves out what the lenient read fills in: a layer without a cell and each
 * content layer setting at its default. Thus the text stays short. The caller checks it against
 * STORED_LAYERS_LENGTH.
 */
export function storedLayersText(layers: OverlayLayers): string {
  const items: LayersPatch["items"] = {};
  for (const layer of CONTENT_LAYERS) {
    const stored: Partial<ContentItem> = storedItem(layer, layers.items[layer]);
    if (Object.keys(stored).length > 0) items[layer] = stored;
  }
  return JSON.stringify({
    v: LAYERS_VERSION,
    orientation: layers.orientation,
    chat: layers.chat,
    characters: layers.characters,
    items: Object.keys(items).length > 0 ? items : undefined,
    cells: { horizontal: storedCells(layers.cells.horizontal), vertical: storedCells(layers.cells.vertical) },
  });
}

function mergeCells(current: LayerCells, patch: CellsPatch | undefined): LayerCells {
  const merged = (layer: GridLayer): CellRect | null => {
    const next: CellRect | null | undefined = patch?.[layer];
    const rect: CellRect | null = next === undefined ? current[layer] : next;
    return rect ? copyCell(rect) : null;
  };
  return { chat: merged("chat"), characters: merged("characters"), ...contentRecord(merged) };
}

function mergeItem(current: ContentItem, patch: Partial<ContentItem> | undefined): ContentItem {
  return {
    enabled: patch?.enabled ?? current.enabled,
    ref: patch?.ref === undefined ? current.ref : patch.ref,
    backgroundOpacity: patch?.backgroundOpacity ?? current.backgroundOpacity,
    qr: patch?.qr ?? current.qr,
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
    items: contentRecord((layer: ContentLayer): ContentItem => mergeItem(current.items[layer], patch.items?.[layer])),
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
