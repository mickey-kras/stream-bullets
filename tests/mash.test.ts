import { describe, expect, it } from "vitest";
import {
  bucketCapacity,
  MASH_ASSISTED_RATE,
  MASH_BATCH_MS,
  MASH_DRAW,
  MASH_MAX_BATCH,
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
import { withSnapshotRuns, type MashLive } from "../app/components/live";
import { battleMarks, TapBatch } from "../app/components/mash/use-mash";
import { nextMark } from "../app/lib/clock";
import type { Entry, LiveSnapshot, MashPhase } from "../app/types";

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

  it("allows a burst of one second and no more", (): void => {
    expect(bucketCapacity(false)).toBe(MASH_RATE);
    expect(bucketCapacity(true)).toBe(MASH_ASSISTED_RATE);
    const first = takeTaps(undefined, 20, false, 1_000);
    expect(first.accepted).toBe(15);
    const second = takeTaps(first.bucket, 20, false, 1_000);
    expect(second.accepted).toBe(0);
  });

  it("counts every tap of an honest tapper when network jitter bunches batches", (): void => {
    // 3 taps every 200 ms is the 15 a second cap. Batches 2 and 3 arrive together, 400 ms after batch 1, and
    // batch 5 waits behind batch 6.
    const arrivals = [0, 400, 400, 600, 1_000, 1_000, 1_200];
    let bucket: TokenBucket | undefined = takeTaps(undefined, 15, false, -1_000).bucket;
    let accepted = 0;
    for (const at of arrivals) {
      const result = takeTaps(bucket, 3, false, at);
      bucket = result.bucket;
      accepted += result.accepted;
    }
    expect(accepted).toBe(arrivals.length * 3);
  });

  it("refills fractional tokens so slow taps still add up", (): void => {
    const empty: TokenBucket = { tokens: 0, at: 0 };
    expect(takeTaps(empty, 1, false, 50).accepted).toBe(0);
    expect(takeTaps(empty, 1, false, 67).accepted).toBe(1);
  });

  it("ignores negative, oversized and fractional requests", (): void => {
    expect(takeTaps(undefined, -5, false, 0).accepted).toBe(0);
    expect(takeTaps(undefined, 1.5, false, 0).accepted).toBe(0);
    expect(takeTaps(undefined, 1_000, false, 0).accepted).toBe(MASH_RATE);
  });

  it("never refills from a clock that goes backwards", (): void => {
    const spent = takeTaps(undefined, 15, false, 5_000).bucket;
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
    expect(tapUpserts("battle", 1, [])).toEqual([]);
    expect(tapUpserts("battle", 1, [delta(1, 0)])).toEqual([]);
  });

  it("splits rows so each statement stays under the D1 parameter limit", (): void => {
    const deltas = Array.from({ length: 45 }, (_: unknown, index: number) => delta(index));
    const statements = tapUpserts("battle", 1, deltas);
    expect(statements).toHaveLength(3);
    expect(statements.map((statement) => statement.params.length)).toEqual([96, 96, 36]);
    expect(TAP_ROWS_PER_STATEMENT * 5 + 1).toBeLessThanOrEqual(100);
  });

  it("stores running totals that only grow, so writing them twice changes nothing", (): void => {
    const [statement] = tapUpserts("battle", 1_000, [delta(1, 5, 2)]);
    expect(statement.sql).toContain("taps=max(mash_taps.taps,excluded.taps)");
    expect(statement.sql).toContain("assisted_taps=max(mash_taps.assisted_taps,excluded.assisted_taps)");
    expect(statement.params).toEqual(["battle", "user-1", 1, 5, 2, 1_000]);
  });

  it("never stores more assisted taps than taps", (): void => {
    const [statement] = tapUpserts("battle", 1, [delta(2, 3, 9)]);
    expect(statement.params.at(-2)).toBe(3);
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

describe("Mash Battle runs", (): void => {
  it("writes taps only into the run they were made in", (): void => {
    const [statement] = tapUpserts("battle", 5_000, [{ userId: "user-1", side: 0, taps: 2, assisted: 0 }]);
    // A restart deletes the taps and a new start gives a new start time, so a late write of the old run is skipped.
    expect(statement.sql).toContain("JOIN entry_mash m ON m.entry_id=v.column1 AND m.starts_at IS ?");
    expect(statement.sql).toContain("m.phase IN ('countdown','live')");
    expect(statement.params.at(-1)).toBe(5_000);
  });
});

describe("Mash Battle client batches", (): void => {
  it("keeps at most one message of taps while the socket is down", (): void => {
    const batch = new TapBatch();
    for (let index = 0; index < 30; index += 1) batch.add();
    expect(batch.size).toBe(MASH_MAX_BATCH);
    expect(batch.add()).toBe(false);
    batch.flush((): boolean => false);
    expect(batch.size).toBe(MASH_MAX_BATCH);
    const sent: number[] = [];
    batch.flush((n: number): boolean => {
      sent.push(n);
      return true;
    });
    expect(sent).toEqual([MASH_MAX_BATCH]);
    expect(batch.size).toBe(0);
  });

  it("sends nothing when no taps wait", (): void => {
    const batch = new TapBatch();
    let calls = 0;
    batch.flush((): boolean => {
      calls += 1;
      return true;
    });
    expect(calls).toBe(0);
  });
});

describe("Mash Battle clock", (): void => {
  const battle = (phase: MashPhase, startsAt: number | null, endsAt: number | null): Pick<Entry, "mash"> => ({
    mash: { durationS: 10, phase, startsAt, endsAt, winner: null, totals: [0, 0], players: 0, assisted: 0 },
  });

  it("wakes exactly at the start, the last batch window and the end of a running battle", (): void => {
    const marks = battleMarks([battle("countdown", 3_000, 13_000), battle("setup", null, null), null]);
    expect(marks).toEqual([3_000, 13_000, 13_000 - MASH_BATCH_MS]);
    // The old 1 Hz clock woke at a random point in each second, so the start showed up to 1 s late.
    expect(nextMark(2_400, marks, 1_000)).toBe(2_800);
    expect(nextMark(2_800, marks, 1_000)).toBe(3_000);
    expect(nextMark(3_000, marks, 1_000)).toBe(3_800);
    expect(nextMark(12_100, marks, 1_000)).toBe(12_800);
    expect(nextMark(12_800, marks, 1_000)).toBe(13_000);
    expect(nextMark(13_000, marks, 1_000)).toBeNull();
  });

  it("ignores finished battles and battles with no times", (): void => {
    expect(battleMarks([battle("finished", 0, 10_000), battle("live", null, null)])).toEqual([]);
  });
});

describe("Mash Battle taps across a restart", (): void => {
  const snapshot = (phase: MashPhase, startsAt: number | null): Pick<LiveSnapshot, "polls"> => ({
    polls: [
      {
        id: "battle",
        title: "Which?",
        kind: "mash",
        options: ["A", "B"],
        endsAt: null,
        revealed: false,
        counts: [0, 0],
        total: 0,
        mash: { durationS: 10, phase, startsAt, endsAt: null, winner: null, totals: [0, 0], players: 0, assisted: 0 },
      },
    ],
  });

  it("forgets your taps and refusals when the battle restarts", (): void => {
    let state: MashLive = withSnapshotRuns({ ticks: {}, mine: {}, denied: {}, runs: {} }, snapshot("live", 1_000));
    state = { ...state, mine: { battle: 12 }, denied: { battle: "closed" } };
    // The same run again (a reconnect, the finish) keeps them, and the very same object comes back.
    expect(withSnapshotRuns(state, snapshot("finished", 1_000))).toBe(state);
    const restarted = withSnapshotRuns(state, snapshot("setup", 1_000));
    expect(restarted.mine).toEqual({});
    expect(restarted.denied).toEqual({});
    const again = withSnapshotRuns({ ...restarted, mine: { battle: 3 } }, snapshot("live", 9_000));
    expect(again.mine).toEqual({});
  });
});
