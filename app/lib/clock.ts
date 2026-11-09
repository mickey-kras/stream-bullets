// A page clock that follows the server's time and wakes only when the display changes.

/** The next instant after `now` that a mark, or a whole `step` before it, falls on. Null with no mark ahead. */
export function nextMark(now: number, marks: readonly number[], step: number): number | null {
  let next: number | null = null;
  for (const mark of marks) {
    if (mark <= now) continue;
    const at: number = mark - (Math.ceil((mark - now) / step) - 1) * step;
    if (next === null || at < next) next = at;
  }
  return next;
}

/**
 * The server's lead over this device's clock, measured once for each server time a page receives. A clock that
 * restarts later with the same server time (new marks, say) keeps the measure instead of taking that time as now.
 */
export class ServerOffset {
  private source: number | null = null;
  private offset: number = 0;

  for(serverNow: number): number {
    if (serverNow !== this.source) {
      this.source = serverNow;
      this.offset = serverNow - Date.now();
    }
    return this.offset;
  }
}

/** The longest single timer wait: a day, well under the 2^31 - 1 ms that setTimeout can hold. */
const MAX_STEP_MS = 86_400_000;

/** Calls `onReach` once when the server clock reaches `at`. Returns a function that cancels it. */
export function atMark(
  serverNow: number,
  at: number,
  onReach: () => void,
  offsets: ServerOffset = new ServerOffset(),
): () => void {
  return startClock(serverNow, (now: number): number | null => (now < at ? at : null), onReach, offsets);
}

/**
 * Calls `onTick` with the server time at each instant `next` names, measured from `serverNow` and the local clock's
 * offset to it. A caller that restarts its clock passes the same `offsets`, so the offset is measured once per
 * server time. Stops when `next` returns null. Returns a function that cancels the pending timer.
 */
export function startClock(
  serverNow: number,
  next: (now: number) => number | null,
  onTick: (now: number) => void,
  offsets: ServerOffset = new ServerOffset(),
): () => void {
  const offset: number = offsets.for(serverNow);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function wait(now: number, at: number): void {
    // A longer delay overflows setTimeout and fires at once, so a far mark is reached in steps.
    const partial: boolean = at - now > MAX_STEP_MS;
    timer = setTimeout(
      () => {
        if (partial) {
          wait(Date.now() + offset, at);
          return;
        }
        // A timer can fire a moment early; the clock still reads the mark it was set for.
        const reached: number = Math.max(Date.now() + offset, at);
        onTick(reached);
        schedule(reached);
      },
      partial ? MAX_STEP_MS : at - now,
    );
  }
  function schedule(now: number): void {
    const at: number | null = next(now);
    if (at !== null) wait(now, at);
  }
  schedule(Date.now() + offset);
  return (): void => clearTimeout(timer);
}
