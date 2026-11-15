import { useEffect, useState } from "react";
import { atMark, nextMark, ServerOffset, startClock } from "../lib/clock";
import { SCHEDULE_STEP_MS, scheduleMarks, type Timed } from "../lib/schedule";

// Wake at step boundaries before marks, or every idleMs without a future mark. Otherwise sleep. New serverNow
// restarts synchronization.
export function useMarkClock(
  serverNow: number,
  marks: readonly number[],
  step: number,
  idleMs: number | null = null,
): number {
  const key: string = marks.join(",");
  const [clock, setClock] = useState<{ source: number; now: number }>({ source: serverNow, now: serverNow });
  // Reuse the original offset when new marks restart the clock.
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
  // Never move the clock backward to a delayed snapshot.
  return clock.source === serverNow ? clock.now : Math.max(serverNow, clock.now);
}

// Wake at stream boundaries to advance statuses in open tabs.
export function useScheduleClock(serverNow: number, events: readonly Timed[]): number {
  return useMarkClock(serverNow, scheduleMarks(events), SCHEDULE_STEP_MS);
}

// Revalidate at server time at; null disables it.
export function useRevalidateAt(serverNow: number, at: number | null, revalidate: () => Promise<void>): void {
  const [offsets] = useState<ServerOffset>(() => new ServerOffset());
  useEffect(() => {
    if (at === null) return undefined;
    return atMark(serverNow, at, (): void => void revalidate(), offsets);
  }, [serverNow, at, revalidate, offsets]);
}
