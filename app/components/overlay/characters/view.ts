import type { CharState } from "../../../lib/playground/protocol";

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

/**
 * `view` with the characters of one platform only, for an output that shows one platform. The ground, the doors,
 * and the mode stay. The playground on the server is the same for each output.
 */
export function viewForPlatform(view: PlaygroundView, platform: string): PlaygroundView {
  const characters: CharacterView[] = view.characters.filter(
    (character: CharacterView): boolean => character.platform === platform,
  );
  if (characters.length === view.characters.length) return view;
  const ids = new Set<number>(characters.map((character: CharacterView): number => character.id));
  return { ...view, characters, speakers: view.speakers.filter((id: number): boolean => ids.has(id)) };
}

type TileStage = 0 | 1 | 2 | 3;

export interface TileView {
  /** Girders are protected; dirt goes intact (0), cracked (1, 2), hole (3). */
  kind: "girder" | "dirt";
  stage: TileStage;
}

interface StairView {
  /** Left edge and top of one 7 px step; the leg goes down to the ground. */
  x: number;
  top: number;
  dir: 1 | -1;
}

export interface PlaygroundView {
  /** World size in world pixels; `ground` is the y of the walking surface. */
  world: { width: number; height: number; ground: number };
  /** One tile per 16 world pixels, from x 0. */
  tiles: readonly TileView[];
  stairs: readonly StairView[];
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
