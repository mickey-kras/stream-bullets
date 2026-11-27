import { CROWN_BLOCKS, TILE } from "../../../lib/playground/constants";
import { STANDING_STATES } from "../../../lib/playground/core";
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
  "dance",
  "cheer",
  "shoot",
  "zip",
  "climb",
  "jet",
  "push",
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

/**
 * `view` with the characters of one platform only, for an output that shows one platform. Their ropes, their flags
 * and the crown go with them. The ground, the builds, the doors, and the mode stay. The playground on the server is the same for each output.
 */
export function viewForPlatform(view: PlaygroundView, platform: string): PlaygroundView {
  const characters: CharacterView[] = view.characters.filter(
    (character: CharacterView): boolean => character.platform === platform,
  );
  if (characters.length === view.characters.length) return view;
  const high: CharacterView[] = characters.filter(
    (character: CharacterView): boolean =>
      STANDING_STATES.has(character.state) && view.world.ground - character.y >= CROWN_BLOCKS * TILE,
  );
  let holder: CharacterView | undefined = high.find((character: CharacterView): boolean => character.id === view.crown);
  for (const character of high) if (!holder || character.y < holder.y) holder = character;
  const ids = new Set<number>(characters.map((character: CharacterView): number => character.id));
  return {
    ...view,
    characters,
    speakers: view.speakers.filter((id: number): boolean => ids.has(id)),
    ropes: view.ropes.filter((rope: RopeView): boolean => ids.has(rope.id)),
    flags: view.flags.filter((flag: FlagView): boolean => flag.platform === platform),
    crown: view.crown !== null && ids.has(view.crown) ? view.crown : (holder?.id ?? null),
  };
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
