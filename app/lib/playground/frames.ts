import { NEW_TICKS } from "./constants";
import type { Participant } from "./crowd";
import {
  type BubbleView,
  CHAR_STATES,
  type CharState,
  type CharTuple,
  type ExtrasView,
  FLAG_NEW,
  FLAG_UNAVAILABLE,
  type FlagTuple,
  FRAME_T_WRAP,
  type RopeTuple,
} from "./protocol";
import { cellX, type Flag, floorY, type Terrain, type World } from "./terrain";

/** The parts of a playground frame that come from the visible participants (docs/characters.md, frame protocol). */

/** One tuple for each visible character, at tick `clock`. */
export function charTuples(visible: readonly Participant[], clock: number): CharTuple[] {
  return visible.map((p: Participant): CharTuple => {
    const flags: number = (p.mark > 0 ? FLAG_UNAVAILABLE : 0) | (clock - p.admittedAt < NEW_TICKS ? FLAG_NEW : 0);
    return [
      p.id,
      Math.round(p.x * 10),
      Math.round(p.y * 10),
      CHAR_STATES.indexOf(p.state as CharState),
      p.t % FRAME_T_WRAP,
      p.dir,
      flags,
    ];
  });
}

/** The ropes, the flags and the crown of the visible characters. */
export function extrasView(
  visible: readonly Participant[],
  world: World,
  terrain: Terrain,
  crown: number | null,
): ExtrasView {
  const ids = new Set<number>(visible.map((p: Participant): number => p.id));
  return {
    ropes: visible.flatMap((p: Participant): RopeTuple[] =>
      p.rope ? [[p.id, Math.round(p.rope.x), Math.round(p.rope.y), p.rope.hit ? 1 : 0]] : [],
    ),
    flags: terrain.flags
      .filter((flag: Flag): boolean => ids.has(flag.id))
      .map((flag: Flag): FlagTuple => [flag.id, cellX(flag.c), floorY(world, flag.r)]),
    crown: crown !== null && ids.has(crown) ? crown : null,
  };
}

/** The bubbles of the visible characters, oldest first, so the overlay draws the newest bubble on top. */
export function bubbleViews(visible: readonly Participant[]): BubbleView[] {
  return visible
    .flatMap((p: Participant): [number, BubbleView][] =>
      p.bubble ? [[p.bubble.at, { id: p.id, text: p.bubble.text }]] : [],
    )
    .sort((a: [number, BubbleView], b: [number, BubbleView]): number => a[0] - b[0])
    .map(([, bubble]: [number, BubbleView]): BubbleView => bubble);
}
