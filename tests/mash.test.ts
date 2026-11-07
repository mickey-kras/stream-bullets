import { describe, expect, it } from "vitest";
import {
  bucketCapacity,
  MASH_ASSISTED_RATE,
  MASH_BATCH_MS,
  MASH_DRAW,
  MASH_RATE,
  mashPhaseAt,
  mashWinner,
  secondsLeft,
  takeTaps,
  TAP_ROWS_PER_STATEMENT,
  tapUpserts,
  type TapDelta,
  type TokenBucket,
} from "../app/lib/mash";

/** Sends `perBatch` taps every 200 ms for `seconds` and returns how many the bucket accepted. */
function simulate(perBatch: number, seconds: number, assisted: boolean): number {
  let bucket: TokenBucket | undefined;
  let accepted = 0;
  for (let now = 0; now < seconds * 1_000; now += MASH_BATCH_MS) {
    const result = takeTaps(bucket, perBatch, assisted, now);
    bucket = result.bucket;
    accepted += result.accepted;
  }
  return accepted;
}

describe("Mash Battle token bucket", (): void => {
  it("holds a fast tapper to 15 taps a second", (): void => {
    const accepted = simulate(20, 10, false);
    // The first batch spends the full bucket. After that the refill is the limit.
    expect(accepted).toBeLessThanOrEqual(MASH_RATE * 10 + bucketCapacity(false));
    expect(accepted).toBeGreaterThanOrEqual(MASH_RATE * 10 - 1);
  });

  it("holds assisted tapping to 6 taps a second", (): void => {
    const accepted = simulate(20, 10, true);
    expect(accepted).toBeLessThanOrEqual(MASH_ASSISTED_RATE * 10 + bucketCapacity(true));
    expect(accepted).toBeGreaterThanOrEqual(MASH_ASSISTED_RATE * 10 - 1);
  });

  it("counts every tap of a viewer under the limit", (): void => {
    // 2 taps every 200 ms is 10 a second.
    expect(simulate(2, 5, false)).toBe(50);
  });

  it("allows a burst of one batch and no more", (): void => {
    expect(bucketCapacity(false)).toBe(4);
    expect(bucketCapacity(true)).toBeCloseTo(2.2);
    const first = takeTaps(undefined, 20, false, 1_000);
    expect(first.accepted).toBe(4);
    const second = takeTaps(first.bucket, 20, false, 1_000);
    expect(second.accepted).toBe(0);
  });

  it("refills fractional tokens so slow taps still add up", (): void => {
    const empty: TokenBucket = { tokens: 0, at: 0 };
    expect(takeTaps(empty, 1, false, 50).accepted).toBe(0);
    expect(takeTaps(empty, 1, false, 67).accepted).toBe(1);
  });

  it("ignores negative, oversized and fractional requests", (): void => {
    expect(takeTaps(undefined, -5, false, 0).accepted).toBe(0);
    expect(takeTaps(undefined, 1.5, false, 0).accepted).toBe(0);
    expect(takeTaps(undefined, 1_000, false, 0).accepted).toBe(4);
  });

  it("never refills from a clock that goes backwards", (): void => {
    const spent = takeTaps(undefined, 4, false, 5_000).bucket;
    expect(takeTaps(spent, 4, false, 1_000).accepted).toBe(0);
  });
});

describe("Mash Battle batching", (): void => {
  const delta = (index: number, taps: number = 3, assisted: number = 0): TapDelta => ({
    userId: `user-${index}`,
    side: index % 2,
    taps,
    assisted,
  });

  it("writes nothing when no taps are pending", (): void => {
    expect(tapUpserts("battle", [])).toEqual([]);
    expect(tapUpserts("battle", [delta(1, 0)])).toEqual([]);
  });

  it("splits rows so each statement stays under the D1 parameter limit", (): void => {
    const deltas = Array.from({ length: 45 }, (_: unknown, index: number) => delta(index));
    const statements = tapUpserts("battle", deltas);
    expect(statements).toHaveLength(3);
    expect(statements.map((statement) => statement.params.length)).toEqual([100, 100, 25]);
    expect(TAP_ROWS_PER_STATEMENT * 5).toBeLessThanOrEqual(100);
  });

  it("adds deltas to the stored counts instead of replacing them", (): void => {
    const [statement] = tapUpserts("battle", [delta(1, 5, 2)]);
    expect(statement.sql).toContain("taps=mash_taps.taps+excluded.taps");
    expect(statement.params).toEqual(["battle", "user-1", 1, 5, 2]);
  });

  it("never stores more assisted taps than taps", (): void => {
    const [statement] = tapUpserts("battle", [delta(2, 3, 9)]);
    expect(statement.params.at(-1)).toBe(3);
  });
});

describe("Mash Battle phases and winner", (): void => {
  it("reads the phase from the clock", (): void => {
    const battle = { phase: "countdown" as const, startsAt: 1_000, endsAt: 11_000 };
    expect(mashPhaseAt(battle, 500)).toBe("countdown");
    expect(mashPhaseAt(battle, 1_000)).toBe("live");
    expect(mashPhaseAt(battle, 11_000)).toBe("finished");
    expect(mashPhaseAt({ phase: "setup", startsAt: null, endsAt: null }, 0)).toBe("setup");
  });

  it("picks the side with the most taps, or a draw", (): void => {
    expect(mashWinner([3, 7, 2])).toBe(1);
    expect(mashWinner([5, 5, 1])).toBe(MASH_DRAW);
    expect(mashWinner([0, 0])).toBe(MASH_DRAW);
  });

  it("rounds the seconds left up", (): void => {
    expect(secondsLeft(10_001, 0)).toBe(11);
    expect(secondsLeft(5_000, 9_000)).toBe(0);
    expect(secondsLeft(null, 0)).toBe(0);
  });
});
