import type { MashPhase } from "../types";

// Pure Mash rules shared by live room, API and client; testable without Workers.
// Single source for the product name.
export const MASH_NAME = "Mash Battle";
// Per-account tap rates: manual and assisted.
export const MASH_RATE = 15;
export const MASH_ASSISTED_RATE = 6;
// Client tap batch interval (ms).
export const MASH_BATCH_MS = 200;
// Maximum taps per message; token bucket determines accepted taps.
export const MASH_MAX_BATCH = 20;
// Live broadcast interval (5 Hz).
export const MASH_TICK_MS = 200;
// D1 flush interval.
export const MASH_FLUSH_MS = 1_000;
// 3-2-1 countdown.
export const MASH_COUNTDOWN_MS = 3_000;
// Offered durations (seconds). Database range: 10..120.
export const MASH_DURATIONS = [10, 15, 30, 45, 60, 120] as const;
export const MASH_MIN_SIDES = 2;
export const MASH_MAX_SIDES = 4;
export const MASH_SIDE_LENGTH = 24;
// Tie or no-tap winner value.
export const MASH_DRAW = -1;

// Fractional tokens preserve slow taps.
export interface TokenBucket {
  tokens: number;
  at: number;
}

// One-second burst tolerates network jitter while retaining the 15/s manual or 6/s assisted average.
export function bucketCapacity(assisted: boolean): number {
  return assisted ? MASH_ASSISTED_RATE : MASH_RATE;
}

// Shared account bucket refills at 15/s, or 6/s assisted, capped at one second. Return accepted taps.
export function takeTaps(
  bucket: TokenBucket | undefined,
  requested: number,
  assisted: boolean,
  now: number,
): { bucket: TokenBucket; accepted: number } {
  const rate: number = assisted ? MASH_ASSISTED_RATE : MASH_RATE;
  const capacity: number = bucketCapacity(assisted);
  const elapsed: number = bucket ? Math.max(0, now - bucket.at) : Number.POSITIVE_INFINITY;
  const tokens: number = Math.min(capacity, (bucket?.tokens ?? capacity) + (elapsed * rate) / 1_000);
  const wanted: number = Number.isSafeInteger(requested) ? Math.min(MASH_MAX_BATCH, Math.max(0, requested)) : 0;
  const accepted: number = Math.min(wanted, Math.floor(tokens));
  return { bucket: { tokens: tokens - accepted, at: now }, accepted };
}

// Derive phase at now, including ends missed while offline.
export function mashPhaseAt(
  mash: { phase: MashPhase; startsAt: number | null; endsAt: number | null },
  now: number,
): MashPhase {
  if (mash.phase === "setup" || mash.phase === "finished") return mash.phase;
  if (mash.endsAt !== null && now >= mash.endsAt) return "finished";
  if (mash.startsAt !== null && now < mash.startsAt) return "countdown";
  return "live";
}

// Return MASH_DRAW for tied leaders or no taps.
export function mashWinner(totals: readonly number[]): number {
  const best: number = Math.max(0, ...totals);
  if (best === 0) return MASH_DRAW;
  const leaders: number[] = totals.flatMap((total: number, side: number): number[] => (total === best ? [side] : []));
  return leaders.length === 1 ? leaders[0] : MASH_DRAW;
}

// Whole seconds remaining.
export function secondsLeft(endsAt: number | null, now: number): number {
  return endsAt === null ? 0 : Math.max(0, Math.ceil((endsAt - now) / 1_000));
}

// Per-account running totals for D1.
export interface TapDelta {
  userId: string;
  side: number;
  taps: number;
  assisted: number;
}

// D1 limit: 100 parameters; five per row plus one run start.
export const TAP_ROWS_PER_STATEMENT = 19;

// Write at most 19 totals per statement. Monotonic totals make retries idempotent. Joins skip deleted
// accounts/battles and stale or ended runs, preventing late writes into a restart.
export function tapUpserts(
  entryId: string,
  startsAt: number | null,
  deltas: readonly TapDelta[],
): { sql: string; params: (string | number | null)[] }[] {
  const rows: TapDelta[] = deltas.filter((delta: TapDelta): boolean => delta.taps > 0);
  const statements: { sql: string; params: (string | number | null)[] }[] = [];
  for (let start = 0; start < rows.length; start += TAP_ROWS_PER_STATEMENT) {
    const chunk: TapDelta[] = rows.slice(start, start + TAP_ROWS_PER_STATEMENT);
    statements.push({
      sql: `INSERT INTO mash_taps (entry_id,user_id,side,taps,assisted_taps)
        SELECT v.column1,v.column2,v.column3,v.column4,v.column5
        FROM (VALUES ${chunk.map((): string => "(?,?,?,?,?)").join(",")}) v
        JOIN user u ON u.id=v.column2 JOIN entries e ON e.id=v.column1
        JOIN entry_mash m ON m.entry_id=v.column1 AND m.starts_at IS ? AND m.phase IN ('countdown','live') WHERE true
        ON CONFLICT(entry_id,user_id) DO UPDATE SET taps=max(mash_taps.taps,excluded.taps),
          assisted_taps=max(mash_taps.assisted_taps,excluded.assisted_taps)`,
      params: [
        ...chunk.flatMap((delta: TapDelta): (string | number)[] => [
          entryId,
          delta.userId,
          delta.side,
          delta.taps,
          Math.min(delta.assisted, delta.taps),
        ]),
        startsAt,
      ],
    });
  }
  return statements;
}
