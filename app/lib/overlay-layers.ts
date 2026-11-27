import { catch as fallback, z } from "zod";
import {
  ALERT_MIN,
  ALERT_RULES,
  DEFAULT_RULES,
  hasThreshold,
  ruleRecord,
  type AlertRule,
  type AlertRuleId,
  type AlertRules,
} from "./alerts";
import { GOAL_COUNTS, GOAL_TARGET, GOAL_TITLE_LENGTH, type GoalCount } from "./goals";

// Overlay layers sit on a grid of square cells. The streamer picks the orientation of the frame: horizontal is
// 1920x1080 (32 x 18 cells), vertical is 1080x1920 (18 x 32 cells). Each orientation keeps its own layout.
export const CELL_PX = 60;

export const ORIENTATIONS = ["horizontal", "vertical"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export const GRID: Readonly<Record<Orientation, Readonly<{ cols: number; rows: number }>>> = {
  horizontal: { cols: 32, rows: 18 },
  vertical: { cols: 18, rows: 32 },
};

/** The values of `?layer=` on the OBS URL. `content` is all the content layers together. */
export const OVERLAY_LAYERS = ["content", "chat", "characters"] as const;
export type OverlayLayer = (typeof OVERLAY_LAYERS)[number];

/** The layers that show one content source each. The streamer places each layer on the grid at most once. */
export const CONTENT_LAYERS = ["poll", "topic", "next", "message", "card", "support"] as const;
export type ContentLayer = (typeof CONTENT_LAYERS)[number];

/**
 * The layers on the grid, in the order the lenient read resolves them. A new layer goes to the end: then a stored
 * layout keeps the cells that it has.
 */
export const GRID_LAYERS = ["chat", "characters", ...CONTENT_LAYERS, "camera", "alerts", "goal"] as const;
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
  /** The most characters on screen at one time (CHARACTERS_MAX). */
  max: number;
}

/** The characters inactivity timeout in seconds: the one source for the layers, the editor and the playground. */
export const CHARACTERS_TIMEOUT = { min: 10, max: 600, default: 60 } as const;
/**
 * The most characters on screen: the one source for the layers, the editor and the playground. The upper limit
 * equals FRAME_CHARS_MAX in app/lib/playground/protocol.ts.
 */
export const CHARACTERS_MAX = { min: 5, max: 40, default: 40 } as const;

/**
 * The camera frame: a frame with a clear window. The camera is a source of its own in OBS, under the overlay source
 * and as large as the window. The overlay never reads the camera.
 */
export interface CameraLayer {
  enabled: boolean;
}

/** The alerts layer: the banner of the alert on stream. The rules tell what each support event does (alerts.ts). */
export interface AlertsLayer {
  enabled: boolean;
  rules: AlertRules;
}

/** The goal layer: one count that goes up to a target (goals.ts). The server holds the count. */
export interface GoalLayer {
  enabled: boolean;
  /** The title on stream: one line of at most GOAL_TITLE_LENGTH characters. Empty: the layer shows no title. */
  title: string;
  /** What the goal counts. */
  counts: GoalCount;
  /** The value where the goal is complete (GOAL_TARGET). */
  target: number;
}

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

/** True for a layer that shows a content source: its settings are in `items`. */
export function isContentLayer(layer: GridLayer): layer is ContentLayer {
  const content: readonly string[] = CONTENT_LAYERS;
  return content.includes(layer);
}

/** The content layers that use `ref`. */
export const REF_LAYERS: ReadonlySet<ContentLayer> = new Set<ContentLayer>(["poll", "topic", "card"]);

export interface OverlayLayers {
  orientation: Orientation;
  chat: ChatLayer;
  characters: CharactersLayer;
  camera: CameraLayer;
  alerts: AlertsLayer;
  goal: GoalLayer;
  items: Record<ContentLayer, ContentItem>;
  cells: Record<Orientation, LayerCells>;
  /**
   * For each output: true when the output shows chat and characters from Twitch only. The default is the merged
   * chat of all platforms. See `shownPlatform`.
   */
  twitchOnly: Record<Orientation, boolean>;
}

export type CellsPatch = Partial<LayerCells>;

/** The changed fields of the rules: each field of each rule is one field of a patch. */
export type RulesPatch = Partial<Record<AlertRuleId, Partial<AlertRule>>>;

/** The fields of a rule and of the goal layer that a patch can name. */
export const RULE_FIELDS = ["min", "banner", "chat", "character"] as const;
export const GOAL_FIELDS = ["enabled", "title", "counts", "target"] as const;

export interface LayersPatch {
  orientation?: Orientation;
  chat?: Partial<ChatLayer>;
  characters?: Partial<CharactersLayer>;
  camera?: Partial<CameraLayer>;
  alerts?: { enabled?: boolean; rules?: RulesPatch };
  goal?: Partial<GoalLayer>;
  items?: Partial<Record<ContentLayer, Partial<ContentItem>>>;
  twitchOnly?: Partial<Record<Orientation, boolean>>;
  cells?: Partial<Record<Orientation, CellsPatch>>;
}

const CONTENT_MIN = { w: 8, h: 4 } as const;

export const MIN_CELLS: Readonly<Record<GridLayer, Readonly<{ w: number; h: number }>>> = {
  chat: { w: 6, h: 4 },
  characters: { w: 12, h: 4 },
  poll: CONTENT_MIN,
  topic: CONTENT_MIN,
  next: CONTENT_MIN,
  message: CONTENT_MIN,
  card: CONTENT_MIN,
  support: CONTENT_MIN,
  // The window of the smallest frame still holds a face: 360 x 240 design pixels with the frame around it.
  camera: { w: 6, h: 4 },
  // A banner of one alert, and a title with a progress bar: lower than a content card.
  alerts: { w: 8, h: 3 },
  goal: { w: 8, h: 2 },
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
  return { chat: null, characters: null, ...contentRecord((): null => null), camera: null, alerts: null, goal: null };
}

function defaultItem(layer: ContentLayer): ContentItem {
  return { enabled: true, ref: null, backgroundOpacity: LAYER_BACKGROUND.default, qr: layer === "poll" };
}

/** The rules of a page that changed none, as a new object. */
function defaultRules(): AlertRules {
  return ruleRecord((rule: AlertRuleId): AlertRule => ({ ...DEFAULT_RULES[rule] }));
}

// No layer has a cell by default. A layer shows on stream when it is enabled and has a cell in the selected
// orientation. The chat, the characters, the camera frame, the alerts and the goal are off until the streamer puts
// them on the grid.
export const DEFAULT_LAYERS: OverlayLayers = {
  orientation: "horizontal",
  chat: { enabled: false, hideCommands: true, backgroundOpacity: CHAT_BACKGROUND.default },
  characters: { enabled: false, timeout: CHARACTERS_TIMEOUT.default, max: CHARACTERS_MAX.default },
  camera: { enabled: false },
  alerts: { enabled: false, rules: defaultRules() },
  goal: { enabled: false, title: "", counts: "subs", target: GOAL_TARGET.default },
  items: contentRecord(defaultItem),
  cells: {
    horizontal: emptyCells(),
    vertical: emptyCells(),
  },
  twitchOnly: { horizontal: false, vertical: false },
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
  return isContentLayer(layer) ? layers.items[layer].enabled : layers[layer].enabled;
}

/**
 * True when `layer` shows in the output `layers.orientation`: it is enabled and has a cell there. The two outputs,
 * horizontal and vertical, are on stream at the same time: see `forOutput` and `onAnyOutput`.
 */
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

/**
 * `layers` as one output shows them. Each output has its own OBS link, and the two are on stream at the same time.
 * `orientation` is only the output that the editor shows, so an overlay page replaces it with its own output.
 */
export function forOutput(layers: OverlayLayers, output: Orientation): OverlayLayers {
  return layers.orientation === output ? layers : { ...layers, orientation: output };
}

/** True when `layer` shows in one output or in the two: it is enabled and has a cell in an orientation. */
export function onAnyOutput(layers: OverlayLayers, layer: GridLayer): boolean {
  return ORIENTATIONS.some((output: Orientation): boolean => onStream(forOutput(layers, output), layer));
}

/** The sources of the content layers on stream in the two outputs. A layer has the same source in each output. */
export function allContentSources(layers: OverlayLayers): ContentSource[] {
  const sources = new Map<ContentLayer, ContentSource>();
  for (const output of ORIENTATIONS)
    for (const placed of placedContent(forOutput(layers, output))) sources.set(placed.layer, placed.source);
  return [...sources.values()];
}

/**
 * The one platform whose chat and characters the output `layers.orientation` shows, or null for all platforms. The
 * Twitch rules for a simulcast do not allow chat of other platforms on the Twitch stream, so the owner can limit an
 * output to Twitch. Polls, topics, and the message banner do not change.
 */
export function shownPlatform(layers: OverlayLayers): "twitch" | null {
  return layers.twitchOnly[layers.orientation] ? "twitch" : null;
}

/**
 * The cell that gives the character playground its size. One playground serves the two outputs: it takes the
 * horizontal cell, or the vertical cell when the layer is not on the horizontal grid. The other output shows the
 * same playground, made smaller to fit its cell.
 */
export function playgroundCell(layers: OverlayLayers): CellRect | null {
  return layers.cells.horizontal.characters ?? layers.cells.vertical.characters;
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
      camera: cellSchema(orientation, "camera").nullable().optional(),
      alerts: cellSchema(orientation, "alerts").nullable().optional(),
      goal: cellSchema(orientation, "goal").nullable().optional(),
    })
    .strict()
    .refine((cells: CellsPatch): boolean => overlappingPair(cells) === null, { message: "Layers must not overlap." });
}

const characterTimeout = z.number().int().min(CHARACTERS_TIMEOUT.min).max(CHARACTERS_TIMEOUT.max);
const characterMax = z.number().int().min(CHARACTERS_MAX.min).max(CHARACTERS_MAX.max);
const layerBackground = z
  .number()
  .int()
  .min(LAYER_BACKGROUND.min)
  .max(LAYER_BACKGROUND.max)
  .multipleOf(LAYER_BACKGROUND.step);

const alertMin = z.number().int().min(ALERT_MIN.min).max(ALERT_MIN.max);
const goalTitle = z
  .string()
  .max(GOAL_TITLE_LENGTH)
  .regex(/^[^\p{Cc}]*$/u, "Use a single line.");
const goalCounts = z.enum(GOAL_COUNTS);
const goalTarget = z.number().int().min(GOAL_TARGET.min).max(GOAL_TARGET.max);

/** The patch of one rule. Only a rule with an amount (THRESHOLD_RULES) takes `min`: each other rule refuses it. */
function rulePatchSchema(rule: AlertRuleId): z.ZodOptional<z.ZodType<Partial<AlertRule>>> {
  const switches = { banner: z.boolean().optional(), chat: z.boolean().optional(), character: z.boolean().optional() };
  const patch: z.ZodType<Partial<AlertRule>> = hasThreshold(rule)
    ? z.object({ min: alertMin.optional(), ...switches }).strict()
    : z.object(switches).strict();
  return patch.optional();
}

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
// A ref on a content layer that has none also returns 400, and so does an amount on a rule that has none.
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
    characters: z
      .object({
        enabled: z.boolean().optional(),
        timeout: characterTimeout.optional(),
        max: characterMax.optional(),
      })
      .strict()
      .optional(),
    camera: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    alerts: z
      .object({
        enabled: z.boolean().optional(),
        rules: z.object(ruleRecord(rulePatchSchema)).strict().optional(),
      })
      .strict()
      .optional(),
    goal: z
      .object({
        enabled: z.boolean().optional(),
        title: goalTitle.optional(),
        counts: goalCounts.optional(),
        target: goalTarget.optional(),
      })
      .strict()
      .optional(),
    items: z.object(contentRecord(itemPatchSchema)).strict().optional(),
    cells: z
      .object({
        horizontal: cellsPatchSchema("horizontal").optional(),
        vertical: cellsPatchSchema("vertical").optional(),
      })
      .strict()
      .optional(),
    twitchOnly: z.object({ horizontal: z.boolean().optional(), vertical: z.boolean().optional() }).strict().optional(),
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
export function readCells(orientation: Orientation, value: unknown): LayerCells {
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
  const content: Record<ContentLayer, CellRect | null> = contentRecord(free);
  return { chat, characters, ...content, camera: free("camera"), alerts: free("alerts"), goal: free("goal") };
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

/** A stored rule. An invalid field reads as its default. A rule without an amount always reads the amount 1. */
function storedRuleSchema(rule: AlertRuleId): z.ZodType<AlertRule, unknown> {
  const usual: AlertRule = DEFAULT_RULES[rule];
  const min: z.ZodType<number> = hasThreshold(rule) ? alertMin : z.literal(usual.min);
  return fallback(
    z.object({
      min: fallback(min, usual.min),
      banner: fallback(z.boolean(), usual.banner),
      chat: fallback(z.boolean(), usual.chat),
      character: fallback(z.boolean(), usual.character),
    }),
    (): AlertRule => ({ ...usual }),
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
        max: fallback(characterMax, DEFAULT_LAYERS.characters.max),
      }),
      (): CharactersLayer => ({ ...DEFAULT_LAYERS.characters }),
    ),
    camera: fallback(
      z.object({ enabled: fallback(z.boolean(), DEFAULT_LAYERS.camera.enabled) }),
      (): CameraLayer => ({ ...DEFAULT_LAYERS.camera }),
    ),
    alerts: fallback(
      z.object({
        enabled: fallback(z.boolean(), DEFAULT_LAYERS.alerts.enabled),
        rules: fallback(z.object(ruleRecord(storedRuleSchema)), defaultRules),
      }),
      (): AlertsLayer => ({ enabled: DEFAULT_LAYERS.alerts.enabled, rules: defaultRules() }),
    ),
    goal: fallback(
      z.object({
        enabled: fallback(z.boolean(), DEFAULT_LAYERS.goal.enabled),
        title: fallback(goalTitle, DEFAULT_LAYERS.goal.title),
        counts: fallback(goalCounts, DEFAULT_LAYERS.goal.counts),
        target: fallback(goalTarget, DEFAULT_LAYERS.goal.target),
      }),
      (): GoalLayer => ({ ...DEFAULT_LAYERS.goal }),
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
    twitchOnly: fallback(
      z.object({
        horizontal: fallback(z.boolean(), DEFAULT_LAYERS.twitchOnly.horizontal),
        vertical: fallback(z.boolean(), DEFAULT_LAYERS.twitchOnly.vertical),
      }),
      (): Record<Orientation, boolean> => ({ ...DEFAULT_LAYERS.twitchOnly }),
    ),
  }),
  (): OverlayLayers => ({
    orientation: DEFAULT_LAYERS.orientation,
    chat: { ...DEFAULT_LAYERS.chat },
    characters: { ...DEFAULT_LAYERS.characters },
    camera: { ...DEFAULT_LAYERS.camera },
    alerts: { enabled: DEFAULT_LAYERS.alerts.enabled, rules: defaultRules() },
    goal: { ...DEFAULT_LAYERS.goal },
    items: defaultItems(),
    cells: { horizontal: emptyCells(), vertical: emptyCells() },
    twitchOnly: { ...DEFAULT_LAYERS.twitchOnly },
  }),
);

/**
 * The version of the stored `layers` JSON text that storedLayersText writes (`v`). Version 3 has cells of 60 px.
 * A text without this version is older: app/lib/overlay-legacy.ts converts it.
 */
export const LAYERS_VERSION = 3;

// Match `overlay_state_layers_check`.
export const STORED_LAYERS_LENGTH = 4000;

/** The cells to store: only the layers on the grid. */
export function storedCells(cells: LayerCells): CellsPatch {
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

/** The fields `keys` of `value` that are not as in `usual`. */
export function changedFields<T extends object>(value: T, usual: T, keys: readonly (keyof T)[]): Partial<T> {
  const changed: Partial<T> = {};
  for (const key of keys) if (value[key] !== usual[key]) changed[key] = value[key];
  return changed;
}

/** The fields of each rule that are not as in `usual`. A rule with no such field is not in the result. */
export function changedRules(rules: Readonly<AlertRules>, usual: Readonly<AlertRules>): RulesPatch {
  const changed: RulesPatch = {};
  for (const rule of ALERT_RULES) {
    const fields: Partial<AlertRule> = changedFields(rules[rule], usual[rule], RULE_FIELDS);
    if (Object.keys(fields).length > 0) changed[rule] = fields;
  }
  return changed;
}

/** The alerts layer to store: only what is not a default. Undefined: the layer has its defaults. */
function storedAlerts(alerts: AlertsLayer): LayersPatch["alerts"] {
  const stored: NonNullable<LayersPatch["alerts"]> = {};
  if (alerts.enabled !== DEFAULT_LAYERS.alerts.enabled) stored.enabled = alerts.enabled;
  const rules: RulesPatch = changedRules(alerts.rules, DEFAULT_RULES);
  if (Object.keys(rules).length > 0) stored.rules = rules;
  return Object.keys(stored).length > 0 ? stored : undefined;
}

/**
 * The `layers` JSON text to store. It leaves out what the lenient read fills in: a layer without a cell, each
 * content layer setting at its default, a camera frame that is off, the Twitch switches when the two are off, and
 * each setting of the alerts and the goal at its default. Thus the text stays short. The caller checks it against
 * STORED_LAYERS_LENGTH.
 */
export function storedLayersText(layers: OverlayLayers): string {
  const items: LayersPatch["items"] = {};
  for (const layer of CONTENT_LAYERS) {
    const stored: Partial<ContentItem> = storedItem(layer, layers.items[layer]);
    if (Object.keys(stored).length > 0) items[layer] = stored;
  }
  const goal: Partial<GoalLayer> = changedFields(layers.goal, DEFAULT_LAYERS.goal, GOAL_FIELDS);
  return JSON.stringify({
    v: LAYERS_VERSION,
    orientation: layers.orientation,
    chat: layers.chat,
    characters: layers.characters,
    camera: layers.camera.enabled === DEFAULT_LAYERS.camera.enabled ? undefined : layers.camera,
    items: Object.keys(items).length > 0 ? items : undefined,
    cells: { horizontal: storedCells(layers.cells.horizontal), vertical: storedCells(layers.cells.vertical) },
    twitchOnly: layers.twitchOnly.horizontal || layers.twitchOnly.vertical ? layers.twitchOnly : undefined,
    alerts: storedAlerts(layers.alerts),
    goal: Object.keys(goal).length > 0 ? goal : undefined,
  });
}

function mergeCells(current: LayerCells, patch: CellsPatch | undefined): LayerCells {
  const merged = (layer: GridLayer): CellRect | null => {
    const next: CellRect | null | undefined = patch?.[layer];
    const rect: CellRect | null = next === undefined ? current[layer] : next;
    return rect ? copyCell(rect) : null;
  };
  return {
    chat: merged("chat"),
    characters: merged("characters"),
    ...contentRecord(merged),
    camera: merged("camera"),
    alerts: merged("alerts"),
    goal: merged("goal"),
  };
}

function mergeItem(current: ContentItem, patch: Partial<ContentItem> | undefined): ContentItem {
  return {
    enabled: patch?.enabled ?? current.enabled,
    ref: patch?.ref === undefined ? current.ref : patch.ref,
    backgroundOpacity: patch?.backgroundOpacity ?? current.backgroundOpacity,
    qr: patch?.qr ?? current.qr,
  };
}

function mergeRule(current: AlertRule, patch: Partial<AlertRule> | undefined): AlertRule {
  return {
    min: patch?.min ?? current.min,
    banner: patch?.banner ?? current.banner,
    chat: patch?.chat ?? current.chat,
    character: patch?.character ?? current.character,
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
      max: patch.characters?.max ?? current.characters.max,
    },
    camera: { enabled: patch.camera?.enabled ?? current.camera.enabled },
    alerts: {
      enabled: patch.alerts?.enabled ?? current.alerts.enabled,
      rules: ruleRecord(
        (rule: AlertRuleId): AlertRule => mergeRule(current.alerts.rules[rule], patch.alerts?.rules?.[rule]),
      ),
    },
    goal: {
      enabled: patch.goal?.enabled ?? current.goal.enabled,
      title: patch.goal?.title ?? current.goal.title,
      counts: patch.goal?.counts ?? current.goal.counts,
      target: patch.goal?.target ?? current.goal.target,
    },
    items: contentRecord((layer: ContentLayer): ContentItem => mergeItem(current.items[layer], patch.items?.[layer])),
    cells: {
      horizontal: mergeCells(current.cells.horizontal, patch.cells?.horizontal),
      vertical: mergeCells(current.cells.vertical, patch.cells?.vertical),
    },
    twitchOnly: {
      horizontal: patch.twitchOnly?.horizontal ?? current.twitchOnly.horizontal,
      vertical: patch.twitchOnly?.vertical ?? current.twitchOnly.vertical,
    },
  };
}

// `?layer=`: null renders the whole composition; "unknown" renders an empty page.
export function parseLayerParam(value: string | null): OverlayLayer | null | "unknown" {
  if (value === null) return null;
  const layer: OverlayLayer | undefined = OVERLAY_LAYERS.find((name: OverlayLayer): boolean => name === value);
  return layer ?? "unknown";
}
