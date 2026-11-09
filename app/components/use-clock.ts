import { useEffect, useState } from "react";
import { atMark, nextMark, ServerOffset, startClock } from "../lib/clock";
import { SCHEDULE_STEP_MS, scheduleMarks, type Timed } from "../lib/schedule";

/**
 * The server's time on this page. It wakes at each whole `step` before every mark ahead and, with `idleMs`, that
 * often while no mark is ahead; otherwise it sleeps. A new `serverNow` (a fresh loader or snapshot) restarts it.
 */
export function useMarkClock(
  serverNow: number,
  marks: readonly number[],
  step: number,
  idleMs: number | null = null,
): number {
  const key: string = marks.join(",");
  const [clock, setClock] = useState<{ source: number; now: number }>({ source: serverNow, now: serverNow });
  // New marks restart the clock long after `serverNow` arrived; the offset stays the one measured then.
  const [offsets] = useState<ServerOffset>(() => new ServerOffset());
  useEffect(() => {
    const points: number[] = key === "" ? [] : key.split(",").map(Number);
    return startClock(
      serverNow,
      (now: number): number | null => nextMark(now, points, step) ?? (idleMs === null ? null : now + idleMs),
      (now: number): void => setClock({ source: serverNow, now }),
      offsets,
    );
  }, [serverNow, key, step, idleMs, offsets]);
  // A new snapshot's time is a little old when it arrives, so the clock never steps back to it.
  return clock.source === serverNow ? clock.now : Math.max(serverNow, clock.now);
}

/** The server's time for a schedule: it wakes as each stream starts and ends, so an open tab's statuses move on. */
export function useScheduleClock(serverNow: number, events: readonly Timed[]): number {
  return useMarkClock(serverNow, scheduleMarks(events), SCHEDULE_STEP_MS);
}

/** Calls `revalidate` once the server clock reaches `at`; does nothing while `at` is null. */
export function useRevalidateAt(serverNow: number, at: number | null, revalidate: () => Promise<void>): void {
  const [offsets] = useState<ServerOffset>(() => new ServerOffset());
  useEffect(() => {
    if (at === null) return undefined;
    return atMark(serverNow, at, (): void => void revalidate(), offsets);
  }, [serverNow, at, revalidate, offsets]);
}
