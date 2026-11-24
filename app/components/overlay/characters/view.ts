import type { BlockCell, CharState } from "../../../lib/playground/protocol";

/**
 * The input of the character renderer: one moment of the playground, in world pixels (1 world pixel = PIXEL_SCALE
 * design pixels). An adapter builds it from the playground frames; the renderer reads nothing else.
 */

/** The animation rows of a character sheet, top to bottom. */
export const CHARACTER_ROWS = [
  "idle",
  "walk",
  "entrance",
  "exit",
  "turn",
  "jump",
  "dig",
  "build",
  "wave",
  "fall",
  "explosion",
  "respawn",
] as const;
export type CharacterRow = (typeof CHARACTER_ROWS)[number];

/** Simulation states: the states of the frame contract. The theme maps each state to a row and frame timing. */
export type CharacterState = CharState;

export interface CharacterView {
  /** Short numeric id from the frame, stable while the character is on screen. */
  id: number;
  /** Feet position: x is the centre, y is the ground line under the feet. */
  x: number;
  y: number;
  state: CharacterState;
  /** Ticks (30 per second) since the character entered `state`. */
  t: number;
  dir: 1 | -1;
  /** Platform id, for example "twitch". Unknown platforms get the fallback helmet colour. */
  platform: string;
  name: string;
  /** Speech bubble text, or null. */
  bubble: string | null;
  /** True for a few seconds after the character was admitted. */
  recent: boolean;
}

type TileStage = 0 | 1 | 2 | 3;

export interface TileView {
  /** Girders are protected; dirt goes intact (0), cracked (1, 2), hole (3). */
  kind: "girder" | "dirt";
  stage: TileStage;
}

/** A block that viewers built: its cell in the block grid (row 0 is on the ground) and what it is. */
export interface BlockView extends BlockCell {
  c: number;
  r: number;
}

/** A grapple rope from the character `id` to the hook point. `hit` is false for a hook that caught nothing. */
export interface RopeView {
  id: number;
  x: number;
  y: number;
  hit: boolean;
}

/** A flag on the floor at (x, y), in the helmet colour of `platform`. */
export interface FlagView {
  x: number;
  y: number;
  platform: string;
}

export interface PlaygroundView {
  /** World size in world pixels; `ground` is the y of the walking surface. */
  world: { width: number; height: number; ground: number };
  /** One tile per 16 world pixels, from x 0. */
  tiles: readonly TileView[];
  blocks: readonly BlockView[];
  ropes: readonly RopeView[];
  flags: readonly FlagView[];
  /** The id of the character that wears the crown, or null. */
  crown: number | null;
  /** Centres of the "unavailable" marks (a red cross). */
  marks: readonly { x: number; y: number }[];
  /** Centre x of each door and of the respawn pad. */
  doors: { entrance: number; exit: number };
  pad: number;
  characters: readonly CharacterView[];
  /** The ids of the characters with a bubble, oldest bubble first: the newest bubble draws on top. */
  speakers: readonly number[];
  mode: { test: boolean; paused: boolean };
}
