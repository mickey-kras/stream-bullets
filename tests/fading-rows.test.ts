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
  type ChatView,
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

/** A chat state at `at` (the time of its latest change), in epoch `epoch`. */
function view(rows: ChatRow[], at: number, epoch: number = 0): ChatView {
  return { rows, at, epoch };
}

describe("nextGone", () => {
  it("starts a fade for a removed row that the reducer dropped, at the time of the drop", () => {
    const removed: ChatRow = row(1, "removed", 1_000);
    const next = nextGone([], view([removed, row(2)], 1_000), view([row(2)], 1_000 + HOLD), limits);
    expect(next).toEqual([{ row: removed, goneAt: 1_000 + HOLD }]);
  });

  it("plays the full fade when the drop comes late", () => {
    // The tick that drops the row comes 250 ms after the hold ended (a busy or throttled page).
    const removed: ChatRow = row(1, "removed", 0);
    const late: number = HOLD + 250;
    const next = nextGone([], view([removed], 0), view([], late), limits);
    expect(next).toEqual([{ row: removed, goneAt: late }]);
    expect(goneWakeAt(next, limits)).toBe(late + limits.leaveMs);
    expect(pruneGone(next, late + limits.leaveMs - 1, limits)).toBe(next);
  });

  it("does not fade a removed row that a snapshot dropped before its hold ended", () => {
    const prevGone: GoneRow[] = [];
    const removed: ChatRow = row(1, "removed", 1_000);
    expect(nextGone(prevGone, view([removed, row(2)], 1_000), view([row(2)], 1_000 + HOLD - 1), limits)).toBe(prevGone);
  });

  it("does not fade any row across a reset, and ends the fades that run", () => {
    const removed: ChatRow = row(5, "removed", 0);
    const fading: GoneRow[] = [{ row: row(4, "removed"), goneAt: 100 }];
    // A reset during the hold: the new epoch starts again at seq 1, and the old rows go at once.
    expect(nextGone(fading, view([removed], 100), view([row(1)], 200, 1), limits)).toEqual([]);
    const none: GoneRow[] = [];
    expect(nextGone(none, view([removed], 100), view([], HOLD, 1), limits)).toBe(none);
  });

  it("does not fade a dropped row that was not removed", () => {
    const prevGone: GoneRow[] = [];
    expect(nextGone(prevGone, view([row(1, "leaving"), row(2)], 0), view([row(2)], 0), limits)).toBe(prevGone);
  });

  it("returns the same array when nothing changes", () => {
    const prevGone: GoneRow[] = [{ row: row(1, "removed"), goneAt: 0 }];
    expect(nextGone(prevGone, view([row(1, "removed")], 0), view([row(2)], 0), limits)).toBe(prevGone);
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
    expect(ids(nextGone(prevGone, view([c], 250), view([], 300), limits))).toEqual(["twitch:r2", "twitch:r3"]);
    expect(ids(nextGone(prevGone, view([], 250), view([b], 250), limits))).toEqual(["twitch:r1"]);
  });

  it("keeps the newest fades within maxLeaving, less the leaving rows", () => {
    const prevRows: ChatRow[] = [1, 2, 3, 4].map((seq: number): ChatRow => row(seq, "removed"));
    const small: FadeLimits = { ...limits, maxLeaving: 3 };
    const before: ChatView = view(prevRows, 0);
    expect(ids(nextGone([], before, view([], HOLD), small))).toEqual(["twitch:r2", "twitch:r3", "twitch:r4"]);
    expect(ids(nextGone([], before, view([row(9, "leaving")], HOLD), small))).toEqual(["twitch:r3", "twitch:r4"]);
    const full: ChatRow[] = [row(7, "leaving"), row(8, "leaving"), row(9, "leaving"), row(10, "leaving")];
    expect(nextGone([], before, view(full, HOLD), small)).toEqual([]);
  });
});

describe("with the chat reducer", () => {
  const removedAt = (state: ChatState): ChatState =>
    chatReducer(
      state,
      {
        type: "message",
        message: { type: "event", event: { kind: "delete", platform: "twitch", messageId: "f1", receivedAt: 0 } },
        now: 100,
      },
      options,
    );

  it("starts no fade when the feed becomes unavailable during a hold", () => {
    const shown: ChatState = chatReducer(
      initialChatState(),
      { type: "message", message: { type: "event", event: chat(1, 0) }, now: 0 },
      options,
    );
    const removed: ChatState = removedAt(shown);
    expect(removed.rows[0].phase).toBe("removed");
    const reset: ChatState = chatReducer(
      removed,
      { type: "message", message: { type: "unavailable" }, now: 200 },
      options,
    );
    expect(reset.epoch).toBe(removed.epoch + 1);
    expect(nextGone([], removed, reset, limits)).toEqual([]);
    const again: ChatState = chatReducer(removed, { type: "reset" }, options);
    expect(nextGone([], removed, again, limits)).toEqual([]);
  });

  it("starts no fade when a reconnect snapshot drops a removed row during its hold", () => {
    let state: ChatState = initialChatState();
    for (let index = 1; index <= CHAT_LIMITS.maxRows; index += 1)
      state = chatReducer(
        state,
        { type: "message", message: { type: "event", event: chat(index, 0) }, now: 0 },
        options,
      );
    state = chatReducer(state, { type: "tick", now: 60_000 }, options);
    const removed: ChatState = removedAt(state);
    const events = Array.from({ length: CHAT_LIMITS.maxRows }, (_, index: number) => chat(1_000 + index, 99_000));
    const snapshot: ChatState = chatReducer(
      removed,
      { type: "message", message: { type: "snapshot", replay: true, events }, now: 500 },
      options,
    );
    expect(snapshot.rows.some((item: ChatRow): boolean => item.phase === "removed")).toBe(false);
    expect(nextGone([], removed, snapshot, limits)).toEqual([]);
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

/** The chat reducer and the fading rows of the chat layer, driven together at the wake times of both. */
function simulate(): {
  send: (message: ActivityMessage, now: number) => void;
  runUntil: (until: number) => void;
  result: () => { state: ChatState; gone: readonly GoneRow[]; most: number; mostGone: number; fadesSeen: number };
} {
  let state: ChatState = initialChatState();
  let gone: readonly GoneRow[] = [];
  let most = 0;
  let mostGone = 0;
  let fadesSeen = 0;
  const apply = (next: ChatState, now: number): void => {
    if (next !== state) {
      const after: readonly GoneRow[] = nextGone(gone, state, next, limits);
      // A fade starts when the reducer drops the row.
      for (const item of after) if (!gone.includes(item)) expect(item.goneAt).toBe(now);
      if (after.length > gone.length) fadesSeen += 1;
      gone = after;
      state = next;
    }
    const shown: number = shownRows(state.rows, gone).length;
    most = Math.max(most, shown);
    mostGone = Math.max(mostGone, gone.length);
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
  return { send, runUntil, result: () => ({ state, gone, most, mostGone, fadesSeen }) };
}

function remove(index: number, at: number): ActivityMessage {
  return { type: "event", event: { kind: "delete", platform: "twitch", messageId: `f${index}`, receivedAt: at } };
}

describe("a delete burst", () => {
  it("fades at most maxLeaving rows and never renders more than maxRows + maxLeaving rows", () => {
    // Each round fills the chat with maxRows messages, one every 200 ms, and deletes them all at once. The next round
    // starts while the removed rows of the last one fade.
    const { send, runUntil, result } = simulate();
    const rows: number = CHAT_LIMITS.maxRows;
    let at = 0;
    for (let round = 0; round < 5; round += 1) {
      for (let item = 0; item < rows; item += 1) {
        runUntil(at);
        send({ type: "event", event: chat(round * rows + item, at) }, at);
        at += 200;
      }
      runUntil(at);
      for (let item = 0; item < rows; item += 1) send(remove(round * rows + item, at), at);
      // The removed rows drop at the end of their hold; the next round starts during their fade.
      at += CHAT_LIMITS.removedHoldMs + 100;
    }
    runUntil(at + CHAT_LIMITS.removedHoldMs + CHAT_LIMITS.leaveMs);
    const { state, gone, most, mostGone } = result();
    // The cap is reached: without it, all maxRows removed rows of a round would fade at once.
    expect(mostGone).toBe(CHAT_LIMITS.maxLeaving);
    expect(most).toBeLessThanOrEqual(CHAT_LIMITS.maxRows + CHAT_LIMITS.maxLeaving);
    expect(state.rows).toEqual([]);
    expect(gone).toEqual([]);
  });
});

describe("a sustained delete flood", () => {
  it("never renders more than maxRows + maxLeaving rows", () => {
    // A message every 100 ms, each deleted 50 ms later, for 60 seconds, with the real chat reducer.
    const { send, runUntil, result } = simulate();
    for (let index = 0; index < 600; index += 1) {
      const at: number = index * 100;
      runUntil(at);
      send({ type: "event", event: chat(index, at) }, at);
      runUntil(at + 50);
      send(remove(index, at), at + 50);
    }
    runUntil(60_000 + CHAT_LIMITS.removedHoldMs + CHAT_LIMITS.leaveMs);
    const { state, gone, most, fadesSeen } = result();
    expect(fadesSeen).toBeGreaterThan(100);
    expect(most).toBeLessThanOrEqual(CHAT_LIMITS.maxRows + CHAT_LIMITS.maxLeaving);
    // After the flood every removed row has faded and gone.
    expect(state.rows).toEqual([]);
    expect(gone).toEqual([]);
  });
});
