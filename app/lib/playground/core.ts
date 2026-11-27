import type { ActivityPlatform } from "../activity";

import { COMMAND_ALIASES, COMMANDS, type Command, type CommandCall, type Participant } from "./crowd";
import type { CharState } from "./protocol";
import type { Terrain, World } from "./terrain";

/**
 * The shared pieces of the playground simulation: the random source, the state change, the command parser and the
 * state groups.
 */

/** The mulberry32 generator: a small, seeded random source in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state: number = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value: number = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sets the state and restarts its tick counter. */
export function setState(participant: Participant, state: CharState | "away", extra: Partial<Participant> = {}): void {
  Object.assign(participant, { state, t: 0 }, extra);
}

const SIDES: Readonly<Record<string, 1 | -1>> = { left: -1, l: -1, right: 1, r: 1 };
/** The emotes: they do not steer the character. */
export const EMOTES: ReadonlySet<Command> = new Set<Command>(["dance", "wave", "cheer"]);
/** A boom or a push does not throw a character in these states. */
export const FIXED_STATES: ReadonlySet<CharState | "away"> = new Set<CharState | "away">([
  "away",
  "gone",
  "enter",
  "exit",
  "respawn",
  "boom",
]);
/** A stop ends these states at once. The other actions have a short, fixed end. */
export const HALTED_STATES: ReadonlySet<CharState | "away"> = new Set<CharState | "away">([
  "step",
  "walk",
  "idle",
  "dig",
  "build",
]);
/** The states in which a character stands on a floor: it can wear the crown and stop a walk beside it. */
export const STANDING_STATES: ReadonlySet<CharState | "away"> = new Set<CharState | "away">([
  "hold",
  "walk",
  "idle",
  "turn",
  "step",
  "build",
  "dig",
  "wave",
  "dance",
  "cheer",
]);

// Leading white space and invisible format characters (ZWJ, BOM, bidi marks) are skipped. "！" is the full-width "!".
const COMMAND = /^[\s\p{Cf}]*[!！][\p{L}\p{N}_-]{1,32}(?:\s|$)/u;

/** A message whose first visible text is `!word` (like `!jump` or `！jump`). The word can be a command or not. */
export function isChatCommand(text: string): boolean {
  return COMMAND.test(text);
}

/**
 * The command of a chat text, or null: the word after `!` (a command or an alias, in any letter case), then at most
 * two more words in any order: a number of 1 or 2 digits and a side (`left`, `right`, `l`, `r`). So `!dig`,
 * `！DIG 3`, `!dig left` and `!dig r 3` are commands.
 */
export function parseCommand(text: string): CommandCall | null {
  if (!isChatCommand(text)) return null;
  const [word = "", ...rest] = text
    .replace(/^[\s\p{Cf}]*[!！]/u, "")
    .toLowerCase()
    .split(/\s+/u);
  const name: Command | undefined =
    COMMANDS.find((command: Command): boolean => command === word) ??
    (Object.hasOwn(COMMAND_ALIASES, word) ? COMMAND_ALIASES[word] : undefined);
  if (!name) return null;
  const call: CommandCall = { name, n: 0, side: 0 };
  for (const token of rest.slice(0, 2)) {
    if (/^\d{1,2}$/.test(token)) call.n = Number(token);
    else if (Object.hasOwn(SIDES, token)) call.side = SIDES[token];
  }
  return call;
}

/**
 * True when the text is a command for a character: `parseCommand` reads it. The chat views can hide these messages
 * (`chat.hideCharacterCommands` of the overlay layers). `!discord` and `!hello` are no commands of a character.
 */
export function isCharacterCommand(text: string): boolean {
  return parseCommand(text) !== null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function siteKey(platform: ActivityPlatform, id: string): string {
  return `${platform}:${id}`;
}

/** What the parts of the simulation (see motion.ts and works.ts) use of the playground. */
export interface SimHost {
  world: World;
  terrain: Terrain;
  clock: number;
  crown: number | null;
  readonly participants: Map<string, Participant>;
  /** The characters with a slot. */
  visible(): Participant[];
  /** After an action: a steered character stands still, and another character walks on. */
  rest(p: Participant, extra?: Partial<Participant>): void;
  /** The command cannot run, or cannot go on. A red cross shows unless `quiet`. */
  giveUp(p: Participant, quiet?: boolean): void;
}
