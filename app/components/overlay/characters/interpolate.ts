import { TICK_HZ } from "../../../lib/playground/constants";
import type { CharacterView, PlaygroundView } from "./view";

/** The client shows the playground this long after a frame arrives, so it can move between two frames. */
export const RENDER_DELAY_MS = 100;
/** A move longer than this between two frames is a teleport: the character jumps instead of sliding. */
const TELEPORT_PX = 24;
/** Animation time advances at the simulation rate. */
const TICKS_PER_MS = TICK_HZ / 1000;
/** Without a newer frame, animation time advances at most this long past the newest frame. */
export const MAX_AHEAD_MS = 250;
/** Frames kept for sampling. */
export const BUFFER_SIZE = 8;

/** A frame and the time it arrived (performance.now()). */
export interface TimedView {
  at: number;
  view: PlaygroundView;
}

/** Returns the buffer with `view` added at time `at`, at most BUFFER_SIZE frames. An out-of-order frame starts a new buffer. */
export function pushFrame(buffer: readonly TimedView[], view: PlaygroundView, at: number): TimedView[] {
  const last: TimedView | undefined = buffer.at(-1);
  if (last && at < last.at) return [{ at, view }];
  return [...buffer, { at, view }].slice(-BUFFER_SIZE);
}

function moves(from: CharacterView, to: CharacterView | undefined): to is CharacterView {
  return (
    to !== undefined &&
    to.state === from.state &&
    Math.abs(to.x - from.x) <= TELEPORT_PX &&
    Math.abs(to.y - from.y) <= TELEPORT_PX
  );
}

/**
 * The view to draw at `now`: the playground RENDER_DELAY_MS ago. Discrete values (state, terrain, bubbles) come from
 * the frame at or before that time. Positions slide toward the next frame, except across a state change or a
 * teleport. Animation time advances locally unless the playground is paused. With reduced motion, the newest frame
 * is shown as it is.
 */
export function sampleView(buffer: readonly TimedView[], now: number, reduced: boolean): PlaygroundView | null {
  const newest: TimedView | undefined = buffer.at(-1);
  if (!newest) return null;
  if (reduced) return newest.view;
  const time: number = now - RENDER_DELAY_MS;
  let index = 0;
  while (index + 1 < buffer.length && buffer[index + 1].at <= time) index++;
  const base: TimedView = buffer[index];
  const next: TimedView | undefined = buffer[index + 1];
  const elapsed: number = Math.max(0, time - base.at);
  const paused: boolean = base.view.mode.paused;
  const share: number = next && !paused ? Math.min(1, elapsed / Math.max(1, next.at - base.at)) : 0;
  const ahead: number = paused ? 0 : Math.min(elapsed, next ? next.at - base.at : MAX_AHEAD_MS) * TICKS_PER_MS;
  const later = new Map<number, CharacterView>(next?.view.characters.map((c: CharacterView) => [c.id, c]));
  const characters: CharacterView[] = base.view.characters.map((c: CharacterView): CharacterView => {
    const to: CharacterView | undefined = later.get(c.id);
    if (share === 0 || !moves(c, to)) return { ...c, t: c.t + ahead };
    return {
      ...c,
      x: c.x + (to.x - c.x) * share,
      y: c.y + (to.y - c.y) * share,
      t: c.t + ahead,
    };
  });
  return { ...base.view, characters };
}
