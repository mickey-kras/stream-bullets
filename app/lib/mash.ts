import type { MashPhase } from "../types";

/**
 * Mash Battle rules shared by the live room (app/server/poll-room.ts), the API and the client.
 * Everything here is pure, so the unit tests run it without a Worker runtime.
 */

/** The product name. Rename here only (R9). */
export const MASH_NAME = "Mash Battle";
/** Taps a second one account can score, and the rate with assisted tapping (hold or toggle). */
export const MASH_RATE = 15;
export const MASH_ASSISTED_RATE = 6;
/** The client sends its taps in one message every this many milliseconds. */
export const MASH_BATCH_MS = 200;
/** The most taps one message may carry. The token bucket then decides how many count. */
export const MASH_MAX_BATCH = 20;
/** The room broadcasts totals this often while a battle is live (5 Hz). */
export const MASH_TICK_MS = 200;
/** The room writes the tap deltas to D1 this often. */
export const MASH_FLUSH_MS = 1_000;
/** The 3-2-1 countdown before a battle goes live. */
export const MASH_COUNTDOWN_MS = 3_000;
/** Battle lengths the create dialog offers, in seconds. The database allows 10 to 120. */
export const MASH_DURATIONS = [10, 15, 30, 45, 60, 120] as const;
export const MASH_MIN_SIDES = 2;
export const MASH_MAX_SIDES = 4;
export const MASH_SIDE_LENGTH = 24;
/** `winner` for a tie at the top, or a battle with no taps (R9: "Draw"). */
export const MASH_DRAW = -1;

/** Per-account rate limit state. `tokens` may be fractional so slow taps still add up. */
export interface TokenBucket {
  tokens: number;
  at: number;
}

/** The burst one account may spend at once: one batch at the full rate, plus one for rounding. */
export function bucketCapacity(assisted: boolean): number {
  const rate: number = assisted ? MASH_ASSISTED_RATE : MASH_RATE;
  return (rate * MASH_BATCH_MS) / 1_000 + 1;
}

/**
 * Spends up to `requested` taps from the bucket and returns how many count. The bucket refills at
 * 15 taps a second (6 when `assisted`) up to one batch. Sockets of one account share one bucket.
 */
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

/** The phase a battle is in at `now`. A missed end (the room was offline) still reads as finished. */
export function mashPhaseAt(
  mash: { phase: MashPhase; startsAt: number | null; endsAt: number | null },
  now: number,
): MashPhase {
  if (mash.phase === "setup" || mash.phase === "finished") return mash.phase;
  if (mash.endsAt !== null && now >= mash.endsAt) return "finished";
  if (mash.startsAt !== null && now < mash.startsAt) return "countdown";
  return "live";
}

/** The winning side, or MASH_DRAW for a tie at the top or no taps at all. */
export function mashWinner(totals: readonly number[]): number {
  const best: number = Math.max(0, ...totals);
  if (best === 0) return MASH_DRAW;
  const leaders: number[] = totals.flatMap((total: number, side: number): number[] => (total === best ? [side] : []));
  return leaders.length === 1 ? leaders[0] : MASH_DRAW;
}

/** Whole seconds left in a live battle. */
export function secondsLeft(endsAt: number | null, now: number): number {
  return endsAt === null ? 0 : Math.max(0, Math.ceil((endsAt - now) / 1_000));
}

/** One account's taps not yet written to D1. */
export interface TapDelta {
  userId: string;
  side: number;
  taps: number;
  assisted: number;
}

/** D1 binds at most 100 parameters per statement, and each row takes 5. */
export const TAP_ROWS_PER_STATEMENT = 20;

/**
 * The statements that add the deltas to `mash_taps`, at most 20 rows each. Rows for an account or
 * battle deleted since the tap are skipped (the joins), so one deletion never fails the batch.
 */
export function tapUpserts(entryId: string, deltas: readonly TapDelta[]): { sql: string; params: (string | number)[] }[] {
  const rows: TapDelta[] = deltas.filter((delta: TapDelta): boolean => delta.taps > 0);
  const statements: { sql: string; params: (string | number)[] }[] = [];
  for (let start = 0; start < rows.length; start += TAP_ROWS_PER_STATEMENT) {
    const chunk: TapDelta[] = rows.slice(start, start + TAP_ROWS_PER_STATEMENT);
    statements.push({
      sql: `INSERT INTO mash_taps (entry_id,user_id,side,taps,assisted_taps)
        SELECT v.column1,v.column2,v.column3,v.column4,v.column5
        FROM (VALUES ${chunk.map((): string => "(?,?,?,?,?)").join(",")}) v
        JOIN user u ON u.id=v.column2 JOIN entries e ON e.id=v.column1 WHERE true
        ON CONFLICT(entry_id,user_id) DO UPDATE SET taps=mash_taps.taps+excluded.taps,
          assisted_taps=mash_taps.assisted_taps+excluded.assisted_taps`,
      params: chunk.flatMap((delta: TapDelta): (string | number)[] => [
        entryId,
        delta.userId,
        delta.side,
        delta.taps,
        Math.min(delta.assisted, delta.taps),
      ]),
    });
  }
  return statements;
}
