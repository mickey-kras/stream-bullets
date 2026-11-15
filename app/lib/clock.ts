// Server-synchronized clock; wakes only for display changes.
// Next mark or step boundary after now; null without a future mark.
export function nextMark(now: number, marks: readonly number[], step: number): number | null {
  let next: number | null = null;
  for (const mark of marks) {
    if (mark <= now) continue;
    const at: number = mark - (Math.ceil((mark - now) / step) - 1) * step;
    if (next === null || at < next) next = at;
  }
  return next;
}

// Measure offset once per server timestamp. Reuse it when restarting with the same timestamp.
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

// One-day maximum wait avoids setTimeout's 2^31 - 1 ms limit.
const MAX_STEP_MS = 86_400_000;

// Call onReach once at server time at. Return cancellation.
export function atMark(
  serverNow: number,
  at: number,
  onReach: () => void,
  offsets: ServerOffset = new ServerOffset(),
): () => void {
  return startClock(serverNow, (now: number): number | null => (now < at ? at : null), onReach, offsets);
}

// Tick at next's server timestamps. Reuse offsets across restarts. Null stops the clock; the return value
// cancels its timer.
export function startClock(
  serverNow: number,
  next: (now: number) => number | null,
  onTick: (now: number) => void,
  offsets: ServerOffset = new ServerOffset(),
): () => void {
  const offset: number = offsets.for(serverNow);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function wait(now: number, at: number): void {
    // Split long waits to prevent setTimeout overflow.
    const partial: boolean = at - now > MAX_STEP_MS;
    timer = setTimeout(
      () => {
        if (partial) {
          wait(Date.now() + offset, at);
          return;
        }
        // Clamp early timer callbacks to their scheduled mark.
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
