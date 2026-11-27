import { CELL_PX } from "../overlay-layers";

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
export const CELLS_W_MIN = 12;
export const CELLS_W_MAX = 32;
export const CELLS_H_MIN = 4;
export const CELLS_H_MAX = 32;

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
export { FRAME_CHARS_MAX as VISIBLE_MAX } from "./protocol";
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
export const MOVEMENT_COOLDOWN_TICKS = 30;
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

/** Holes in the ground repair this long (30 s) after the last hit. Builds do not expire. */
export const TERRAIN_LIFETIME_TICKS = 900;
/** The block grid ends this far below the top of the world: the rows above stay free for bubbles and badges. */
export const BUILD_CEILING = 30;
/** The most blocks at once, as a share of the cells of the block grid. At the limit the oldest block goes. */
export const BLOCK_FILL = 0.47;
/** Nobody builds in a door zone below this row, or within PAD_CLEAR_COLS of the respawn pad below PAD_CLEAR_ROWS. */
export const DOOR_CLEAR_ROWS = 5;
export const PAD_CLEAR_COLS = 1;
export const PAD_CLEAR_ROWS = 3;
/** Loose blocks fall one row at this interval. */
export const BLOCK_FALL_TICKS = 3;
/** The most blocks that one walk command covers, and the most for a dig, stairs, bridge or jetpack command. */
export const WALK_BLOCKS_MAX = 20;
export const REPEAT_MAX = 5;
/** A jetpack rises this many blocks without a number. */
export const JETPACK_BLOCKS = 5;
/** A grapple hook reaches this many blocks. */
export const GRAPPLE_REACH = 6;
/** A boom breaks the blocks whose centre is within the root of this many squared blocks, and throws characters this near (logical px). */
export const BOOM_REACH_SQUARED = 5.5;
export const BOOM_THROW_PX = 40;
/** The body of a character for walls: this high above the feet, and this far in front of the centre. */
export const BODY_HEIGHT = 20;
export const BODY_REACH = 4;
/** A platform with active chatters keeps this share of the visible slots, and at least PLATFORM_RESERVE_MIN. */
export const PLATFORM_RESERVE_SHARE = 0.2;
export const PLATFORM_RESERVE_MIN = 2;
/** The crown needs this many blocks of height. */
export const CROWN_BLOCKS = 2;
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
/** The speed of a walk of some blocks that a viewer commands, and the fastest walk toward a target. */
export const STEP_SPEED = 1;
export const GOTO_SPEED_MAX = 2;
/** The chance per tick that a walking character turns, and then that it stops to idle. */
export const TURN_CHANCE = 0.003;
export const IDLE_CHANCE = 0.003;
/** A walking character steps up at most this much. */
export const STEP_UP = 5;
/** Gravity, jump speeds and the fall height that flattens a character. A jump clears two blocks. */
/** The speeds of a character that a boom or a push throws. */
export const THROW_VX = 1.2;
export const THROW_VY = -2.4;
export const PUSH_VX = 1;
export const PUSH_VY = -1.4;
export const GRAVITY = 0.2;
export const JUMP_VY = -3.8;
export const JUMP_VX = 0.9;
export const FALL_VX = 0.3;
export const FLAT_HEIGHT = 40;

/**
 * State durations in ticks. Each action ends: the emotes, boom, dig and build by these counts, jump and fall by
 * landing or leaving the world, and a walk of some blocks at its target or at a wall.
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
  /** A build places its block at buildAt and ends at buildEnd. */
  buildAt: 7,
  buildEnd: 20,
  dance: 96,
  cheer: 48,
  push: 8,
  /** A boom breaks blocks and throws characters at this tick. */
  boomAt: 24,
  /** A grapple shoots this long before a hit pulls, or before a miss ends. */
  shootHit: 10,
  shootMiss: 16,
  /** A tween (climb, zip, jet) takes tweenBase ticks and tweenPerBlock more for each block of height. */
  climb: 8,
  tweenBase: 8,
  tweenPerBlock: 3,
} as const;
