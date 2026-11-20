import { CELL_PX } from "../overlay-layers";
import { FRAME_CHARS_MAX } from "./protocol";

/**
 * The rules of the character playground (issue #664, docs/characters.md). Time is in ticks of the rules clock.
 * These values come from the approved prototype. They are product choices, so change them here and in the document.
 */

/** Rules ticks per second. */
export const TICK_HZ = 30;

/** One logical px of the world is this many design px. Sprites are drawn at this scale. */
export const PIXEL_SCALE = 3;
/** Logical px per grid cell (a cell is CELL_PX design px). The world is CELL_LOGICAL * cell width and height. */
export const CELL_LOGICAL = CELL_PX / PIXEL_SCALE;
/** The characters cell size limits, in cells. Smaller cells give no usable route. */
export const CELLS_W_MIN = 6;
export const CELLS_W_MAX = 16;
export const CELLS_H_MIN = 2;
export const CELLS_H_MAX = 16;

/** Ground tile width and the ground position: the ground is this far above the bottom of the world. */
export const TILE = 16;
export const GROUND_OFFSET = 18;
/** Protected girder tiles at each end, for the entrance and the exit. */
export const ZONE_TILES = 6;
/** The middle of the ground repeats this many dirt tiles, then this many girder tiles. */
export const MIDDLE_DIRT = 5;
export const MIDDLE_GIRDER = 3;
/** Distances from the world edges (logical px). */
export const ENTRY_X = 40;
export const EXIT_INSET = 42;
/** Walking limits: this far inside the end of the entrance zone and the start of the exit zone. */
export const WALK_INSET = 12;
/** Thrown characters stop moving sideways this far from the world edges. */
export const BOUNCE_INSET = 60;
/** A character this far below the bottom of the world is gone. */
export const FALL_OUT = 40;

/** The most visible characters that a frame holds, entrance, exit and respawn included. */
export const VISIBLE_MAX = FRAME_CHARS_MAX;
/**
 * The share of the visible slots that goes to the highest decayed scores. The other slots rotate through the other
 * active participants. The owner sets the number of visible slots (CHARACTERS_MAX): 40 slots give 30 and 10.
 */
export const RANKED_SHARE = 0.75;
/** The rotating slots advance by their own number of participants at this interval (15 s). */
export const ROTATION_TICKS = 450;
/** A character stays at least this long (10 s) before capacity or inactivity sends it out. */
export const MIN_STAY_TICKS = 300;

/** A message adds 1 to the score, at most once in this interval (3 s), so spam cannot raise the rank. */
export const SCORE_COOLDOWN_TICKS = 90;
/** Scores decay as exp(-elapsed / SCORE_DECAY_TICKS) (time constant 60 s). */
export const SCORE_DECAY_TICKS = 1800;

/** A viewer can give one command in this interval (3 s). Commands in the interval are ignored. */
export const COMMAND_COOLDOWN_TICKS = 90;
/** A queued command (one per viewer) expires this long (10 s) after it arrived. Queued text expires too. */
export const COMMAND_EXPIRY_TICKS = 300;

/** Bubble life for a message, for a command and the most bubbles at once. Extra bubbles drop the oldest. */
export const BUBBLE_TICKS = 120;
export const COMMAND_BUBBLE_TICKS = 60;
export { FRAME_BUBBLES_MAX as BUBBLE_MAX, BUBBLE_GRAPHEMES as BUBBLE_LENGTH } from "./protocol";
/** How long the unavailable mark shows. */
export const MARK_TICKS = 36;
/** The name label shows this long after admission. */
export const NEW_TICKS = 90;

/** Holes repair and stairs go this long (30 s) after the last change. */
export const TERRAIN_LIFETIME_TICKS = 900;
/** Temporary stair steps at once. The oldest goes first. */
export { FRAME_STAIRS_MAX as STAIRS_MAX } from "./protocol";
/** Steps in one build. */
export const BUILD_STEPS = 5;
/** A build turns toward the middle when it starts this close to a walking limit. */
export const BUILD_TURN_INSET = 106;
/** A respawn waits this long (2.5 s) after an explosion or a fall. */
export const RESPAWN_TICKS = 75;

/** Participants that the playground remembers, and how long one stays after its last message (30 min). */
export const REGISTRY_MAX = 500;
const REGISTRY_IDLE_MS = 30 * 60_000;
export const REGISTRY_IDLE_TICKS = (REGISTRY_IDLE_MS * TICK_HZ) / 1000;
/** Restricted (banned or timed-out) participants that the playground remembers. */
export const RESTRICTED_MAX = 500;
/** The registry and restrictions are swept for expiry at this interval. */
export const SWEEP_TICKS = TICK_HZ;

/** How long a characters test runs (5 min). */
export const CHARACTERS_TEST_MS = 300_000;
export const CHARACTERS_TEST_TICKS = (CHARACTERS_TEST_MS * TICK_HZ) / 1000;
/** The user id prefix of synthetic test participants. Stopping a test removes them. */
export const TEST_USER_PREFIX = "playground-test-";

/** The longest checkpoint, in UTF-16 code units of its JSON. */
export const CHECKPOINT_MAX_LENGTH = 60_000;

/**
 * Mean walking speed in logical px per tick, and its spread: each character has a fixed speed in
 * WALK_SPEED +/- WALK_SPEED_SPREAD / 2, so the crowd does not march in step.
 */
export const WALK_SPEED = 0.55;
export const WALK_SPEED_SPREAD = 0.3;
/** Speed on stairs and the fastest walk toward a target. */
export const STAIR_SPEED = 0.5;
export const GOTO_SPEED_MAX = 2;
/** The chance per tick that a walking character turns, and then that it stops to idle. */
export const TURN_CHANCE = 0.003;
export const IDLE_CHANCE = 0.003;
/** A walking character steps up at most this much. */
export const STEP_UP = 5;
/** Gravity, jump speeds and the fall height that flattens a character. */
export const GRAVITY = 0.2;
export const JUMP_VY = -3.2;
export const JUMP_VX = 0.9;
export const FALL_VX = 0.3;
export const FLAT_HEIGHT = 10;

/**
 * State durations in ticks. Each action ends: wave, boom, dig and build by these counts, jump and fall by landing or
 * leaving the world.
 */
export const DURATION = {
  enter: 24,
  exit: 24,
  respawn: 32,
  idle: 40,
  turn: 14,
  land: 5,
  flat: 30,
  wave: 54,
  boom: 48,
  dig: 60,
  /** A dig hits the ground at t % digEvery === digAt. */
  digEvery: 20,
  digAt: 15,
  jumpCrouch: 4,
  /** A build places its step at buildAt and walks onto it from buildEnd. */
  buildAt: 7,
  buildEnd: 20,
} as const;
