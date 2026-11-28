import { describe, expect, it } from "vitest";
import {
  activityEventSchema,
  feedEventSchema,
  feedEvents,
  isStreamSignal,
  parseActivityMessage,
  STREAM_TITLE_LENGTH,
  type ActivityEvent,
  type ActivityPlatform,
  type ActivityStream,
  type IngestEvent,
} from "../app/lib/activity";
import {
  BUCKET_MS,
  EMPTY_SESSION_STATE,
  GRACE_MS,
  MAX_INTERVALS_PER_PLATFORM,
  MAX_SESSION_MS,
  MAX_SILENCE_MS,
  PROVIDER_START_WINDOW_MS,
  SILENCE_CHECK_MS,
  SILENCE_GAP_MS,
  channelInterruption,
  nextWakeAt,
  sessionCounts,
  sessionStateSchema,
  sessionStep,
  streamSignal,
  type GapReason,
  type OpenSession,
  type ScheduleWindow,
  type SessionClosing,
  type SessionEffect,
  type SessionOpening,
  type SessionSignal,
  type SessionState,
} from "../app/lib/stream-session";

// The boundaries of a stream session: rules R1 to R11 of docs/stream-reports.md.

const MINUTE = 60_000;
const T0: number = Date.UTC(2026, 10, 28, 18, 0, 0);
const at = (minutes: number): number => T0 + minutes * MINUTE;

type Step = [minutes: number, signal: SessionSignal];

interface Run {
  state: SessionState;
  effects: SessionEffect[];
}

/** Runs the steps in their order. Each state must be valid for storage. */
function run(steps: readonly Step[], start: SessionState = EMPTY_SESSION_STATE): Run {
  let state: SessionState = start;
  const effects: SessionEffect[] = [];
  for (const [minutes, signal] of steps) {
    const result = sessionStep(state, signal, at(minutes));
    expect(sessionStateSchema.safeParse(result.state).success, `state after ${signal.type} at ${minutes}`).toBe(true);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

const online = (platform: ActivityPlatform, extra: { startedAt?: number; title?: string } = {}): SessionSignal => ({
  type: "online",
  platform,
  ...extra,
});
const offline = (platform: ActivityPlatform): SessionSignal => ({ type: "offline", platform });
const chat = (platform: ActivityPlatform): SessionSignal => ({ type: "activity", platform });
const tick: SessionSignal = { type: "tick" };
const ticks = (from: number, to: number, every: number = 5): Step[] => {
  const steps: Step[] = [];
  for (let minute = from; minute <= to; minute += every) steps.push([minute, tick]);
  return steps;
};

const opens = (effects: readonly SessionEffect[]): SessionOpening[] =>
  effects.flatMap((effect: SessionEffect): SessionOpening[] => (effect.type === "open" ? [effect.session] : []));
const closes = (effects: readonly SessionEffect[]): SessionClosing[] =>
  effects.flatMap((effect: SessionEffect): SessionClosing[] => (effect.type === "close" ? [effect.session] : []));
const checks = (effects: readonly SessionEffect[]): ActivityPlatform[] =>
  effects.flatMap((effect: SessionEffect): ActivityPlatform[] => (effect.type === "check" ? [effect.platform] : []));

interface Gap {
  platform: ActivityPlatform;
  reason: GapReason;
  from: number;
  to: number | null;
}

/** The gaps of the effects. Each gapStart must get its gapEnd. */
function gaps(effects: readonly SessionEffect[]): Gap[] {
  const result: Gap[] = [];
  for (const effect of effects) {
    if (effect.type === "gapStart")
      result.push({ platform: effect.platform, reason: effect.reason, from: effect.at, to: null });
    if (effect.type === "gapEnd") {
      const open: Gap | undefined = result.find(
        (gap: Gap): boolean => gap.platform === effect.platform && gap.reason === effect.reason && gap.to === null,
      );
      expect(open, `gapEnd ${effect.reason} without its start`).toBeDefined();
      if (open) open.to = effect.at;
    }
  }
  return result;
}

const window = (change: Partial<ScheduleWindow> = {}): ScheduleWindow => ({
  eventId: "event-1",
  startsAt: at(0),
  endsAt: at(60),
  title: "Planned stream",
  ...change,
});

describe("the live signal kind", (): void => {
  const signal: ActivityStream = {
    kind: "stream",
    platform: "twitch",
    live: true,
    startedAt: at(0),
    receivedAt: at(1),
  };

  it("is valid in a delivery but never a feed event", (): void => {
    expect(activityEventSchema.safeParse(signal).success).toBe(true);
    expect(activityEventSchema.safeParse({ ...signal, title: "x".repeat(STREAM_TITLE_LENGTH) }).success).toBe(true);
    expect(activityEventSchema.safeParse({ ...signal, title: "x".repeat(STREAM_TITLE_LENGTH + 1) }).success).toBe(
      false,
    );
    expect(activityEventSchema.safeParse({ ...signal, live: "yes" }).success).toBe(false);
    expect(feedEventSchema.safeParse(signal).success).toBe(false);
  });

  it("is left out of the events that go to a store or a socket", (): void => {
    const status: ActivityEvent = { kind: "status", platform: "twitch", status: "active" };
    const events: IngestEvent[] = [signal, status];
    expect(feedEvents(events)).toEqual([status]);
    expect(events.map(isStreamSignal)).toEqual([true, false]);
  });

  it("is refused by a consumer as an event, and ignored in a snapshot", (): void => {
    expect(parseActivityMessage(JSON.stringify({ type: "event", event: signal }))).toBeNull();
    const status: ActivityEvent = { kind: "status", platform: "kick", status: "error" };
    expect(parseActivityMessage(JSON.stringify({ type: "snapshot", events: [signal, status], replay: true }))).toEqual({
      type: "snapshot",
      events: [status],
      replay: true,
    });
  });

  it("becomes an online or an offline signal", (): void => {
    expect(streamSignal(signal)).toEqual({ type: "online", platform: "twitch", startedAt: at(0) });
    expect(streamSignal({ ...signal, title: "Hello" })).toMatchObject({ title: "Hello" });
    expect(streamSignal({ kind: "stream", platform: "kick", live: true, receivedAt: at(1) })).toEqual({
      type: "online",
      platform: "kick",
    });
    expect(streamSignal({ ...signal, live: false })).toEqual({ type: "offline", platform: "twitch" });
  });

  it("maps a connection status to an interruption", (): void => {
    expect(channelInterruption("active")).toBeNull();
    expect(channelInterruption("error")).toBe("outage");
    expect(channelInterruption("needs_reauth")).toBe("outage");
    expect(channelInterruption("disconnected")).toBe("outage");
  });
});

describe("R1: a channel that goes live opens a session", (): void => {
  it("starts at the start time of the provider when it is recent", (): void => {
    const { effects } = run([[5, online("twitch", { startedAt: at(1), title: "Ranked games" })]]);
    expect(opens(effects)).toEqual([{ startedAt: at(1), startedBy: "twitch", eventId: null, title: "Ranked games" }]);
  });

  it("starts at the signal when the provider time is old, in the future, or absent", (): void => {
    const old: number = at(20) - PROVIDER_START_WINDOW_MS - 1;
    for (const startedAt of [old, at(21), undefined]) {
      const { effects } = run([[20, online("youtube", startedAt === undefined ? {} : { startedAt })]]);
      expect(opens(effects)[0]?.startedAt).toBe(at(20));
    }
  });

  it("cuts a long title and does not change the stored input state", (): void => {
    const before: SessionState = structuredClone(EMPTY_SESSION_STATE);
    const { state } = run([[0, online("kick", { title: "y".repeat(400) })]], before);
    expect(state.session?.title).toHaveLength(STREAM_TITLE_LENGTH);
    expect(before).toEqual(EMPTY_SESSION_STATE);
  });

  it("does nothing for an offline, an activity, or a check without a session", (): void => {
    const { state, effects } = run([
      [0, offline("twitch")],
      [1, chat("twitch")],
      [2, { type: "checked", platform: "twitch", live: true }],
      [3, tick],
    ]);
    expect(effects).toEqual([]);
    expect(state).toEqual(EMPTY_SESSION_STATE);
    expect(nextWakeAt(state, at(3))).toBeNull();
    expect(sessionCounts(state, at(3))).toBe(false);
  });
});

describe("R2: a simulcast is one session", (): void => {
  it("adds an interval for each channel and ends at the last offline", (): void => {
    const { effects, state } = run([
      [0, online("twitch")],
      [5, online("youtube", { startedAt: at(-10) })],
      [6, chat("youtube")],
      [6, chat("twitch")],
      [30, chat("youtube")],
      [30, chat("twitch")],
      [40, offline("youtube")],
      [45, offline("twitch")],
      [54, tick],
      [55, tick],
    ]);
    expect(opens(effects)).toHaveLength(1);
    expect(closes(effects)).toEqual([
      {
        startedAt: at(0),
        startedBy: "twitch",
        eventId: null,
        title: null,
        endedAt: at(45),
        endedBy: "provider",
        intervals: [
          { platform: "twitch", from: at(0), to: at(45), endedBy: "provider" },
          { platform: "youtube", from: at(0), to: at(40), endedBy: "provider" },
        ],
      },
    ]);
    expect(state.session).toBeNull();
  });

  it("keeps the session while one channel is live, and opens a new interval for a channel that comes back", () => {
    const steps: Step[] = [
      [0, online("twitch")],
      [1, online("kick")],
      [10, offline("kick")],
      [25, chat("twitch")],
      [30, online("kick")],
      [40, offline("kick")],
      [41, offline("twitch")],
      [55, tick],
    ];
    const close: SessionClosing | undefined = closes(run(steps).effects)[0];
    expect(close?.intervals).toEqual([
      { platform: "twitch", from: at(0), to: at(41), endedBy: "provider" },
      { platform: "kick", from: at(1), to: at(10), endedBy: "provider" },
      { platform: "kick", from: at(30), to: at(40), endedBy: "provider" },
    ]);
    expect(close?.endedAt).toBe(at(41));
  });

  it("joins the newest interval of a channel at its limit of intervals", (): void => {
    const steps: Step[] = [[0, online("youtube")]];
    for (let index = 0; index <= MAX_INTERVALS_PER_PLATFORM; index++) {
      const start: number = 1 + index * 12;
      steps.push(
        [start, online("twitch")],
        [start, chat("youtube")],
        [start + 1, offline("twitch")],
        [start + 12, tick],
      );
    }
    const { state } = run(steps);
    const intervals = state.session?.intervals ?? [];
    expect(intervals).toHaveLength(MAX_INTERVALS_PER_PLATFORM);
    expect(intervals.at(-1)).toEqual({
      platform: "twitch",
      from: at(1 + (MAX_INTERVALS_PER_PLATFORM - 1) * 12),
      to: at(2 + MAX_INTERVALS_PER_PLATFORM * 12),
      endedBy: "provider",
    });
  });
});

describe("R3 to R5: offline, the grace time, and a restart", (): void => {
  it("does not count events in the grace time, and closes at the offline time", (): void => {
    const live = run([
      [0, online("twitch")],
      [30, offline("twitch")],
    ]);
    expect(sessionCounts(live.state, at(30))).toBe(false);
    expect(nextWakeAt(live.state, at(30))).toBe(at(30) + GRACE_MS);
    const grace = run([[35, chat("twitch")]], live.state);
    expect(grace.effects).toEqual([]);
    const end = run([[40, tick]], grace.state);
    expect(closes(end.effects)).toMatchObject([{ endedAt: at(30), endedBy: "provider" }]);
  });

  it("continues a session that restarts in the grace time, with an offline gap (R4)", (): void => {
    const { effects } = run([
      [0, online("twitch")],
      [30, offline("twitch")],
      [31, offline("twitch")],
      [36, online("twitch")],
      [37, chat("twitch")],
      [60, offline("twitch")],
      [70, tick],
    ]);
    expect(opens(effects)).toHaveLength(1);
    // Without chat, the silence gaps are there too: the offline gap is between them.
    expect(gaps(effects)).toEqual([
      { platform: "twitch", reason: "silence", from: at(0), to: at(30) },
      { platform: "twitch", reason: "offline", from: at(30), to: at(36) },
      { platform: "twitch", reason: "silence", from: at(37), to: at(60) },
    ]);
    expect(closes(effects)).toMatchObject([{ startedAt: at(0), endedAt: at(60), endedBy: "provider" }]);
  });

  it("starts a new session after a restart outside the grace time", (): void => {
    const { effects } = run([
      [0, online("twitch")],
      [30, offline("twitch")],
      [41, online("twitch")],
      [50, offline("twitch")],
      [60, tick],
    ]);
    expect(closes(effects).map((close: SessionClosing) => [close.startedAt, close.endedAt])).toEqual([
      [at(0), at(30)],
      [at(41), at(50)],
    ]);
  });

  it("confirms a channel that says online again", (): void => {
    const { state } = run([
      [0, online("twitch")],
      [20, online("twitch", { title: "Late title" })],
    ]);
    expect(state.session?.platforms.twitch).toMatchObject({ confirmedAt: at(20), checkAt: null });
    expect(state.session?.title).toBe("Late title");
  });
});

describe("R6 and R7: the schedule", (): void => {
  const scheduleLive = (change: Partial<ScheduleWindow> | null = {}): SessionSignal => ({
    type: "scheduleLive",
    window: change === null ? null : window(change),
  });

  it("starts a session at the start of the stream when chat comes, and ends it at the end", (): void => {
    const { effects } = run([
      [-5, scheduleLive()],
      [-1, chat("twitch")],
      [2, scheduleLive()],
      [5, chat("twitch")],
      [30, chat("twitch")],
      ...ticks(35, 69),
    ]);
    expect(opens(effects)).toEqual([
      { startedAt: at(0), startedBy: "schedule", eventId: "event-1", title: "Planned stream" },
    ]);
    expect(closes(effects)).toEqual([]);
    const end = run([[70, tick]], run([[5, chat("twitch")]], run([[2, scheduleLive()]]).state).state);
    expect(closes(end.effects)).toEqual([
      {
        startedAt: at(0),
        startedBy: "schedule",
        eventId: "event-1",
        title: "Planned stream",
        endedAt: at(60),
        endedBy: "schedule",
        intervals: [],
      },
    ]);
  });

  it("starts nothing without a live stream of the schedule, or after its end", (): void => {
    expect(run([[5, chat("twitch")]]).effects).toEqual([]);
    expect(
      run([
        [61, scheduleLive()],
        [61, chat("twitch")],
      ]).effects,
    ).toEqual([]);
  });

  it("ends early when the owner ends the stream, and later when the owner makes it longer", (): void => {
    const early = run([
      [0, scheduleLive()],
      [1, chat("kick")],
      [20, scheduleLive(null)],
      [30, tick],
    ]);
    expect(closes(early.effects)).toMatchObject([{ endedAt: at(20), endedBy: "schedule" }]);
    const longer = run([
      [0, scheduleLive()],
      [1, chat("kick")],
      [50, scheduleLive({ endsAt: at(90) })],
      [75, tick],
    ]);
    expect(closes(longer.effects)).toEqual([]);
    expect(nextWakeAt(longer.state, at(75))).toBe(at(90));
    const other = run([[80, scheduleLive({ eventId: "event-2", startsAt: at(80), endsAt: at(120) })]], longer.state);
    expect(other.state.session?.scheduleEndsAt).toBe(at(80));
  });

  it("stays open while a channel is live after the end of the schedule", (): void => {
    const { effects } = run([
      [0, scheduleLive()],
      [1, chat("twitch")],
      [20, online("twitch")],
      [50, chat("twitch")],
      [65, chat("twitch")],
      [80, offline("twitch")],
      [90, tick],
    ]);
    expect(closes(effects)).toMatchObject([
      {
        startedAt: at(0),
        startedBy: "schedule",
        endedAt: at(80),
        endedBy: "provider",
        intervals: [{ platform: "twitch", from: at(20), to: at(80) }],
      },
    ]);
  });

  it("links a session that a channel started to the live stream of the schedule", (): void => {
    const { state, effects } = run([
      [-2, online("youtube")],
      [0, scheduleLive({ title: "From the schedule" })],
      [30, scheduleLive({ eventId: "event-2" })],
    ]);
    expect(state.session).toMatchObject({ eventId: "event-1", title: "From the schedule", scheduleEndsAt: null });
    expect(opens(effects)[0]?.eventId).toBeNull();
    const linked = run([
      [0, scheduleLive()],
      [1, online("kick")],
    ]);
    expect(opens(linked.effects)[0]).toMatchObject({ eventId: "event-1", title: "Planned stream" });
  });
});

describe("R9: a missing offline", (): void => {
  it("checks after SILENCE_CHECK_MS, then closes at the last activity after MAX_SILENCE_MS", (): void => {
    const silent: number = 5 + MAX_SILENCE_MS / MINUTE;
    const steps: Step[] = [[0, online("twitch")], [5, chat("twitch")], ...ticks(10, silent - 5)];
    const before = run(steps);
    expect(closes(before.effects)).toEqual([]);
    const firstCheck: number = 5 + SILENCE_CHECK_MS / MINUTE;
    expect(checks(before.effects)).toHaveLength(Math.floor((silent - 5 - firstCheck) / 30) + 1);
    const unknown = run([[firstCheck + 1, { type: "checked", platform: "twitch", live: null }]], before.state);
    const end = run([[silent, tick]], unknown.state);
    expect(closes(end.effects)).toEqual([
      {
        startedAt: at(0),
        startedBy: "twitch",
        eventId: null,
        title: null,
        endedAt: at(5),
        endedBy: "silence",
        intervals: [{ platform: "twitch", from: at(0), to: at(5), endedBy: "silence" }],
      },
    ]);
    expect(gaps([...before.effects, ...end.effects])).toEqual([
      { platform: "twitch", reason: "silence", from: at(5), to: at(5) },
    ]);
  });

  it("closes at the last activity when the check says offline", (): void => {
    const { effects } = run([
      [0, online("twitch")],
      [5, chat("twitch")],
      [35, tick],
      [36, { type: "checked", platform: "twitch", live: false }],
    ]);
    expect(checks(effects)).toEqual(["twitch"]);
    expect(closes(effects)).toMatchObject([{ endedAt: at(5), endedBy: "provider" }]);
  });

  it("keeps a quiet stream that the check says is live", (): void => {
    const steps: Step[] = [[0, online("youtube")]];
    for (let minute = 30; minute <= 300; minute += 30)
      steps.push([minute, tick], [minute, { type: "checked", platform: "youtube", live: true }]);
    const { state, effects } = run(steps);
    expect(closes(effects)).toEqual([]);
    expect(checks(effects)).toHaveLength(10);
    expect(gaps(effects)).toEqual([{ platform: "youtube", reason: "silence", from: at(0), to: null }]);
    expect(sessionCounts(state, at(300))).toBe(true);
    expect(nextWakeAt(state, at(300))).toBe(at(300) + SILENCE_CHECK_MS);
  });

  it("ignores a check for a channel that is not live", (): void => {
    const { effects } = run([
      [0, online("twitch")],
      [5, { type: "checked", platform: "kick", live: false }],
      [6, offline("twitch")],
      [7, { type: "checked", platform: "twitch", live: true }],
    ]);
    expect(closes(effects)).toEqual([]);
  });
});

describe("R10: the limit of a session", (): void => {
  const day: number = MAX_SESSION_MS / MINUTE;

  it("ends a session at 24 hours and continues a live stream in a new session", (): void => {
    const steps: Step[] = [[0, online("twitch", { title: "Marathon" })]];
    for (let minute = 5; minute < day - 30; minute += 5) steps.push([minute, chat("twitch")]);
    steps.push([day - 30, { type: "status", platform: "twitch", interruption: "outage" }]);
    steps.push([day + 2, chat("twitch")], [day + 30, { type: "status", platform: "twitch", interruption: null }]);
    steps.push([day + 60, offline("twitch")], [day + 70, tick]);
    const { effects } = run(steps);
    expect(closes(effects)).toEqual([
      {
        startedAt: at(0),
        startedBy: "twitch",
        eventId: null,
        title: "Marathon",
        endedAt: at(day),
        endedBy: "limit",
        intervals: [{ platform: "twitch", from: at(0), to: at(day), endedBy: "limit" }],
      },
      {
        startedAt: at(day),
        startedBy: "twitch",
        eventId: null,
        title: "Marathon",
        endedAt: at(day + 60),
        endedBy: "provider",
        intervals: [{ platform: "twitch", from: at(day), to: at(day + 60), endedBy: "provider" }],
      },
    ]);
    expect(opens(effects).map((open: SessionOpening): number => open.startedAt)).toEqual([at(0), at(day)]);
    expect(gaps(effects)).toEqual([
      { platform: "twitch", reason: "outage", from: at(day - 30), to: at(day) },
      { platform: "twitch", reason: "outage", from: at(day), to: at(day + 30) },
      { platform: "twitch", reason: "silence", from: at(day + 30), to: at(day + 60) },
    ]);
  });

  it("ends a channel that went offline before the limit at its offline time", (): void => {
    const steps: Step[] = [
      [0, online("twitch")],
      [0, online("kick")],
    ];
    for (let minute = 5; minute < day; minute += 5) steps.push([minute, chat("twitch")], [minute, chat("kick")]);
    steps.push([day - 3, offline("kick")], [day + 1, tick]);
    const { effects, state } = run(steps);
    expect(closes(effects)).toMatchObject([
      {
        endedAt: at(day),
        endedBy: "limit",
        intervals: [
          { platform: "twitch", from: at(0), to: at(day), endedBy: "limit" },
          { platform: "kick", from: at(0), to: at(day - 3), endedBy: "provider" },
        ],
      },
    ]);
    expect(gaps(effects)).toEqual([]);
    expect(Object.keys(state.session?.platforms ?? {})).toEqual(["twitch"]);
  });

  it("waits for the grace time of an offline before the limit", (): void => {
    const steps: Step[] = [[0, online("kick")]];
    for (let minute = 5; minute < day; minute += 5) steps.push([minute, chat("kick")]);
    steps.push([day - 3, offline("kick")], [day + 1, tick], [day + 7, tick]);
    expect(closes(run(steps).effects)).toMatchObject([{ endedAt: at(day - 3), endedBy: "provider" }]);
  });

  it("wakes the server at the end of that grace time, not at the limit that passed", (): void => {
    const steps: Step[] = [[0, online("kick")]];
    for (let minute = 5; minute < day - 5; minute += 5) steps.push([minute, chat("kick")]);
    steps.push([day - 3, offline("kick")], [day, tick]);
    const waiting: Run = run(steps);
    expect(closes(waiting.effects)).toEqual([]);
    expect(nextWakeAt(waiting.state, at(day))).toBe(at(day - 3) + GRACE_MS);
    const end: Run = run([[day + 7, tick]], waiting.state);
    expect(closes(end.effects)).toMatchObject([{ endedAt: at(day - 3), endedBy: "provider" }]);
  });

  it("continues a schedule that holds the session after the limit", (): void => {
    const { effects, state } = run([
      [0, { type: "scheduleLive", window: window({ endsAt: at(day + 120) }) }],
      [1, chat("youtube")],
      [day + 5, tick],
    ]);
    expect(closes(effects)).toMatchObject([{ endedAt: at(day), endedBy: "limit", intervals: [] }]);
    expect(opens(effects).at(-1)).toEqual({
      startedAt: at(day),
      startedBy: "schedule",
      eventId: "event-1",
      title: "Planned stream",
    });
    expect(state.session?.scheduleEndsAt).toBe(at(day + 120));
  });

  it("closes a stored session that nothing holds past the limit, and cuts its intervals at the limit", (): void => {
    const stored: OpenSession = {
      startedAt: at(0),
      startedBy: "twitch",
      eventId: null,
      title: null,
      scheduleEndsAt: null,
      platforms: {},
      gaps: {},
      intervals: [{ platform: "twitch", from: at(0), to: at(day + 5), endedBy: "provider" }],
    };
    const { state, effects } = run([[day + 20, tick]], { ...EMPTY_SESSION_STATE, session: stored });
    expect(closes(effects)).toEqual([
      {
        startedAt: at(0),
        startedBy: "twitch",
        eventId: null,
        title: null,
        endedAt: at(day),
        endedBy: "limit",
        intervals: [{ platform: "twitch", from: at(0), to: at(day), endedBy: "provider" }],
      },
    ]);
    expect(opens(effects)).toEqual([]);
    expect(state.session).toBeNull();
  });
});

describe("R11: gaps", (): void => {
  it("has a silence gap from the last activity until the next one", (): void => {
    const { effects, state } = run([
      [0, online("twitch")],
      [1, chat("twitch")],
      [1 + SILENCE_GAP_MS / MINUTE - 1, tick],
      [1 + SILENCE_GAP_MS / MINUTE, tick],
      [20, chat("twitch")],
      [21, chat("kick")],
    ]);
    expect(gaps(effects)).toEqual([{ platform: "twitch", reason: "silence", from: at(1), to: at(20) }]);
    expect(nextWakeAt(state, at(21))).toBe(at(20) + SILENCE_GAP_MS);
  });

  it("ends a silence gap at an offline", (): void => {
    const { effects } = run([[0, online("youtube")], ...ticks(5, 15), [20, offline("youtube")], [30, tick]]);
    expect(gaps(effects)).toEqual([{ platform: "youtube", reason: "silence", from: at(0), to: at(20) }]);
  });

  it("replaces a silence gap with an outage, and keeps one gap for one interruption", (): void => {
    const { effects } = run([
      [0, online("twitch")],
      [12, tick],
      [15, { type: "status", platform: "twitch", interruption: "outage" }],
      [16, { type: "status", platform: "twitch", interruption: "outage" }],
      [20, { type: "status", platform: "twitch", interruption: "unwatched" }],
      [25, { type: "status", platform: "twitch", interruption: null }],
      [26, { type: "status", platform: "twitch", interruption: null }],
      [26, chat("twitch")],
      [30, offline("twitch")],
      [40, tick],
    ]);
    expect(gaps(effects)).toEqual([
      { platform: "twitch", reason: "silence", from: at(0), to: at(15) },
      { platform: "twitch", reason: "outage", from: at(15), to: at(20) },
      { platform: "twitch", reason: "unwatched", from: at(20), to: at(25) },
    ]);
  });

  it("starts a gap at once for a channel that goes live during an interruption", (): void => {
    const { effects, state } = run([
      [0, { type: "status", platform: "youtube", interruption: "unwatched" }],
      [1, { type: "status", platform: "kick", interruption: "outage" }],
      [2, { type: "status", platform: "kick", interruption: null }],
      [5, online("youtube")],
    ]);
    expect(state.interrupted).toEqual({ youtube: "unwatched" });
    expect(gaps(effects)).toEqual([{ platform: "youtube", reason: "unwatched", from: at(5), to: null }]);
  });
});

describe("a long interruption", (): void => {
  const silence: number = MAX_SILENCE_MS / MINUTE;

  it("does not end a channel by silence during an outage, and counts the silence again from the recovery", () => {
    const steps: Step[] = [
      [0, online("twitch")],
      [1, chat("twitch")],
      [2, { type: "status", platform: "twitch", interruption: "outage" }],
      ...ticks(5, silence + 30),
    ];
    const outage: Run = run(steps);
    expect(closes(outage.effects)).toEqual([]);
    // The checks continue during the outage: the provider can still say that the stream is live or offline.
    expect(checks(outage.effects).length).toBeGreaterThan(0);
    const wake: number | null = nextWakeAt(outage.state, at(silence + 30));
    expect(wake).not.toBeNull();
    expect(wake ?? 0).toBeGreaterThan(at(silence + 30));
    expect(wake ?? 0).toBeLessThanOrEqual(at(silence + 30) + SILENCE_CHECK_MS);
    const recovered: Run = run(
      [
        [silence + 40, { type: "status", platform: "twitch", interruption: null }],
        ...ticks(silence + 45, 2 * silence + 35),
      ],
      outage.state,
    );
    expect(closes(recovered.effects)).toEqual([]);
    const end: Run = run([[2 * silence + 40, tick]], recovered.state);
    expect(closes(end.effects)).toMatchObject([{ endedAt: at(silence + 40), endedBy: "silence" }]);
    expect(gaps([...outage.effects, ...recovered.effects, ...end.effects])).toEqual([
      { platform: "twitch", reason: "outage", from: at(2), to: at(silence + 40) },
      { platform: "twitch", reason: "silence", from: at(silence + 40), to: at(silence + 40) },
    ]);
  });

  it("does not end an unwatched channel by silence", (): void => {
    const { effects, state } = run([
      [0, online("youtube")],
      [1, { type: "status", platform: "youtube", interruption: "unwatched" }],
      [silence + 5, tick],
      [2 * silence, tick],
    ]);
    expect(closes(effects)).toEqual([]);
    expect(state.session?.platforms.youtube?.offlineAt).toBeNull();
  });
});

describe("the wake time", (): void => {
  /** A small deterministic generator, so a failure repeats. */
  function generator(seed: number): () => number {
    let value: number = seed;
    return (): number => {
      value = (value * 1_103_515_245 + 12_345) % 2_147_483_648;
      return value / 2_147_483_648;
    };
  }

  const platforms: readonly ActivityPlatform[] = ["twitch", "youtube", "kick"];

  /** Small steps near the limit. Else mostly steps of some minutes, and sometimes some hours. */
  function minutesOf(random: () => number, near: boolean): number {
    if (near) return Math.floor(random() * 4);
    return Math.floor(random() * (random() < 0.05 ? 600 : 15));
  }

  function signalOf(random: () => number, minute: number): SessionSignal {
    const platform: ActivityPlatform = platforms[Math.floor(random() * platforms.length)];
    const pick: number = random();
    if (pick < 0.15) return online(platform);
    if (pick < 0.25) return offline(platform);
    if (pick < 0.5) return chat(platform);
    if (pick < 0.6) return { type: "status", platform, interruption: random() < 0.5 ? null : "outage" };
    if (pick < 0.65) return { type: "checked", platform, live: random() < 0.5 };
    if (pick < 0.7)
      return { type: "scheduleLive", window: window({ startsAt: at(minute - 5), endsAt: at(minute + 90) }) };
    return tick;
  }

  it("is in the future after each tick, or null", (): void => {
    // Half of the runs start with a session near its limit, so the steps reach the limit often.
    const nearLimit: SessionState = structuredClone(run([[0, online("twitch")]]).state);
    if (nearLimit.session) nearLimit.session.startedAt = at(0) - MAX_SESSION_MS + 20 * MINUTE;
    for (let seed = 1; seed <= 60; seed++) {
      const random = generator(seed);
      let state: SessionState = seed % 2 === 0 ? nearLimit : EMPTY_SESSION_STATE;
      let minute = 0;
      for (let step = 0; step < 400; step++) {
        minute += minutesOf(random, seed % 2 === 0 && step < 20);
        const signal: SessionSignal = signalOf(random, minute);
        state = sessionStep(state, signal, at(minute)).state;
        if (signal.type !== "tick") state = sessionStep(state, tick, at(minute)).state;
        const wake: number | null = nextWakeAt(state, at(minute));
        if (wake !== null) expect(wake, `seed ${seed}, step ${step}`).toBeGreaterThan(at(minute));
      }
    }
  });
});

describe("a session with a provider outage", (): void => {
  it("is one session with an outage gap and the boundaries of the provider", (): void => {
    const error: ActivityEvent = { kind: "status", platform: "twitch", status: "error", code: "delivery_failed" };
    const active: ActivityEvent = { kind: "status", platform: "twitch", status: "active" };
    const status = (event: ActivityEvent): SessionSignal => {
      if (event.kind !== "status") throw new Error("A status event is necessary");
      return { type: "status", platform: event.platform, interruption: channelInterruption(event.status) };
    };
    const { effects, state } = run([
      [0, online("twitch", { startedAt: at(-1), title: "Outage night" })],
      [1, chat("twitch")],
      [2, status(error)],
      // Twenty minutes without a delivery: the outage covers them, so there is no silence gap.
      ...ticks(5, 20),
      [22, status(active)],
      [25, chat("twitch")],
      [30, offline("twitch")],
      [35, tick],
      [40, tick],
    ]);
    expect(effects.map((effect: SessionEffect): string => effect.type)).toEqual([
      "open",
      "gapStart",
      "gapEnd",
      "close",
    ]);
    expect(opens(effects)).toEqual([{ startedAt: at(-1), startedBy: "twitch", eventId: null, title: "Outage night" }]);
    expect(gaps(effects)).toEqual([{ platform: "twitch", reason: "outage", from: at(2), to: at(22) }]);
    expect(checks(effects)).toEqual([]);
    expect(closes(effects)).toEqual([
      {
        startedAt: at(-1),
        startedBy: "twitch",
        eventId: null,
        title: "Outage night",
        endedAt: at(30),
        endedBy: "provider",
        intervals: [{ platform: "twitch", from: at(-1), to: at(30), endedBy: "provider" }],
      },
    ]);
    expect(state).toEqual(EMPTY_SESSION_STATE);
  });
});

describe("the stored state", (): void => {
  it("refuses a gap without a live channel, an empty session, and a long title", (): void => {
    const session: OpenSession = {
      startedAt: at(0),
      startedBy: "twitch",
      eventId: null,
      title: null,
      scheduleEndsAt: null,
      platforms: { twitch: { since: at(0), offlineAt: null, heardAt: at(0), confirmedAt: at(0), checkAt: null } },
      gaps: {},
      intervals: [],
    };
    const valid: SessionState = { ...EMPTY_SESSION_STATE, session };
    expect(sessionStateSchema.safeParse(valid).success).toBe(true);
    const invalid: SessionState[] = [
      { ...valid, session: { ...session, gaps: { kick: { reason: "outage", from: at(0) } } } },
      { ...valid, session: { ...session, platforms: {} } },
      { ...valid, session: { ...session, title: "z".repeat(STREAM_TITLE_LENGTH + 1) } },
      { ...valid, schedule: window({ startsAt: at(10), endsAt: at(5) }) },
    ];
    for (const state of invalid) expect(sessionStateSchema.safeParse(state).success).toBe(false);
  });

  it("wakes the server for the grace time, the limit, and the schedule", (): void => {
    const live = run([[0, online("twitch")]]).state;
    expect(nextWakeAt(live, at(0))).toBe(at(0) + SILENCE_GAP_MS);
    expect(BUCKET_MS).toBeLessThan(SILENCE_GAP_MS);
    const closing = run([[3, offline("twitch")]], live).state;
    expect(nextWakeAt(closing, at(3))).toBe(at(3) + GRACE_MS);
    const scheduled = run([
      [0, { type: "scheduleLive", window: window() }],
      [1, chat("twitch")],
    ]).state;
    expect(nextWakeAt(scheduled, at(1))).toBe(at(60));
    expect(nextWakeAt(scheduled, at(61))).toBe(at(60) + GRACE_MS);
    expect(sessionCounts(scheduled, at(30))).toBe(true);
    expect(sessionCounts(scheduled, at(61))).toBe(false);
  });
});
