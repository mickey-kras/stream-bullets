import { useEffect, useRef, useState } from "react";
import { MASH_ASSISTED_RATE, MASH_BATCH_MS, MASH_MAX_BATCH, MASH_RATE, mashPhaseAt, secondsLeft } from "../../lib/mash";
import type { Entry, MashPhase, MashState } from "../../types";
import { sendLive, useMashLive, type MashDenial } from "../live";
import { useMarkClock } from "../use-clock";

export type MashAssist = "off" | "hold" | "toggle";

// Use the newest loader, snapshot or 5 Hz tick state.
export interface MashView extends MashState {
  current: MashPhase;
  left: number;
  // Live milliseconds remaining; zero otherwise.
  msLeft: number;
  tps: number;
  // Accepted tap count, when known.
  mine: number | null;
  denied: MashDenial | null;
}

export function useMashView(entry: Pick<Entry, "id" | "mash">, now: number): MashView | null {
  const live = useMashLive();
  const mash = entry.mash;
  if (!mash) return null;
  const tick = live.ticks[entry.id];
  // Accept ticks only for the current running battle.
  const running = mash.phase === "countdown" || mash.phase === "live";
  const fresh = running && tick !== undefined && tick.endsAt !== null && tick.endsAt === mash.endsAt;
  const view: MashState = fresh
    ? { ...mash, totals: tick.totals, players: tick.players, assisted: tick.assisted }
    : mash;
  const current = mashPhaseAt(view, now);
  return {
    ...view,
    current,
    left: current === "live" ? secondsLeft(view.endsAt, now) : 0,
    msLeft: current === "live" && view.endsAt !== null ? Math.max(0, view.endsAt - now) : 0,
    tps: fresh ? tick.tps : 0,
    mine: live.mine[entry.id] ?? null,
    denied: live.denied[entry.id] ?? null,
  };
}

// Wake at start, end, final batch window and intervening whole seconds.
export function battleMarks(entries: readonly (Pick<Entry, "mash"> | null)[]): number[] {
  const marks: number[] = [];
  for (const entry of entries) {
    const mash = entry?.mash;
    if (!mash || (mash.phase !== "countdown" && mash.phase !== "live")) continue;
    if (mash.startsAt !== null) marks.push(mash.startsAt);
    if (mash.endsAt !== null) marks.push(mash.endsAt, mash.endsAt - MASH_BATCH_MS);
  }
  return marks;
}

// Idle battles tick each second. Running battles also wake at exact battleMarks boundaries.
export function useBattleClock(serverNow: number, marks: readonly number[]): number {
  return useMarkClock(serverNow, marks, 1_000, 1_000);
}

// Bound pending taps to MASH_MAX_BATCH; drop excess while disconnected.
export class TapBatch {
  private unsent: number = 0;

  get size(): number {
    return this.unsent;
  }

  // Return false when the batch is full.
  add(): boolean {
    if (this.unsent >= MASH_MAX_BATCH) return false;
    this.unsent += 1;
    return true;
  }

  // Retain pending taps if send fails.
  flush(send: (n: number) => boolean): void {
    if (this.unsent === 0) return;
    const n: number = Math.min(this.unsent, MASH_MAX_BATCH);
    if (send(n)) this.unsent -= n;
  }
}

let sequence = 0;

function tapSender(id: string, assisted: boolean): (n: number) => boolean {
  return (n: number): boolean => {
    sequence += 1;
    return sendLive({ t: "tap", id, n, assisted, seq: sequence });
  };
}

// Batch every 200 ms; enforce 15/s manual or 6/s assisted locally and server-side. tap() reports local
// acceptance. Holding assists at 6/s. Send immediately in the final window and flush when tapping stops.
export function useMashTapper(
  id: string,
  enabled: boolean,
  assisted: boolean,
  final: boolean,
): { taps: number; tap: () => boolean; holding: boolean; setHolding: (value: boolean) => void } {
  const [taps, setTaps] = useState<number>(0);
  const [holding, setHolding] = useState<boolean>(false);
  const [batch] = useState<TapBatch>(() => new TapBatch());
  const lastTap = useRef<number>(0);
  const gap: number = 1_000 / (assisted ? MASH_ASSISTED_RATE : MASH_RATE);

  function tap(): boolean {
    if (!enabled) return false;
    const now: number = performance.now();
    if (now - lastTap.current < gap || !batch.add()) return false;
    lastTap.current = now;
    setTaps((value: number) => value + 1);
    if (final) batch.flush(tapSender(id, assisted));
    return true;
  }

  // Changing final flushes pending taps through effect cleanup.
  useEffect(() => {
    if (!enabled) return;
    const send = tapSender(id, assisted);
    const timer = setInterval(() => batch.flush(send), MASH_BATCH_MS);
    return (): void => {
      clearInterval(timer);
      batch.flush(send);
    };
  }, [id, enabled, assisted, final, batch]);

  const active: boolean = enabled && assisted && holding;
  useEffect(() => {
    if (!active) return;
    const send = tapSender(id, assisted);
    const timer = setInterval(() => {
      if (!batch.add()) return;
      setTaps((value: number) => value + 1);
      if (final) batch.flush(send);
    }, gap);
    return (): void => clearInterval(timer);
  }, [active, gap, final, batch, id, assisted]);

  return { taps, tap, holding: active, setHolding };
}
