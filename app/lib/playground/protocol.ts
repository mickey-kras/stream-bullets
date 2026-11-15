import { z } from "zod";
import { CHANNEL_PLATFORMS } from "../../../db/enums";
import type { ActivityPlatform } from "../activity";
import { graphemes } from "../chat-feed";

/**
 * The frame contract of the character playground (issue #664, docs/characters.md). The server runs the simulation
 * and sends frames on the activity socket to the sockets that ask for characters. The overlay only draws them.
 *
 * - A full frame comes first on each socket. It has every section.
 * - A tick frame has the characters. It has roster, bubbles, terrain and mode only when they changed.
 * - Character ids are short numbers that the server gives. They are never platform user ids.
 * - Names and bubble text are untrusted chat text. They are bounded here; draw them as text (fillText), never HTML.
 */

export const PLAYGROUND_VERSION = 1;

/** The longest frame that encodeFrame writes and parseFrame accepts, in UTF-16 code units. */
export const MAX_FRAME_LENGTH = 32 * 1024;

/** The mark at the end of a name or bubble text that was cut to its limit. */
export const CUT_MARK = "\u2026";
/** Names: user-perceived characters and UTF-16 code units. A longer name ends with CUT_MARK. */
export const NAME_GRAPHEMES = 24;
export const NAME_MAX_UNITS = 96;
/** Bubble text: user-perceived characters and UTF-16 code units. A longer text ends with CUT_MARK. */
export const BUBBLE_GRAPHEMES = 80;
export const BUBBLE_MAX_UNITS = 320;

/** Visible characters in a frame. Equal to VISIBLE_MAX in constants.ts. */
export const FRAME_CHARS_MAX = 40;
/** Bubbles in a frame. Equal to BUBBLE_MAX in constants.ts. */
export const FRAME_BUBBLES_MAX = 4;
/** Temporary stair steps in a frame. Equal to STAIRS_MAX in constants.ts. */
export const FRAME_STAIRS_MAX = 60;
/** Ground tiles in a frame: the widest world (16 cells of 40 px) has 40 tiles of 16 px. */
export const FRAME_TILES_MAX = 64;

/**
 * Character states, in protocol order. A tuple carries the index. "gone" is an exploded or fallen character that
 * waits for its respawn: it has a slot but the renderer draws nothing.
 */
export const CHAR_STATES = [
  "enter",
  "walk",
  "turn",
  "idle",
  "goto",
  "exit",
  "jump",
  "fall",
  "land",
  "flat",
  "dig",
  "build",
  "bwalk",
  "wave",
  "boom",
  "gone",
  "respawn",
] as const;
export type CharState = (typeof CHAR_STATES)[number];

/** Flag bit: the last command was unavailable (protected ground, no room to build). Draw an icon-only mark. */
export const FLAG_UNAVAILABLE = 1;
/** Flag bit: the character was admitted less than 3 seconds ago. Show its name label. */
export const FLAG_NEW = 2;
const FLAGS_ALL = FLAG_UNAVAILABLE | FLAG_NEW;

/**
 * The tick counter `t` of a state wraps at this value in frames. Every animation period of the theme must divide it,
 * so a looping animation does not jump. Bounded states (all except walk, goto, bwalk) end long before it.
 */
export const FRAME_T_WRAP = 960;

/**
 * One character: id, x * 10, y * 10 (logical px, rounded), state index (CHAR_STATES), ticks in state (wraps at
 * FRAME_T_WRAP), direction (1 right, -1 left), flags (FLAG_*). y is the feet: the ground is at `terrain.gy`.
 */
export type CharTuple = [id: number, x10: number, y10: number, state: number, t: number, dir: 1 | -1, flags: number];

export interface RosterEntry {
  id: number;
  platform: ActivityPlatform;
  name: string;
}

/** A speech bubble. A frame lists the bubbles oldest first. */
export interface BubbleView {
  /** The character that speaks. */
  id: number;
  text: string;
}

/** One temporary stair step: left x, top y (logical px, rounded) and the build direction. Steps are 7 x 4 px. */
export type StairTuple = [x: number, top: number, dir: 1 | -1];

/**
 * The world in logical px (one logical px is 3 design px). Tile i covers x from i * tile to (i + 1) * tile.
 * `ground` has one character per tile: "g" protected girder, "0" to "2" dirt with that much damage, "3" a hole.
 */
export interface TerrainView {
  w: number;
  h: number;
  gy: number;
  tile: number;
  ground: string;
  stairs: StairTuple[];
  /** The x of the respawn pad, the entrance door and the exit door, and the walking limits. */
  padX: number;
  entryX: number;
  exitX: number;
  xmin: number;
  xmax: number;
}

export interface ModeView {
  paused: boolean;
  test: boolean;
}

export interface PlaygroundFullFrame {
  type: "playground";
  v: typeof PLAYGROUND_VERSION;
  full: true;
  tick: number;
  chars: CharTuple[];
  roster: RosterEntry[];
  bubbles: BubbleView[];
  terrain: TerrainView;
  mode: ModeView;
}

export interface PlaygroundTickFrame {
  type: "playground";
  v: typeof PLAYGROUND_VERSION;
  full: false;
  tick: number;
  chars: CharTuple[];
  roster?: RosterEntry[];
  bubbles?: BubbleView[];
  terrain?: TerrainView;
  mode?: ModeView;
}

export type PlaygroundFrame = PlaygroundFullFrame | PlaygroundTickFrame;

// Control characters, line and paragraph separators, and bidi marks: the Arabic letter mark, the left-to-right and
// right-to-left marks, and the embedding, override and isolate marks.
const UNSAFE_TEXT = /[\p{Cc}\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const UNSAFE_TEXT_ALL = /[\p{Cc}\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]+/gu;

/** The start of `parts` that fits `maxGraphemes` user-perceived characters and `maxUnits` code units. */
function fit(parts: readonly string[], maxGraphemes: number, maxUnits: number): string {
  let out = "";
  for (const [count, part] of parts.entries()) {
    if (count >= maxGraphemes || out.length + part.length > maxUnits) break;
    out += part;
  }
  return out;
}

/**
 * Untrusted text made safe for a frame: a lone surrogate becomes U+FFFD, control and bidi characters become spaces,
 * white space collapses, and the text is cut to `maxGraphemes` user-perceived characters and `maxUnits` code units.
 * A cut never splits a grapheme. With `cutMark`, a cut text ends with that mark inside the same limits.
 */
export function boundText(text: string, maxGraphemes: number, maxUnits: number, cutMark: string = ""): string {
  const clean: string = text
    .replace(LONE_SURROGATE, "\uFFFD")
    .replace(UNSAFE_TEXT_ALL, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const parts: string[] = graphemes(clean);
  const whole: string = fit(parts, maxGraphemes, maxUnits);
  if (whole.length === clean.length || !cutMark) return whole.trimEnd();
  return fit(parts, maxGraphemes - 1, maxUnits - cutMark.length).trimEnd() + cutMark;
}

const id = z
  .number()
  .int()
  .min(1)
  .max(2 ** 31 - 1);
const coordinate = z.number().int().min(-100_000).max(100_000);
const dir = z.union([z.literal(1), z.literal(-1)]);
const safeText = (maxUnits: number) =>
  z
    .string()
    .max(maxUnits)
    .refine((value: string): boolean => !UNSAFE_TEXT.test(value));

const charSchema = z.tuple([
  id,
  coordinate,
  coordinate,
  z
    .number()
    .int()
    .min(0)
    .max(CHAR_STATES.length - 1),
  z
    .number()
    .int()
    .min(0)
    .max(FRAME_T_WRAP - 1),
  dir,
  z.number().int().min(0).max(FLAGS_ALL),
]);

const rosterSchema = z
  .array(z.object({ id, platform: z.enum(CHANNEL_PLATFORMS), name: safeText(NAME_MAX_UNITS) }).strict())
  .max(FRAME_CHARS_MAX);

const bubblesSchema = z.array(z.object({ id, text: safeText(BUBBLE_MAX_UNITS) }).strict()).max(FRAME_BUBBLES_MAX);

const px = z.number().int().min(0).max(10_000);
const terrainSchema = z
  .object({
    w: px,
    h: px,
    gy: px,
    tile: px,
    ground: z
      .string()
      .max(FRAME_TILES_MAX)
      .regex(/^[g0-3]*$/),
    stairs: z.array(z.tuple([coordinate, coordinate, dir])).max(FRAME_STAIRS_MAX),
    padX: px,
    entryX: px,
    exitX: px,
    xmin: px,
    xmax: px,
  })
  .strict();

const modeSchema = z.object({ paused: z.boolean(), test: z.boolean() }).strict();

const base = {
  type: z.literal("playground"),
  v: z.literal(PLAYGROUND_VERSION),
  tick: z.number().int().nonnegative(),
  chars: z.array(charSchema).max(FRAME_CHARS_MAX),
};

const frameSchema: z.ZodType<PlaygroundFrame> = z.union([
  z
    .object({
      ...base,
      full: z.literal(true),
      roster: rosterSchema,
      bubbles: bubblesSchema,
      terrain: terrainSchema,
      mode: modeSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      full: z.literal(false),
      roster: rosterSchema.optional(),
      bubbles: bubblesSchema.optional(),
      terrain: terrainSchema.optional(),
      mode: modeSchema.optional(),
    })
    .strict(),
]);

/** Every character and bubble of a full frame has a roster entry, and no id is in the roster twice. */
function consistent(frame: PlaygroundFrame): boolean {
  if (!frame.roster) return true;
  const ids = new Set<number>(frame.roster.map((entry: RosterEntry): number => entry.id));
  if (ids.size !== frame.roster.length) return false;
  if (!frame.full) return true;
  return (
    frame.chars.every((char: CharTuple): boolean => ids.has(char[0])) &&
    frame.bubbles.every((bubble: BubbleView): boolean => ids.has(bubble.id))
  );
}

/** The frame as a socket message. Throws when the frame breaks the contract: that is a server bug. */
export function encodeFrame(frame: PlaygroundFrame): string {
  const result = frameSchema.safeParse(frame);
  if (!result.success) throw new Error(`playground frame invalid: ${result.error.issues[0].message}`);
  if (!consistent(frame)) throw new Error("playground frame invalid: a character or bubble has no roster entry");
  const raw: string = JSON.stringify(frame);
  if (raw.length > MAX_FRAME_LENGTH) throw new Error(`playground frame too long: ${raw.length}`);
  return raw;
}

/** Parses one socket message for the overlay. Anything malformed, too long or of another type is null. */
export function parseFrame(raw: unknown): PlaygroundFrame | null {
  if (typeof raw !== "string" || raw.length > MAX_FRAME_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = frameSchema.safeParse(value);
  return result.success && consistent(result.data) ? result.data : null;
}

/**
 * A control of the owner: `POST /api/overlay/characters` (docs/api.md), which the API passes to the page's
 * playground. `status` only reads the state. `remove` takes the character id of the frames.
 */
export const playgroundControlSchema = z.union([
  z.object({ op: z.literal("remove"), id }).strict(),
  z.object({ op: z.enum(["status", "test", "stopTest", "pause", "resume", "reset"]) }).strict(),
]);
export type PlaygroundControl = z.infer<typeof playgroundControlSchema>;

/** The answer to every control. `testEndsAt` is the server time at which the characters test ends, or null. */
export const playgroundStatusSchema = z
  .object({ paused: z.boolean(), testEndsAt: z.number().int().nonnegative().nullable() })
  .strict();
export type PlaygroundStatus = z.infer<typeof playgroundStatusSchema>;
