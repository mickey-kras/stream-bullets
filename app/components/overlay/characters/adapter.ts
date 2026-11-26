import {
  type BubbleView,
  blockOf,
  CHAR_STATES,
  type CharTuple,
  type ExtrasView,
  FLAG_NEW,
  FLAG_UNAVAILABLE,
  type ModeView,
  type PlaygroundFrame,
  type RosterEntry,
  type TerrainView,
} from "../../../lib/playground/protocol";
import type { BlockView, CharacterView, FlagView, PlaygroundView, TileView } from "./view";

/** The unavailable mark shows this far (world px) above the feet: over the head. */
export const MARK_LIFT = 34;

/** The sections that a tick frame sends only when they change: the newest of each. */
export interface FrameState {
  roster: readonly RosterEntry[];
  bubbles: readonly BubbleView[];
  terrain: TerrainView;
  extras: ExtrasView;
  mode: ModeView;
}

function tile(code: string): TileView {
  if (code === "g") return { kind: "girder", stage: 0 };
  const stage: number = Number(code);
  return { kind: "dirt", stage: stage === 1 || stage === 2 || stage === 3 ? stage : 0 };
}

/**
 * The state after `frame`. A full frame replaces the state; a tick frame changes only the sections that it has. A tick
 * frame before the first full frame gives null: the playground is not known yet.
 */
export function mergeFrame(state: FrameState | null, frame: PlaygroundFrame): FrameState | null {
  if (frame.full) {
    const { roster, bubbles, terrain, extras, mode } = frame;
    return { roster, bubbles, terrain, extras, mode };
  }
  if (!state) return null;
  return {
    roster: frame.roster ?? state.roster,
    bubbles: frame.bubbles ?? state.bubbles,
    terrain: frame.terrain ?? state.terrain,
    extras: frame.extras ?? state.extras,
    mode: frame.mode ?? state.mode,
  };
}

/** The blocks of a terrain: `blocks` has one character per cell, in rows from the ground up. */
function blocksOf(terrain: TerrainView): BlockView[] {
  const cols: number = terrain.ground.length;
  const found: BlockView[] = [];
  for (const [i, code] of Array.from(terrain.blocks).entries()) {
    const cell = blockOf(code);
    if (cell && cols > 0) found.push({ ...cell, c: i % cols, r: Math.floor(i / cols) });
  }
  return found;
}

/** The renderer input for the characters of a frame. A character without a roster entry is not drawn. */
export function toView(state: FrameState, chars: readonly CharTuple[]): PlaygroundView {
  const roster = new Map<number, RosterEntry>(state.roster.map((entry: RosterEntry) => [entry.id, entry]));
  // The server gives a character at most one bubble.
  const bubbles = new Map<number, string>(state.bubbles.map((bubble: BubbleView) => [bubble.id, bubble.text]));
  const characters: CharacterView[] = [];
  const marks: { x: number; y: number }[] = [];
  for (const [id, x10, y10, stateIndex, t, dir, flags] of chars) {
    const entry: RosterEntry | undefined = roster.get(id);
    if (!entry) continue;
    const x: number = x10 / 10;
    const y: number = y10 / 10;
    characters.push({
      id,
      x,
      y,
      state: CHAR_STATES[stateIndex],
      t,
      dir,
      platform: entry.platform,
      name: entry.name,
      bubble: bubbles.get(id) ?? null,
      recent: (flags & FLAG_NEW) !== 0,
    });
    if ((flags & FLAG_UNAVAILABLE) !== 0) marks.push({ x, y: y - MARK_LIFT });
  }
  const { terrain, extras, mode } = state;
  const shown = new Set<number>(characters.map((c: CharacterView): number => c.id));
  return {
    world: { width: terrain.w, height: terrain.h, ground: terrain.gy },
    tiles: Array.from(terrain.ground, tile),
    blocks: blocksOf(terrain),
    ropes: extras.ropes.flatMap(([id, x, y, hit]) => (shown.has(id) ? [{ id, x, y, hit: hit === 1 }] : [])),
    flags: extras.flags.flatMap(([id, x, y]): FlagView[] => {
      const owner: RosterEntry | undefined = roster.get(id);
      return owner ? [{ x, y, platform: owner.platform }] : [];
    }),
    crown: extras.crown !== null && shown.has(extras.crown) ? extras.crown : null,
    marks,
    doors: { entrance: terrain.entryX, exit: terrain.exitX },
    pad: terrain.padX,
    characters,
    speakers: state.bubbles.map((bubble: BubbleView): number => bubble.id),
    mode: { test: mode.test, paused: mode.paused },
  };
}
