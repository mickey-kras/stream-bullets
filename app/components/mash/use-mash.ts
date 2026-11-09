import { useEffect, useRef, useState } from "react";
import { nextMark } from "../../lib/clock";
import { MASH_ASSISTED_RATE, MASH_BATCH_MS, MASH_MAX_BATCH, MASH_RATE, mashPhaseAt, secondsLeft } from "../../lib/mash";
import type { Entry, MashPhase, MashState } from "../../types";
import { sendLive, useMashLive, type MashDenial } from "../live";
import { useMarkClock } from "../use-clock";

export type MashAssist = "off" | "hold" | "toggle";

/** The battle as the page shows it now: the newest of the loader, the snapshot and the 5 Hz ticks. */
export interface MashView extends MashState {
  /** The phase at `now`. */
  current: MashPhase;
  left: number;
  /** Milliseconds left in a live battle, 0 otherwise. */
  msLeft: number;
  tps: number;
  /** Your taps the room accepted, when known. */
  mine: number | null;
  denied: MashDenial | null;
}

export function useMashView(entry: Pick<Entry, "id" | "mash">, now: number): MashView | null {
  const live = useMashLive();
  const mash = entry.mash;
  if (!mash) return null;
  const tick = live.ticks[entry.id];
  // A tick belongs to this run of the battle only while the stored phase is still running.
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

/**
 * The instants a running battle's display changes: its start, its end, and the start of its last batch window.
 * The clock also wakes each whole second before them, so the countdown and the seconds
 * left change on time too.
 */
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

/** The next instant after `now` that a mark, or a whole second before it, falls on. Null with no mark ahead. */
export function nextBattleChange(now: number, marks: readonly number[]): number | null {
  return nextMark(now, marks, 1_000);
}

/**
 * The server clock for a page with Mash Battles. With no battle running it ticks once a second. While one runs,
 * it wakes exactly at each mark from `battleMarks`, so a battle starts and ends on time for every viewer instead
 * of on their next one-second tick.
 */
export function useBattleClock(serverNow: number, marks: readonly number[]): number {
  return useMarkClock(serverNow, marks, 1_000, 1_000);
}

/**
 * Taps waiting to be sent. At most MASH_MAX_BATCH wait: while the socket is down, more taps are dropped instead
 * of piling up, so one message never carries more than the room counts.
 */
export class TapBatch {
  private unsent: number = 0;

  get size(): number {
    return this.unsent;
  }

  /** Adds one tap. False when the batch is full and the tap was dropped. */
  add(): boolean {
    if (this.unsent >= MASH_MAX_BATCH) return false;
    this.unsent += 1;
    return true;
  }

  /** Sends the waiting taps in one message. They keep waiting when `send` fails (the socket is down). */
  flush(send: (n: number) => boolean): void {
    if (this.unsent === 0) return;
    const n: number = Math.min(this.unsent, MASH_MAX_BATCH);
    if (send(n)) this.unsent -= n;
  }
}

let sequence = 0;

/** Sends `n` taps for battle `id` over the page's live connection. */
function tapSender(id: string, assisted: boolean): (n: number) => boolean {
  return (n: number): boolean => {
    sequence += 1;
    return sendLive({ t: "tap", id, n, assisted, seq: sequence });
  };
}

/**
 * Counts your taps and sends them in one message every 200 ms. Taps faster than the per-account
 * cap (15 a second, 6 with assisted tapping) are dropped here as well as on the server. `tap()` returns
 * whether the tap counted locally. With assisted tapping, `setHolding(true)` taps on its own at 6 a second.
 * In the `final` batch window before the end, each tap goes out at once, so the last taps reach the room before
 * the battle ends. Taps still waiting when tapping stops are sent too.
 */
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

  // `final` restarts this effect on purpose: the cleanup sends what waits as the last window opens.
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
