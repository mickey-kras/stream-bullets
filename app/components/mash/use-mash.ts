import { useEffect, useRef, useState } from "react";
import { MASH_ASSISTED_RATE, MASH_BATCH_MS, MASH_RATE, mashPhaseAt, secondsLeft } from "../../lib/mash";
import type { Entry, MashPhase, MashState } from "../../types";
import { sendLive, useMashLive, type MashDenial } from "../live";

export type MashAssist = "off" | "hold" | "toggle";

/** The battle as the page shows it now: the newest of the loader, the snapshot and the 5 Hz ticks. */
export interface MashView extends MashState {
  /** The phase at `now`. */
  current: MashPhase;
  left: number;
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
    tps: fresh ? tick.tps : 0,
    mine: live.mine[entry.id] ?? null,
    denied: live.denied[entry.id] ?? null,
  };
}

let sequence = 0;

/**
 * Counts your taps and sends them in one message every 200 ms. Taps faster than the per-account
 * cap (15 a second, 6 with assisted tapping) are dropped here as well as on the server. `tap()` returns
 * whether the tap counted locally. With assisted tapping, `setHolding(true)` taps on its own at 6 a second.
 */
export function useMashTapper(
  id: string,
  enabled: boolean,
  assisted: boolean,
): { taps: number; tap: () => boolean; holding: boolean; setHolding: (value: boolean) => void } {
  const [taps, setTaps] = useState<number>(0);
  const [holding, setHolding] = useState<boolean>(false);
  const unsent = useRef<number>(0);
  const lastTap = useRef<number>(0);
  const gap: number = 1_000 / (assisted ? MASH_ASSISTED_RATE : MASH_RATE);

  function tap(): boolean {
    if (!enabled) return false;
    const now: number = performance.now();
    if (now - lastTap.current < gap) return false;
    lastTap.current = now;
    unsent.current += 1;
    setTaps((value: number) => value + 1);
    return true;
  }

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (unsent.current === 0) return;
      sequence += 1;
      if (sendLive({ t: "tap", id, n: unsent.current, assisted, seq: sequence })) unsent.current = 0;
    }, MASH_BATCH_MS);
    return (): void => clearInterval(timer);
  }, [id, enabled, assisted]);

  const active: boolean = enabled && assisted && holding;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      unsent.current += 1;
      setTaps((value: number) => value + 1);
    }, gap);
    return (): void => clearInterval(timer);
  }, [active, gap]);

  return { taps, tap, holding: active, setHolding };
}
