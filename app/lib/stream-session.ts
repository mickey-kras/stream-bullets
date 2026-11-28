import { z } from "zod";
import { CHANNEL_PLATFORMS } from "../../db/enums";
import { STREAM_TITLE_LENGTH, type ActivityPlatform, type ActivityStream, type ChannelStatus } from "./activity";

/**
 * The boundaries of a stream session (issue #1047, docs/stream-reports.md). A session starts when a channel goes
 * live, or when chat comes during a live stream of the schedule. It ends when the last channel goes offline, at the
 * end of the schedule, after a long silence, or at the limit of one session. This module is pure: `sessionStep`
 * takes the state, one signal and the time, and gives the next state and the effects that the server must apply.
 * The rule names R1 to R11 are the rules of the plan and of the documentation.
 */

const MINUTE_MS = 60_000;

/** After the last channel goes offline, the session waits this long for a restart before it ends. */
export const GRACE_MS = 10 * MINUTE_MS;
/** A live channel without chat or support for this long has a silence gap. */
export const SILENCE_GAP_MS = 10 * MINUTE_MS;
/** A live channel without a word from the provider for this long gets a check: is it still live? */
export const SILENCE_CHECK_MS = 30 * MINUTE_MS;
/** A live channel without a word from the provider for this long ends at its last activity. */
export const MAX_SILENCE_MS = 3 * 60 * MINUTE_MS;
/** The longest session. A stream that is still live after it continues in a new session. */
export const MAX_SESSION_MS = 24 * 60 * MINUTE_MS;
/** The length of one bucket of the timeline. */
export const BUCKET_MS = 5 * MINUTE_MS;
/** A start time from the provider counts only when it is at most this old. Else the session starts at the signal. */
export const PROVIDER_START_WINDOW_MS = 15 * MINUTE_MS;
/** The most live intervals that one channel keeps in one session. A further interval joins the newest one. */
export const MAX_INTERVALS_PER_PLATFORM = 48;
export const MAX_INTERVALS = MAX_INTERVALS_PER_PLATFORM * CHANNEL_PLATFORMS.length;
/** The longest ID of a stream of the schedule. */
export const MAX_EVENT_ID_LENGTH = 64;

/** What started a session: a channel that went live, or the schedule. */
export const SESSION_STARTS = ["twitch", "youtube", "kick", "schedule"] as const satisfies readonly (
  | ActivityPlatform
  | "schedule"
)[];
export type SessionStart = (typeof SESSION_STARTS)[number];

/**
 * What ended a session. `provider`: the last channel went offline. `schedule`: the stream of the schedule ended.
 * `silence`: no word for MAX_SILENCE_MS. `limit`: MAX_SESSION_MS. `lost`: the hourly check found a session that
 * nothing ended (the server sets it, not this reducer).
 */
export const SESSION_ENDS = ["provider", "schedule", "silence", "limit", "lost"] as const;
export type SessionEnd = (typeof SESSION_ENDS)[number];

/** Why one live interval of a channel ended. */
export const INTERVAL_ENDS = ["provider", "silence", "limit"] as const;
export type IntervalEnd = (typeof INTERVAL_ENDS)[number];

/**
 * Why a channel has a gap in a session. `offline`: it went offline and came back in the grace time. `outage`: the
 * connection had an error. `silence`: no chat or support for SILENCE_GAP_MS. `unwatched`: nothing read the channel
 * (YouTube is read only while a page listens).
 */
export const GAP_REASONS = ["offline", "outage", "silence", "unwatched"] as const;
export type GapReason = (typeof GAP_REASONS)[number];

/** A state of a connection that stops the events: the server tells it with a `status` signal. */
export const INTERRUPTIONS = ["outage", "unwatched"] as const satisfies readonly GapReason[];
export type Interruption = (typeof INTERRUPTIONS)[number];

/** One time span when a channel was live in a session. */
export interface LiveInterval {
  platform: ActivityPlatform;
  from: number;
  to: number;
  endedBy: IntervalEnd;
}

/** A stream of the schedule that is live now, as the server read it. */
export interface ScheduleWindow {
  eventId: string;
  startsAt: number;
  endsAt: number;
  title: string | null;
}

/** A gap that started and did not end yet. */
export interface OpenGap {
  reason: GapReason;
  from: number;
}

/** A channel that is live in the open session. */
export interface PlatformLive {
  /** The start of its current live interval. */
  since: number;
  /** Null while it is live. Else when it went offline: the grace time runs from here. */
  offlineAt: number | null;
  /** The latest chat or support, or the end of an outage. A silence gap starts here. */
  heardAt: number;
  /** The latest word that it is live: activity, an online signal, or a check. The silence checks count from here. */
  confirmedAt: number;
  /** When the server was last told to check it, or null. */
  checkAt: number | null;
}

export interface OpenSession {
  startedAt: number;
  startedBy: SessionStart;
  /** The stream of the schedule that this session is part of, or null. */
  eventId: string | null;
  title: string | null;
  /** Only for a session that the schedule started: the schedule holds it open until this time. */
  scheduleEndsAt: number | null;
  /** The channels with an interval that did not end. */
  platforms: Partial<Record<ActivityPlatform, PlatformLive>>;
  /** The open gap of each live channel. */
  gaps: Partial<Record<ActivityPlatform, OpenGap>>;
  /** The live intervals that ended, the oldest first. */
  intervals: LiveInterval[];
}

/** The state of the sessions of one page. The server stores it, so it has a version and a schema. */
export interface SessionState {
  v: 1;
  session: OpenSession | null;
  /** The live stream of the schedule, as the server last read it. */
  schedule: ScheduleWindow | null;
  /** The channels whose connection stops the events now. */
  interrupted: Partial<Record<ActivityPlatform, Interruption>>;
}

export const EMPTY_SESSION_STATE: SessionState = { v: 1, session: null, schedule: null, interrupted: {} };

/**
 * A signal for the reducer. `online` and `offline` come from the provider. `activity` is chat or support that the
 * page accepted. `status` is a change of the connection. `scheduleLive` is the live stream of the schedule, or null.
 * `checked` is the answer to a `check` effect: null when the provider could not say. `tick` is the alarm.
 */
export type SessionSignal =
  | { type: "online"; platform: ActivityPlatform; startedAt?: number; title?: string }
  | { type: "offline"; platform: ActivityPlatform }
  | { type: "activity"; platform: ActivityPlatform }
  | { type: "status"; platform: ActivityPlatform; interruption: Interruption | null }
  | { type: "scheduleLive"; window: ScheduleWindow | null }
  | { type: "checked"; platform: ActivityPlatform; live: boolean | null }
  | { type: "tick" };

/** The start of a session, as the server records it. */
export interface SessionOpening {
  startedAt: number;
  startedBy: SessionStart;
  eventId: string | null;
  title: string | null;
}

/** The end of a session, with its live intervals. */
export interface SessionClosing extends SessionOpening {
  endedAt: number;
  endedBy: SessionEnd;
  intervals: LiveInterval[];
}

/**
 * What the server must do. The effects of one step are in their order: a `close` comes before the `open` of the
 * next session. Each `gapStart` gets one `gapEnd` in the same session. `check` asks the provider if the channel is
 * still live; the answer is a `checked` signal.
 */
export type SessionEffect =
  | { type: "open"; session: SessionOpening }
  | { type: "close"; session: SessionClosing }
  | { type: "gapStart"; platform: ActivityPlatform; reason: GapReason; at: number }
  | { type: "gapEnd"; platform: ActivityPlatform; reason: GapReason; at: number }
  | { type: "check"; platform: ActivityPlatform };

export interface SessionStepResult {
  state: SessionState;
  effects: SessionEffect[];
}

/** The interruption of a connection status: an error, a revoked authorization, or a disconnect stops the events. */
export function channelInterruption(status: ChannelStatus | "disconnected"): Interruption | null {
  switch (status) {
    case "active":
      return null;
    case "error":
    case "needs_reauth":
    case "disconnected":
      return "outage";
  }
}

/** The signal of a live signal event. */
export function streamSignal(event: ActivityStream): SessionSignal {
  if (!event.live) return { type: "offline", platform: event.platform };
  return {
    type: "online",
    platform: event.platform,
    ...(event.startedAt === undefined ? {} : { startedAt: event.startedAt }),
    ...(event.title === undefined ? {} : { title: event.title }),
  };
}

// Schemas -----------------------------------------------------------------------------------------------------------

const platformSchema = z.enum(CHANNEL_PLATFORMS);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const title = z.string().max(STREAM_TITLE_LENGTH).nullable();
const eventId = z.string().min(1).max(MAX_EVENT_ID_LENGTH);

export const liveIntervalSchema: z.ZodType<LiveInterval> = z
  .object({ platform: platformSchema, from: time, to: time, endedBy: z.enum(INTERVAL_ENDS) })
  .refine((interval: LiveInterval): boolean => interval.from <= interval.to);

export const scheduleWindowSchema: z.ZodType<ScheduleWindow> = z
  .object({ eventId, startsAt: time, endsAt: time, title })
  .refine((window: ScheduleWindow): boolean => window.startsAt <= window.endsAt);

const platformLiveSchema: z.ZodType<PlatformLive> = z.object({
  since: time,
  offlineAt: time.nullable(),
  heardAt: time,
  confirmedAt: time,
  checkAt: time.nullable(),
});

const openSessionSchema: z.ZodType<OpenSession> = z
  .object({
    startedAt: time,
    startedBy: z.enum(SESSION_STARTS),
    eventId: eventId.nullable(),
    title,
    scheduleEndsAt: time.nullable(),
    platforms: z.partialRecord(platformSchema, platformLiveSchema),
    gaps: z.partialRecord(platformSchema, z.object({ reason: z.enum(GAP_REASONS), from: time })),
    intervals: z.array(liveIntervalSchema).max(MAX_INTERVALS),
  })
  // A gap belongs to a live channel, and a session has something that holds it open or that ended.
  .refine((session: OpenSession): boolean =>
    CHANNEL_PLATFORMS.every((name: ActivityPlatform): boolean => !session.gaps[name] || !!session.platforms[name]),
  )
  .refine(
    (session: OpenSession): boolean =>
      livePlatforms(session).length > 0 || session.scheduleEndsAt !== null || session.intervals.length > 0,
  );

export const sessionStateSchema: z.ZodType<SessionState> = z.object({
  v: z.literal(1),
  session: openSessionSchema.nullable(),
  schedule: scheduleWindowSchema.nullable(),
  interrupted: z.partialRecord(platformSchema, z.enum(INTERRUPTIONS)),
});

// Queries -----------------------------------------------------------------------------------------------------------

/** The channels of the open session in the order of CHANNEL_PLATFORMS. */
function livePlatforms(session: OpenSession): [ActivityPlatform, PlatformLive][] {
  const result: [ActivityPlatform, PlatformLive][] = [];
  for (const name of CHANNEL_PLATFORMS) {
    const live: PlatformLive | undefined = session.platforms[name];
    if (live) result.push([name, live]);
  }
  return result;
}

/** True while the connection of a live channel has an outage or nothing reads it: it has an open gap of that reason. */
function isInterrupted(session: OpenSession, name: ActivityPlatform): boolean {
  const reason: GapReason | undefined = session.gaps[name]?.reason;
  return reason === "outage" || reason === "unwatched";
}

/** The end of the last thing that held the session open. */
interface Release {
  at: number;
  by: SessionEnd;
}

/**
 * When the last hold of the session ended, or null while one holds it: a channel that is live, or the schedule
 * before its end. The latest end wins. A session that has nothing at all is `lost` at its start.
 */
function releaseOf(session: OpenSession, now: number): Release | null {
  let release: Release = { at: session.startedAt, by: "lost" };
  const later = (at: number, by: SessionEnd): void => {
    if (at >= release.at) release = { at, by };
  };
  for (const interval of session.intervals) later(interval.to, interval.endedBy === "silence" ? "silence" : "provider");
  if (session.scheduleEndsAt !== null) {
    if (now < session.scheduleEndsAt) return null;
    later(session.scheduleEndsAt, "schedule");
  }
  for (const [, live] of livePlatforms(session)) {
    if (live.offlineAt === null) return null;
    later(live.offlineAt, "provider");
  }
  return release;
}

/**
 * True when chat and support count for the session now: a session is open and something holds it. Events in the
 * grace time after the last offline do not count.
 */
export function sessionCounts(state: SessionState, now: number): boolean {
  return state.session !== null && releaseOf(state.session, now) === null;
}

/**
 * The next time that a `tick` can change the state, or null when no session is open. It can be in the past: then
 * the server steps at once.
 */
export function nextWakeAt(state: SessionState, now: number): number | null {
  const session: OpenSession | null = state.session;
  if (session === null) return null;
  const capAt: number = session.startedAt + MAX_SESSION_MS;
  const release: Release | null = releaseOf(session, now);
  // A release before the limit waits for its grace time, and the limit does not apply to it (see `advance`).
  const times: number[] = release !== null && release.at <= capAt ? [] : [capAt];
  if (release !== null) times.push(release.at + GRACE_MS);
  else if (session.scheduleEndsAt !== null && session.scheduleEndsAt > now) times.push(session.scheduleEndsAt);
  for (const [name, live] of livePlatforms(session)) {
    if (live.offlineAt !== null) {
      times.push(live.offlineAt + GRACE_MS);
      continue;
    }
    if (!session.gaps[name]) times.push(live.heardAt + SILENCE_GAP_MS);
    times.push(Math.max(live.confirmedAt, live.checkAt ?? 0) + SILENCE_CHECK_MS);
    if (!isInterrupted(session, name)) times.push(live.confirmedAt + MAX_SILENCE_MS);
  }
  return Math.min(...times);
}

// The reducer -------------------------------------------------------------------------------------------------------

/** One step: the deadlines that passed before the signal, the signal, and the deadlines that it starts. */
export function sessionStep(state: SessionState, signal: SessionSignal, now: number): SessionStepResult {
  const effects: SessionEffect[] = [];
  const draft: SessionState = structuredClone(state);
  advance(draft, now, effects);
  apply(draft, signal, now, effects);
  advance(draft, now, effects);
  return { state: draft, effects };
}

function openingOf(session: OpenSession): SessionOpening {
  return {
    startedAt: session.startedAt,
    startedBy: session.startedBy,
    eventId: session.eventId,
    title: session.title,
  };
}

function freshPlatform(since: number, now: number): PlatformLive {
  return { since, offlineAt: null, heardAt: now, confirmedAt: now, checkAt: null };
}

function startGap(
  session: OpenSession,
  name: ActivityPlatform,
  reason: GapReason,
  at: number,
  out: SessionEffect[],
): void {
  session.gaps[name] = { reason, from: at };
  out.push({ type: "gapStart", platform: name, reason, at });
}

/** Ends the open gap of a channel at `at`, or at its start when `at` is earlier. */
function endGap(session: OpenSession, name: ActivityPlatform, at: number, out: SessionEffect[]): void {
  const gap: OpenGap | undefined = session.gaps[name];
  if (!gap) return;
  delete session.gaps[name];
  out.push({ type: "gapEnd", platform: name, reason: gap.reason, at: Math.max(gap.from, at) });
}

/** Adds a channel to the session. A channel whose connection stops the events starts with a gap. */
function addPlatform(
  state: SessionState,
  session: OpenSession,
  name: ActivityPlatform,
  since: number,
  now: number,
  out: SessionEffect[],
): void {
  session.platforms[name] = freshPlatform(since, now);
  const interruption: Interruption | undefined = state.interrupted[name];
  if (interruption) startGap(session, name, interruption, now, out);
}

/** Ends the live interval of a channel. A channel at its limit of intervals extends its newest interval. */
function endInterval(
  session: OpenSession,
  [name, live]: [ActivityPlatform, PlatformLive],
  to: number,
  by: IntervalEnd,
  out: SessionEffect[],
): void {
  const end: number = Math.max(live.since, to);
  endGap(session, name, end, out);
  delete session.platforms[name];
  const own: LiveInterval[] = session.intervals.filter((interval: LiveInterval): boolean => interval.platform === name);
  const newest: LiveInterval | undefined = own.at(-1);
  if (newest && own.length >= MAX_INTERVALS_PER_PLATFORM) {
    newest.to = Math.max(newest.to, end);
    newest.endedBy = by;
    return;
  }
  session.intervals.push({ platform: name, from: live.since, to: end, endedBy: by });
}

/**
 * R3, R5, R9: a channel offline for the grace time ends at its offline time; a silent one at its last activity. A
 * channel with an interruption is not silent: the connection, not the stream, stopped the events. The end of the
 * interruption starts the silence count again.
 */
function expirePlatforms(session: OpenSession, now: number, out: SessionEffect[]): void {
  for (const entry of livePlatforms(session)) {
    const [name, live] = entry;
    if (live.offlineAt !== null) {
      if (live.offlineAt + GRACE_MS <= now) endInterval(session, entry, live.offlineAt, "provider", out);
    } else if (!isInterrupted(session, name) && now - live.confirmedAt >= MAX_SILENCE_MS)
      endInterval(session, entry, live.heardAt, "silence", out);
  }
}

/** The order of intervals in a report: by start, then in the order of CHANNEL_PLATFORMS. */
function byStart(a: LiveInterval, b: LiveInterval): number {
  return a.from - b.from || CHANNEL_PLATFORMS.indexOf(a.platform) - CHANNEL_PLATFORMS.indexOf(b.platform);
}

/** Closes the session at `endedAt`. Its channels ended before: a close never ends a live channel. */
function closeSession(
  state: SessionState,
  session: OpenSession,
  endedAt: number,
  endedBy: SessionEnd,
  out: SessionEffect[],
): void {
  const intervals: LiveInterval[] = session.intervals
    .map(
      (interval: LiveInterval): LiveInterval => ({
        ...interval,
        to: Math.min(interval.to, Math.max(endedAt, interval.from)),
      }),
    )
    .sort(byStart);
  out.push({ type: "close", session: { ...openingOf(session), endedAt, endedBy, intervals } });
  state.session = null;
}

/** A channel that continues in the next session, with its open gap. */
type Carried = [ActivityPlatform, PlatformLive, OpenGap | undefined];

/**
 * R10: the session ends at its limit. The channels that are still live, and the schedule that still holds it,
 * continue in a new session that starts at the limit. Their open gaps continue too.
 */
function capSession(state: SessionState, session: OpenSession, capAt: number, out: SessionEffect[]): void {
  const carried: Carried[] = livePlatforms(session)
    .filter(([, live]: [ActivityPlatform, PlatformLive]): boolean => live.offlineAt === null || live.offlineAt > capAt)
    .map(([name, live]: [ActivityPlatform, PlatformLive]): Carried => [name, live, session.gaps[name]]);
  // A channel that went offline before the limit ends at its offline time. Each other channel ends at the limit.
  for (const entry of livePlatforms(session)) {
    const offlineAt: number | null = entry[1].offlineAt;
    if (offlineAt !== null && offlineAt <= capAt) endInterval(session, entry, offlineAt, "provider", out);
    else endInterval(session, entry, capAt, "limit", out);
  }
  const scheduleEndsAt: number | null =
    session.scheduleEndsAt !== null && session.scheduleEndsAt > capAt ? session.scheduleEndsAt : null;
  closeSession(state, session, capAt, "limit", out);
  if (carried.length === 0 && scheduleEndsAt === null) return;
  const next: OpenSession = {
    startedAt: capAt,
    startedBy: carried[0]?.[0] ?? "schedule",
    eventId: session.eventId,
    title: session.title,
    scheduleEndsAt,
    platforms: {},
    gaps: {},
    intervals: [],
  };
  for (const [name, live] of carried)
    next.platforms[name] = { ...live, since: capAt, heardAt: Math.max(live.heardAt, capAt) };
  out.push({ type: "open", session: openingOf(next) });
  for (const [name, , gap] of carried) if (gap) startGap(next, name, gap.reason, capAt, out);
  state.session = next;
}

/** The silence gaps (R11) and the checks (R9) of the live channels. */
function watchSilence(session: OpenSession, now: number, out: SessionEffect[]): void {
  for (const [name, live] of livePlatforms(session)) {
    if (live.offlineAt !== null) continue;
    // A channel with an interruption has its gap already, so a silence gap never covers an outage.
    if (!session.gaps[name] && now - live.heardAt >= SILENCE_GAP_MS)
      startGap(session, name, "silence", live.heardAt, out);
    if (now - Math.max(live.confirmedAt, live.checkAt ?? 0) >= SILENCE_CHECK_MS) {
      live.checkAt = now;
      out.push({ type: "check", platform: name });
    }
  }
}

/** The deadlines that passed: the end of channels and of the session, the limit, silence gaps and checks. */
function advance(state: SessionState, now: number, out: SessionEffect[]): void {
  // Each round of the loop ends one session at its limit. An alarm that is a day late needs a second round.
  for (let round = 0; round <= CHANNEL_PLATFORMS.length; round++) {
    const session: OpenSession | null = state.session;
    if (session === null) return;
    expirePlatforms(session, now, out);
    const capAt: number = session.startedAt + MAX_SESSION_MS;
    const release: Release | null = releaseOf(session, now);
    if (release !== null && release.at <= capAt) {
      if (release.at + GRACE_MS <= now) closeSession(state, session, release.at, release.by, out);
      else watchSilence(session, now, out);
      return;
    }
    if (now < capAt) {
      watchSilence(session, now, out);
      return;
    }
    capSession(state, session, capAt, out);
  }
}

/** R1: the time that a session or an interval starts at, from the start time of the provider when it is recent. */
function providerStart(startedAt: number | undefined, now: number): number {
  return startedAt !== undefined && startedAt <= now && now - startedAt <= PROVIDER_START_WINDOW_MS ? startedAt : now;
}

function cutTitle(value: string | null | undefined): string | null {
  return value ? value.slice(0, STREAM_TITLE_LENGTH) : null;
}

/** R1, R2, R4: a channel went live. */
function online(
  state: SessionState,
  signal: Extract<SessionSignal, { type: "online" }>,
  now: number,
  out: SessionEffect[],
): void {
  const start: number = providerStart(signal.startedAt, now);
  const session: OpenSession | null = state.session;
  if (session === null) {
    const opened: OpenSession = {
      startedAt: start,
      startedBy: signal.platform,
      eventId: state.schedule?.eventId ?? null,
      title: cutTitle(signal.title) ?? state.schedule?.title ?? null,
      scheduleEndsAt: null,
      platforms: {},
      gaps: {},
      intervals: [],
    };
    state.session = opened;
    out.push({ type: "open", session: openingOf(opened) });
    addPlatform(state, opened, signal.platform, start, now, out);
    return;
  }
  session.title ??= cutTitle(signal.title);
  const live: PlatformLive | undefined = session.platforms[signal.platform];
  if (!live) {
    addPlatform(state, session, signal.platform, Math.max(start, session.startedAt), now, out);
    return;
  }
  if (live.offlineAt !== null) {
    // R4: back in the grace time. The session continues, with an offline gap for the channel.
    out.push({ type: "gapStart", platform: signal.platform, reason: "offline", at: live.offlineAt });
    out.push({ type: "gapEnd", platform: signal.platform, reason: "offline", at: now });
    live.offlineAt = null;
    live.heardAt = now;
  }
  live.confirmedAt = now;
  live.checkAt = null;
}

/** R3: a channel went offline. The grace time starts. Its silence gap ends. */
function offline(session: OpenSession, name: ActivityPlatform, at: number, out: SessionEffect[]): void {
  const live: PlatformLive | undefined = session.platforms[name];
  if (live?.offlineAt !== null) return;
  live.offlineAt = Math.max(live.since, at);
  if (session.gaps[name]?.reason === "silence") endGap(session, name, live.offlineAt, out);
}

/** R6: chat or support during a live stream of the schedule starts a session at the start of the stream. */
function activity(state: SessionState, name: ActivityPlatform, now: number, out: SessionEffect[]): void {
  const session: OpenSession | null = state.session;
  const schedule: ScheduleWindow | null = state.schedule;
  if (session === null) {
    if (schedule === null || now < schedule.startsAt || now >= schedule.endsAt) return;
    const opened: OpenSession = {
      startedAt: schedule.startsAt,
      startedBy: "schedule",
      eventId: schedule.eventId,
      title: schedule.title,
      scheduleEndsAt: schedule.endsAt,
      platforms: {},
      gaps: {},
      intervals: [],
    };
    state.session = opened;
    out.push({ type: "open", session: openingOf(opened) });
    return;
  }
  const live: PlatformLive | undefined = session.platforms[name];
  if (live?.offlineAt !== null) return;
  live.heardAt = now;
  live.confirmedAt = Math.max(live.confirmedAt, now);
  if (session.gaps[name]?.reason === "silence") endGap(session, name, now, out);
}

/** R11: an outage or an unwatched channel is a gap. Its end restarts the silence count. */
function status(
  state: SessionState,
  name: ActivityPlatform,
  interruption: Interruption | null,
  now: number,
  out: SessionEffect[],
): void {
  if (interruption === null) delete state.interrupted[name];
  else state.interrupted[name] = interruption;
  const session: OpenSession | null = state.session;
  const live: PlatformLive | undefined = session?.platforms[name];
  if (!session || !live) return;
  const gap: OpenGap | undefined = session.gaps[name];
  if (interruption === null) {
    if (gap?.reason !== "outage" && gap?.reason !== "unwatched") return;
    endGap(session, name, now, out);
    live.heardAt = Math.max(live.heardAt, now);
    live.confirmedAt = Math.max(live.confirmedAt, live.heardAt);
    return;
  }
  if (gap?.reason === interruption) return;
  endGap(session, name, now, out);
  startGap(session, name, interruption, now, out);
}

/** R6, R7: the live stream of the schedule. It links the session, and it holds a session that it started. */
function scheduleLive(state: SessionState, window: ScheduleWindow | null, now: number): void {
  state.schedule = window;
  const session: OpenSession | null = state.session;
  if (session === null) return;
  if (window !== null && session.eventId === null) {
    session.eventId = window.eventId;
    session.title ??= window.title;
  }
  if (session.scheduleEndsAt === null) return;
  // The owner can end the stream early or make it longer. Another stream of the schedule ends this one now.
  session.scheduleEndsAt =
    window !== null && window.eventId === session.eventId ? window.endsAt : Math.min(session.scheduleEndsAt, now);
}

/** R9: the answer to a check. Offline: the channel went offline at its last activity. */
function checked(
  session: OpenSession,
  name: ActivityPlatform,
  live: boolean | null,
  now: number,
  out: SessionEffect[],
): void {
  const platform: PlatformLive | undefined = session.platforms[name];
  if (platform?.offlineAt !== null || live === null) return;
  if (live) {
    platform.confirmedAt = now;
    platform.checkAt = null;
    return;
  }
  offline(session, name, platform.heardAt, out);
}

function apply(state: SessionState, signal: SessionSignal, now: number, out: SessionEffect[]): void {
  switch (signal.type) {
    case "online":
      online(state, signal, now, out);
      break;
    case "offline":
      if (state.session) offline(state.session, signal.platform, now, out);
      break;
    case "activity":
      activity(state, signal.platform, now, out);
      break;
    case "status":
      status(state, signal.platform, signal.interruption, now, out);
      break;
    case "scheduleLive":
      scheduleLive(state, signal.window, now);
      break;
    case "checked":
      if (state.session) checked(state.session, signal.platform, signal.live, now, out);
      break;
    case "tick":
      break;
  }
}
