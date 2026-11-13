import { describe, expect, it } from "vitest";
import type { ActivityChat, ActivityMessage } from "../app/lib/activity";
import {
  CHAT_LIMITS,
  chatReducer,
  initialChatState,
  nextWakeAt,
  type ChatOptions,
  type ChatRow,
  type ChatState,
} from "../app/lib/chat-feed";
import {
  goneWakeAt,
  nextGone,
  pruneGone,
  shownRows,
  type FadeLimits,
  type GoneRow,
  type ShownRow,
} from "../app/lib/fading-rows";

const limits: FadeLimits = {
  leaveMs: CHAT_LIMITS.leaveMs,
  maxLeaving: CHAT_LIMITS.maxLeaving,
  removedHoldMs: CHAT_LIMITS.removedHoldMs,
};
const HOLD: number = CHAT_LIMITS.removedHoldMs;
const options: ChatOptions = { hideCommands: true };

function row(seq: number, phase: ChatRow["phase"] = "shown", phaseAt: number = 0): ChatRow {
  return {
    id: `twitch:r${seq}`,
    seq,
    platform: "twitch",
    userId: "u1",
    name: "User",
    badges: [],
    fragments: [{ type: "text", text: `row ${seq}` }],
    truncated: false,
    receivedAt: 0,
    shownAt: 0,
    phase,
    phaseAt,
    animate: false,
    command: false,
  };
}

function chat(index: number, now: number): ActivityChat {
  return {
    kind: "chat",
    id: `twitch:f${index}`,
    platform: "twitch",
    channelId: "c1",
    messageId: `f${index}`,
    user: { id: `spammer-${index}`, displayName: "Spammer" },
    text: `spam ${index}`,
    fragments: [{ type: "text", text: `spam ${index}` }],
    badges: [],
    sentAt: null,
    receivedAt: now,
    live: true,
  };
}

function ids(items: readonly { row: ChatRow }[]): string[] {
  return items.map((item: { row: ChatRow }): string => item.row.id);
}

describe("pruneGone", () => {
  it("drops the rows whose fade ended and keeps the same array when none ended", () => {
    const gone: GoneRow[] = [
      { row: row(1, "removed"), goneAt: 0 },
      { row: row(2, "removed"), goneAt: 200 },
    ];
    expect(pruneGone(gone, 299, limits)).toBe(gone);
    expect(ids(pruneGone(gone, 300, limits))).toEqual(["twitch:r2"]);
    expect(pruneGone(gone, 500, limits)).toEqual([]);
  });
});

describe("goneWakeAt", () => {
  it("is the end of the fade that ends first, or null without fading rows", () => {
    expect(goneWakeAt([], limits)).toBeNull();
    expect(
      goneWakeAt(
        [
          { row: row(1, "removed"), goneAt: 500 },
          { row: row(2, "removed"), goneAt: 100 },
        ],
        limits,
      ),
    ).toBe(400);
  });
});

describe("nextGone", () => {
  it("starts a fade for a removed row that the reducer dropped, at the end of its hold", () => {
    const removed: ChatRow = row(1, "removed", 1_000);
    const next = nextGone([], [removed, row(2)], [row(2)], limits);
    expect(next).toEqual([{ row: removed, goneAt: 1_000 + HOLD }]);
  });

  it("does not fade a dropped row that was not removed", () => {
    const prevGone: GoneRow[] = [];
    expect(nextGone(prevGone, [row(1, "leaving"), row(2)], [row(2)], limits)).toBe(prevGone);
  });

  it("returns the same array when nothing changes", () => {
    const prevGone: GoneRow[] = [{ row: row(1, "removed"), goneAt: 0 }];
    expect(nextGone(prevGone, [row(1, "removed")], [row(2)], limits)).toBe(prevGone);
  });

  it("ends the fades that ended before a newer fade starts, and a fade whose row is back", () => {
    const a: ChatRow = row(1, "removed");
    const b: ChatRow = row(2, "removed");
    const prevGone: GoneRow[] = [
      { row: a, goneAt: 0 },
      { row: b, goneAt: 200 },
    ];
    // Row 3 drops at 300 (its hold ended): the fade of row 1 has ended by then.
    const c: ChatRow = row(3, "removed", 300 - HOLD);
    expect(ids(nextGone(prevGone, [c], [], limits))).toEqual(["twitch:r2", "twitch:r3"]);
    expect(ids(nextGone(prevGone, [], [b], limits))).toEqual(["twitch:r1"]);
  });

  it("keeps the newest fades within maxLeaving, less the leaving rows", () => {
    const prevRows: ChatRow[] = [1, 2, 3, 4].map((seq: number): ChatRow => row(seq, "removed"));
    const small: FadeLimits = { ...limits, maxLeaving: 3 };
    expect(ids(nextGone([], prevRows, [], small))).toEqual(["twitch:r2", "twitch:r3", "twitch:r4"]);
    expect(ids(nextGone([], prevRows, [row(9, "leaving")], small))).toEqual(["twitch:r3", "twitch:r4"]);
    const full: ChatRow[] = [row(7, "leaving"), row(8, "leaving"), row(9, "leaving"), row(10, "leaving")];
    expect(nextGone([], prevRows, full, small)).toEqual([]);
  });
});

describe("shownRows", () => {
  it("merges fading rows in arrival order and marks the newest active row", () => {
    const shown: ShownRow[] = shownRows(
      [row(1), row(3, "removed")],
      [
        { row: row(4, "removed"), goneAt: 0 },
        { row: row(2, "removed"), goneAt: 0 },
      ],
    );
    expect(shown.map((item: ShownRow): [number, boolean, boolean] => [item.row.seq, item.gone, item.newest])).toEqual([
      [1, false, true],
      [2, true, false],
      [3, false, false],
      [4, true, false],
    ]);
  });

  it("marks an entering row and no leaving row as the newest", () => {
    const shown: ShownRow[] = shownRows([row(1), row(2, "entering"), row(3, "leaving")], []);
    expect(shown.map((item: ShownRow): boolean => item.newest)).toEqual([false, true, false]);
    expect(shownRows([row(1, "removed")], []).some((item: ShownRow): boolean => item.newest)).toBe(false);
  });
});

describe("a sustained delete flood", () => {
  it("never renders more than maxRows + maxLeaving rows", () => {
    // A message every 100 ms, each deleted 50 ms later, for 60 seconds, with the real chat reducer.
    let state: ChatState = initialChatState();
    let gone: readonly GoneRow[] = [];
    let most = 0;
    let fadesSeen = 0;
    const apply = (next: ChatState, now: number): void => {
      if (next !== state) {
        const after: readonly GoneRow[] = nextGone(gone, state.rows, next.rows, limits);
        // A fade starts when the reducer drops the row.
        for (const item of after) if (!gone.includes(item)) expect(item.goneAt).toBe(now);
        if (after.length > gone.length) fadesSeen += 1;
        gone = after;
        state = next;
      }
      const shown: number = shownRows(state.rows, gone).length;
      most = Math.max(most, shown);
      expect(shown).toBeLessThanOrEqual(CHAT_LIMITS.maxRows + CHAT_LIMITS.maxLeaving);
    };
    const send = (message: ActivityMessage, now: number): void =>
      apply(chatReducer(state, { type: "message", message, now }, options), now);
    const runUntil = (until: number): void => {
      for (;;) {
        const chatWake: number | null = nextWakeAt(state, options);
        const fadeWake: number | null = goneWakeAt(gone, limits);
        const wake: number = Math.min(chatWake ?? Number.POSITIVE_INFINITY, fadeWake ?? Number.POSITIVE_INFINITY);
        if (wake > until) return;
        // The layer's fade timer and the reducer's wake run at their times.
        if (fadeWake !== null && fadeWake === wake) gone = pruneGone(gone, wake, limits);
        apply(chatReducer(state, { type: "tick", now: wake }, options), wake);
      }
    };
    for (let index = 0; index < 600; index += 1) {
      const at: number = index * 100;
      runUntil(at);
      send({ type: "event", event: chat(index, at) }, at);
      runUntil(at + 50);
      send({ type: "event", event: { kind: "delete", platform: "twitch", messageId: `f${index}`, receivedAt: at } }, at + 50);
    }
    runUntil(60_000 + CHAT_LIMITS.removedHoldMs + CHAT_LIMITS.leaveMs);
    expect(fadesSeen).toBeGreaterThan(100);
    expect(most).toBeLessThanOrEqual(CHAT_LIMITS.maxRows + CHAT_LIMITS.maxLeaving);
    // After the flood every removed row has faded and gone.
    expect(state.rows).toEqual([]);
    expect(gone).toEqual([]);
  });
});
