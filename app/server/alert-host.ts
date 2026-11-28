import nodeCrypto from "node:crypto";
import { z } from "zod";
import {
  DELIVERIES_KEPT,
  isLiveMessage,
  isSupport,
  type ActivityChat,
  type ActivityEvent,
  type ActivityPlatform,
  type ActivitySupport,
} from "../lib/activity";
import {
  ALERT_REFUSALS,
  alertControlSchema,
  type AlertControl,
  type AlertRefusal,
  type AlertsReply,
} from "../lib/alert-control";
import {
  ALERT_MIN,
  ALERT_QUEUE_MAX,
  ALERT_SHOW_MS,
  DEFAULT_TEST_ALERT,
  EMPTY_LINE,
  alertFor,
  alertShownOn,
  alertViewSchema,
  lineAdd,
  lineAdvance,
  lineSkip,
  pendingAlertSchema,
  ruleRecord,
  testSupport,
  type AlertLine,
  type AlertRules,
  type AlertSubject,
  type AlertView,
  type AlertsMessage,
  type LineStep,
  type PendingAlert,
  type StartedAlert,
} from "../lib/alerts";
import { GOAL_COUNTS, countSupport, goalProgressSchema, type GoalCount, type GoalProgress } from "../lib/goals";
import { onAnyOutput, type OverlayLayers } from "../lib/overlay-layers";
import { alertCreditSchema, type AlertCredit } from "../lib/topic-credit";
import type { Reaction } from "../lib/playground/crowd";
import { SNAPSHOT_MAX_AGE_MS } from "./channel-ingest-limits";
import { ALERTS, SUPPORT } from "./channel-ingest-sql";
import { goalCountSchema } from "./goal-votes";
import { LAYER_CHECK_MS, readLayers, type PlaygroundHost, type ReactionSubject } from "./playground-host";

/**
 * The alerts of one page (issue #1043, docs/channel-connections.md), inside the page's ChannelIngest object. The
 * host makes an alert from each live support event that the object stored, with the rules of the alerts layer. One
 * alert shows at one time for ALERT_SHOW_MS; the others wait in a line, and the object's alarm starts the next one.
 * Each activity socket gets the same state, so the two outputs, Streamer tools, and the dock agree.
 *
 * The owner can mute the alerts, skip the alert on stream, send a test, and replay the alert of an event that the
 * object still keeps. A test and a replay make no support event and no row. No alert plays while the alerts are
 * muted, while the alerts layer is off stream, or while no activity socket is open, and none of them plays later.
 * The muted flag, the alert on stream, and the line are in storage, so they survive an eviction of the object.
 *
 * The host also counts the goal of the page (app/lib/goals.ts), while the goal layer has a place on the grid of an
 * output. Each stored support event counts one time: the host keeps the IDs of the newest events, so an event that a
 * provider sends again counts for nothing and plays nothing. The count goes on while the alerts are muted and while
 * no page listens. A test and a replay never reach it. For a goal that counts votes, the API tells the host of each
 * poll vote and each new topic with a key (app/server/goal-votes.ts), and each key counts one time.
 *
 * A message to a socket has the display name of a supporter and never a user ID. The user ID stays in the line, for
 * the reaction of the character, until the alert starts. The API also sends the credit of a featured topic
 * (app/lib/topic-credit.ts). The linked account of its author stays in memory only: no storage and no message has it.
 */

/**
 * The largest number of alerts that wait. An alert never waits longer than the object keeps its support event: the
 * line holds what plays in SNAPSHOT_MAX_AGE_MS, unless the alert contract sets its own limit.
 */
export const ALERT_LINE_MAX: number = ALERT_QUEUE_MAX ?? Math.floor(SNAPSHOT_MAX_AGE_MS / ALERT_SHOW_MS);

/**
 * The largest number of people that a goal for chatters counts, and of votes and topics that a goal for votes
 * counts. The host keeps one key for each of them, so the storage of a goal has a limit.
 */
export const GOAL_PEOPLE_MAX = 100_000;

const NO_STORE = { "Cache-Control": "no-store" } as const;

interface AlertHostOptions {
  sql: SqlStorage;
  /** The open activity sockets: the overlay pages, Streamer tools, and the dock. */
  sockets: () => WebSocket[];
  /** The saved layers of the page (one D1 read). */
  readLayers: () => Promise<OverlayLayers>;
  /** Sets the object's alarm to `at`, unless it already runs earlier. */
  schedule: (at: number) => Promise<void>;
  /** The reaction of the characters (`PlaygroundHost.react`). */
  react: (subject: ReactionSubject | null, action: Reaction, skipPlatform?: ActivityPlatform) => number;
  /** The support event with this ID that the object received at or after `since`, or null. */
  support: (id: string, since: number) => ActivitySupport | null;
}

/**
 * What the host needs from the saved layers. The object keeps this copy, so an event that wakes the object reads no
 * database.
 */
interface AlertConfig {
  /** The alerts layer is on stream in an output. */
  shown: boolean;
  rules: AlertRules;
  /** An output shows chat and characters from Twitch only. */
  twitchOnly: boolean;
  /** What the goal counts. Null: the goal layer has no place on the grid of an output, so the page counts no goal. */
  goal: GoalCount | null;
}

/** The count of the goal, with the salt of the keys of its people. A new count has a new salt. */
interface StoredGoal {
  v: 1;
  progress: GoalProgress;
  salt: string;
}

interface StoredState {
  v: 1;
  muted: boolean;
  current: AlertView | null;
  plays: number;
}

const stateSchema: z.ZodType<StoredState> = z.object({
  v: z.literal(1),
  muted: z.boolean(),
  current: alertViewSchema.nullable(),
  plays: z.number().int().nonnegative(),
});

const ruleSchema = z.object({
  min: z.number().int().min(ALERT_MIN.min).max(ALERT_MIN.max),
  banner: z.boolean(),
  chat: z.boolean(),
  character: z.boolean(),
});

const configSchema: z.ZodType<AlertConfig> = z.object({
  shown: z.boolean(),
  rules: z.object(ruleRecord((): typeof ruleSchema => ruleSchema)),
  twitchOnly: z.boolean(),
  goal: z.enum(GOAL_COUNTS).nullable(),
});

const goalSchema: z.ZodType<StoredGoal> = z.object({
  v: z.literal(1),
  progress: goalProgressSchema,
  salt: z.string().min(1).max(64),
});

/** Only the error class: a message can carry stored text. */
function cause(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function refuse(refusal: AlertRefusal): Response {
  return Response.json({ error: refusal }, { status: ALERT_REFUSALS[refusal], headers: NO_STORE });
}

function alertId(alert: PendingAlert): string {
  return alert.view.id;
}

/**
 * The key of a person, a vote, or a topic in the keys of a goal. It is a hash with the salt of the count, so the
 * storage of a goal has no user ID.
 */
function goalKey(salt: string, key: string): string {
  return nodeCrypto.createHash("sha256").update(`${salt}:${key}`).digest("hex").slice(0, 32);
}

/**
 * The event as an alert shows it. The message of the supporter never goes on stream with an alert: it stays in
 * chat and in the activity list. The text of a topic credit is the title of the topic, so it stays.
 */
function shownEvent(event: ActivitySupport): ActivitySupport {
  if (event.kind === "topic" || event.text === undefined) return event;
  const shown: ActivitySupport = { ...event };
  delete shown.text;
  return shown;
}

/** The alert host of a ChannelIngest object: its storage, its open activity sockets, its layers, its playground. */
export function alertsOf(
  ctx: DurableObjectState,
  env: { DB: D1Database },
  streamerId: () => string | undefined,
  schedule: (at: number) => Promise<void>,
  playground: Pick<PlaygroundHost, "react">,
): AlertHost {
  const sql: SqlStorage = ctx.storage.sql;
  return new AlertHost({
    sql,
    sockets: (): WebSocket[] =>
      ctx.getWebSockets("activity").filter((socket: WebSocket): boolean => socket.readyState === WebSocket.OPEN),
    readLayers: (): Promise<OverlayLayers> => readLayers(env.DB, streamerId()),
    schedule,
    react: (subject: ReactionSubject | null, action: Reaction, skipPlatform?: ActivityPlatform): number =>
      playground.react(subject, action, skipPlatform),
    support: (id: string, since: number): ActivitySupport | null => SUPPORT.find(sql, id, since),
  });
}

/** The earliest send time of the live chat and support events, or `now`: the start of a goal that they wake. */
export function earliestAt(events: readonly ActivityEvent[], now: number): number {
  let at: number = now;
  for (const event of events) {
    if (event.kind !== "chat" && !isSupport(event)) continue;
    const sentAt: number | null = event.sentAt ?? null;
    if (isLiveMessage(sentAt, event.receivedAt)) at = Math.min(at, sentAt ?? event.receivedAt);
  }
  return at;
}

export class AlertHost {
  private muted = false;
  private line: AlertLine = EMPTY_LINE;
  /** The number of tests and replays, so each play has its own ID. */
  private plays = 0;
  private config: AlertConfig | null = null;
  /** The count of the goal. It stays while the goal layer is off the grid, and goes on when the layer comes back. */
  private goal: StoredGoal | null = null;
  /** When this instance of the object read the layers. 0: not yet, so the copy from storage can be old. */
  private configAt = 0;
  /** The number of wipes. A read that a wipe overtook applies nothing, so it cannot bring back deleted state. */
  private wipes = 0;
  /** While the first read runs: the start of a goal that the read starts. */
  private goalFrom = Infinity;
  /** When the host last tried to read the layers, with or without success. */
  private triedAt = 0;
  /** When the host last used its copy of the layers for an event: an alert or a count of the goal. */
  private usedAt = 0;
  /** The state changed since the sockets got it. */
  private unsent = false;
  private refreshing: Promise<boolean> | null = null;
  /** The saved layers changed while a read ran: that read is followed by one more. */
  private stale = false;
  /** The participant of each topic credit in the line, by the ID of its alert. Only memory has it, never storage. */
  private readonly links = new Map<string, AlertSubject>();
  /** While the object takes in a topic credit: its event ID and the participant of its author. */
  private crediting: { id: string; subject: AlertSubject } | null = null;

  constructor(private readonly options: AlertHostOptions) {}

  /**
   * Makes the tables and restores the state after a wake. A stored state or line that is not valid is dropped: the
   * host then starts with no alert. A copy of the layers that is not valid is read again when a page listens.
   */
  load(): void {
    const sql: SqlStorage = this.options.sql;
    ALERTS.create(sql);
    const stored: unknown = ALERTS.read(sql, "state");
    const state = stateSchema.safeParse(stored);
    const waiting = z.array(pendingAlertSchema).safeParse(ALERTS.line(sql));
    const config = configSchema.safeParse(ALERTS.read(sql, "config"));
    const goal = goalSchema.safeParse(ALERTS.read(sql, "goal"));
    const valid: boolean = waiting.success && (state.success || stored === undefined);
    if (!valid) {
      // The reason can quote stored names, so only the event is logged.
      console.warn("alerts_state_invalid");
      ALERTS.clear(sql);
    }
    this.muted = state.success && state.data.muted;
    this.plays = state.success ? state.data.plays : 0;
    this.line = {
      current: state.success ? state.data.current : null,
      waiting: valid && waiting.success ? waiting.data : [],
    };
    this.config = config.success ? config.data : null;
    this.goal = goal.success ? goal.data : null;
    // A new instance must not find the damage again.
    if (!valid) this.save();
  }

  /** The page is going away, and the caller deleted the storage: the host starts again with empty tables. */
  wipe(): void {
    this.muted = false;
    this.line = EMPTY_LINE;
    this.plays = 0;
    this.config = null;
    this.goal = null;
    this.configAt = 0;
    this.triedAt = 0;
    this.usedAt = 0;
    this.unsent = false;
    this.wipes += 1;
    this.refreshing = null;
    this.stale = false;
    this.links.clear();
    ALERTS.create(this.options.sql);
  }

  /**
   * One event that the object stored and sent to the sockets. A chat message can count for the goal. A support
   * event counts for the goal and can make an alert, one time: the object's own memory of IDs is short, so the host
   * refuses an ID that it knows.
   */
  receive(event: ActivityEvent): void {
    const now: number = Date.now();
    if (event.kind === "chat") this.chatted(event);
    else if (isSupport(event) && !event.replay && ALERTS.first(this.options.sql, event.id, DELIVERIES_KEPT)) {
      if (this.config !== null) this.usedAt = now;
      this.count(event);
      this.live(event, now);
    }
    this.flush(now);
  }

  /** A socket was accepted. It gets the state after the snapshot: the alert on stream has its end time. */
  async opened(socket: WebSocket): Promise<void> {
    if (this.old(Date.now())) await this.refresh();
    const now: number = Date.now();
    // A read that changed the state is news for each socket. Else only the new socket needs the state.
    const sockets: WebSocket[] = this.unsent ? this.options.sockets() : [socket];
    this.unsent = false;
    this.send(sockets, { type: "alerts", ...this.reply(now) });
  }

  /** The saved layers changed (`/playground-config`): the host reads them again. */
  /**
   * Reads the layers when the host has no copy, so the events that come next count for the goal and play alerts. A
   * goal that this read starts counts from `since`: the earliest of these events, also of the callers that share the
   * read. False: the read failed and the host has no copy, so the caller takes in nothing and the events come again.
   */
  async ready(since: number): Promise<boolean> {
    if (this.config !== null) return true;
    this.goalFrom = Math.min(this.goalFrom, since);
    try {
      await this.refresh();
    } finally {
      this.goalFrom = Infinity;
    }
    return this.config !== null;
  }

  async layersChanged(): Promise<void> {
    await this.refresh(true);
    this.flush(Date.now());
  }

  /** One request on an alert path of the object: `/alerts` (a control) or `/alert-credit` (a topic credit). */
  route(
    path: string,
    request: Request,
    ingest: (events: readonly ActivityEvent[], now: number) => void,
  ): Promise<Response> {
    return path === "/alert-credit" ? this.topicCredit(request, ingest) : this.request(request);
  }

  /**
   * The object's `/alert-credit` request: a topic credit from the API, never from the owner or the dock. A `credit`
   * goes through `ingest` as the support event of a platform does: the same dedupe, support table, snapshot, and
   * rows. A `replay` plays the alert of a credit that the object keeps. The subject of the author is only in memory.
   */
  async topicCredit(
    request: Request,
    ingest: (events: readonly ActivityEvent[], now: number) => void,
  ): Promise<Response> {
    const parsed = alertCreditSchema.safeParse(await request.json().catch((): null => null));
    if (!parsed.success) return Response.json({ error: "Invalid credit" }, { status: 400, headers: NO_STORE });
    const credit: AlertCredit = parsed.data;
    // The feature can come with the change that put the alerts layer on stream: the host reads the layers first.
    if (!(await this.refresh(true)) && this.config === null) return refuse("alerts_unavailable");
    const now: number = Date.now();
    let refusal: AlertRefusal | null = null;
    if (credit.op === "replay") {
      const since: number = now - SNAPSHOT_MAX_AGE_MS;
      const stored = (): ActivitySupport | null => this.options.support(credit.id, since);
      refusal = this.play(stored, "replay", now, credit.subject);
    } else {
      this.crediting = credit.subject === null ? null : { id: credit.event.id, subject: credit.subject };
      try {
        ingest([credit.event], now);
      } finally {
        this.crediting = null;
      }
      // The alarm expires the stored event on time, also when no other event comes.
      await this.options.schedule(now + SNAPSHOT_MAX_AGE_MS + 1);
    }
    this.keepLinks();
    this.flush(now);
    await this.wake();
    return refusal === null ? Response.json(this.reply(now), { headers: NO_STORE }) : refuse(refusal);
  }

  /** The object's `/alerts` request: one control of the owner or of the dock. The API checked who sent it. */
  async request(request: Request): Promise<Response> {
    const parsed = alertControlSchema.safeParse(await request.json().catch((): null => null));
    if (!parsed.success) return Response.json({ error: "Invalid control" }, { status: 400, headers: NO_STORE });
    const control: AlertControl = parsed.data;
    // The owner can send a test right after a layer change, so a test, a replay, and a new count of the goal read
    // the saved layers first. A read that fails keeps the copy that the host has.
    const plays: boolean = control.op === "test" || control.op === "replay" || control.op === "goalReset";
    if (plays && !(await this.refresh(true)) && this.config === null) return refuse("alerts_unavailable");
    const now: number = Date.now();
    const refusal: AlertRefusal | null = this.control(control, now);
    this.flush(now);
    await this.wake();
    return refusal === null ? Response.json(this.reply(now), { headers: NO_STORE }) : refuse(refusal);
  }

  /**
   * The object's `/goal-count` request: a poll vote or a new topic, from the API (app/server/goal-votes.ts). Only a
   * goal that counts votes counts it, one time for each key. The request is not a control: the owner route and the
   * dock route never send it. The host reads the saved layers only when it has no copy of them.
   */
  async goalCount(request: Request): Promise<Response> {
    const parsed = goalCountSchema.safeParse(await request.json().catch((): null => null));
    if (!parsed.success) return Response.json({ error: "Invalid count" }, { status: 400, headers: NO_STORE });
    if (!(await this.ready(Date.now()))) return refuse("alerts_unavailable");
    this.voted(parsed.data.key);
    this.flush(Date.now());
    await this.wake();
    return new Response(null, { status: 204, headers: NO_STORE });
  }

  /**
   * The object's alarm. It reads the layers again when the copy is old and the host uses it: a page listens, the
   * goal counts, an event used the copy, or the host has no copy. Thus a missed change does not stay. Then it ends
   * the alert on stream when its time is over, and starts the next one.
   */
  async alarm(): Promise<void> {
    const used: boolean =
      this.options.sockets().length > 0 || this.config === null || this.counts() !== null || this.checks();
    if (used && this.old(Date.now())) await this.refresh();
    const now: number = Date.now();
    // No page listens: the alerts have nobody to play for, and none of them plays later.
    if (this.options.sockets().length === 0) this.clear();
    else this.take(lineAdvance(this.line, now));
    this.flush(now);
    await this.wake();
  }

  /**
   * Sets the object's alarm to the end of the alert on stream, and to the next read of the layers while the host
   * uses its copy. Thus a missed layer change stays at most LAYER_CHECK_MS, also when no alert plays.
   */
  async wake(): Promise<void> {
    const ends: number = this.line.current?.endsAt ?? Infinity;
    const check: number = this.checks() ? this.triedAt + LAYER_CHECK_MS : Infinity;
    const at: number = Math.min(ends, check);
    if (at !== Infinity) await this.options.schedule(at);
  }

  /** The host used its copy of the layers for an event after the last read. */
  private checks(): boolean {
    return this.usedAt > this.configAt;
  }

  /** The owner disconnected a platform: its alerts leave the line, as its support events leave the snapshot. */
  dropPlatform(platform: ActivityPlatform): void {
    const waiting: PendingAlert[] = this.line.waiting.filter(
      (alert: PendingAlert): boolean => alert.view.platform !== platform,
    );
    const current: AlertView | null = this.line.current?.platform === platform ? null : this.line.current;
    if (current === this.line.current && waiting.length === this.line.waiting.length) return;
    const now: number = Date.now();
    this.take(lineAdvance({ current, waiting }, now));
    this.flush(now);
  }

  private control(control: AlertControl, now: number): AlertRefusal | null {
    switch (control.op) {
      case "status":
        return null;
      case "skip":
        this.take(lineSkip(this.line, now));
        return null;
      case "mute":
        this.mute(control.on);
        return null;
      case "goalReset": {
        const counts: GoalCount | null = this.counts();
        if (counts === null) return "goal_off";
        this.startGoal(counts, now);
        return null;
      }
      case "test": {
        const test = control.kind ?? DEFAULT_TEST_ALERT;
        return this.play((play: number): ActivitySupport => testSupport(test, play, now), "test", now);
      }
      case "replay": {
        const since: number = now - SNAPSHOT_MAX_AGE_MS;
        return this.play((): ActivitySupport | null => this.options.support(control.id, since), "replay", now);
      }
    }
  }

  /**
   * The alert of a live support event. The rules decide what it does: nothing, an alert that plays at once, or a
   * banner that waits for its turn in the line.
   */
  private live(event: ActivitySupport, now: number): void {
    const config: AlertConfig | null = this.config;
    if (!config?.shown || this.muted || this.options.sockets().length === 0) return;
    // A provider can send an old event again a long time after it occurred: it plays no alert.
    if (!isLiveMessage(event.sentAt ?? null, event.receivedAt)) return;
    const alert: PendingAlert | null = alertFor(shownEvent(event), config.rules);
    if (alert !== null && this.crediting?.id === event.id) this.link(alert, this.crediting.subject);
    // A line that is full drops the alert.
    if (alert !== null) this.add(alert, now);
  }

  /** What the goal of the page counts. Null: the goal layer has no place on a grid, so the page counts no goal. */
  private counts(): GoalCount | null {
    return this.config?.goal ?? null;
  }

  /** The goal that counts now, or null. */
  private counting(): StoredGoal | null {
    return this.counts() === null ? null : this.goal;
  }

  /** Counts a support event for the goal. The alerts do not change this: muted or not, with a page or without one. */
  private count(event: ActivitySupport): void {
    const goal: StoredGoal | null = this.counting();
    if (goal !== null) this.progress(goal, countSupport(goal.progress, event));
  }

  /**
   * Counts the sender of a chat message for a goal that counts chatters: one for each participant of a platform,
   * for a message from the start of the count or later, up to GOAL_PEOPLE_MAX people.
   */
  private chatted(event: ActivityChat): void {
    const goal: StoredGoal | null = this.counting();
    if (goal?.progress.counts !== "chatters") return;
    const { value, startedAt } = goal.progress;
    if ((event.sentAt ?? event.receivedAt) < startedAt || value >= GOAL_PEOPLE_MAX) return;
    if (!ALERTS.person(this.options.sql, goalKey(goal.salt, `${event.platform}:${event.user.id}`))) return;
    this.progress(goal, { ...goal.progress, value: value + 1 });
  }

  /** Counts a poll vote or a new topic for a goal that counts votes, up to GOAL_PEOPLE_MAX keys. */
  private voted(key: string): void {
    const goal: StoredGoal | null = this.counting();
    if (goal?.progress.counts !== "votes" || goal.progress.value >= GOAL_PEOPLE_MAX) return;
    if (!ALERTS.person(this.options.sql, goalKey(goal.salt, key))) return;
    this.progress(goal, { ...goal.progress, value: goal.progress.value + 1 });
  }

  private progress(goal: StoredGoal, next: GoalProgress): void {
    if (next === goal.progress) return;
    this.goal = { ...goal, progress: next };
    this.usedAt = Date.now();
    ALERTS.write(this.options.sql, "goal", this.goal);
    this.unsent = true;
  }

  /** Starts a new count at 0, from now. The people of the count before are forgotten. */
  private startGoal(counts: GoalCount, now: number): void {
    this.goal = { v: 1, progress: { counts, value: 0, startedAt: now }, salt: crypto.randomUUID() };
    ALERTS.write(this.options.sql, "goal", this.goal);
    ALERTS.forgetPeople(this.options.sql);
    this.unsent = true;
  }

  /**
   * Mute stops the alert on stream at once and discards the alerts that wait. While the alerts are muted, an event
   * makes no alert, so nothing plays after the mute ends.
   */
  private mute(on: boolean): void {
    if (on === this.muted) return;
    this.muted = on;
    this.unsent = true;
    if (on) this.clear();
    this.save();
  }

  /**
   * A test or a replay of the owner. It makes no support event and counts for nothing, and the amount of the rule
   * does not apply to it. `source` gives the event for the number of the play, or null for a replay of an event
   * that the object does not keep.
   */
  private play(
    source: (play: number) => ActivitySupport | null,
    origin: "test" | "replay",
    now: number,
    subject: AlertSubject | null = null,
  ): AlertRefusal | null {
    const config: AlertConfig | null = this.config;
    if (!config?.shown) return "alerts_off_stream";
    if (this.muted) return "alerts_muted";
    const play: number = this.plays + 1;
    const event: ActivitySupport | null = source(play);
    if (event === null) return "alert_gone";
    if (this.options.sockets().length === 0) return "alerts_unwatched";
    const alert: PendingAlert | null = alertFor(shownEvent(event), config.rules, origin, play);
    if (alert === null) return "alert_rule_off";
    if (subject !== null && event.kind === "topic") this.link(alert, subject);
    if (!this.add(alert, now)) return "alerts_full";
    this.plays = play;
    this.save();
    return null;
  }

  /** Puts a new alert in the line, or starts it. False: the line is full, and the alert is dropped. */
  private add(alert: PendingAlert, now: number): boolean {
    const step: LineStep = lineAdd(this.line, alert, now, ALERT_LINE_MAX);
    if (step.line === this.line && step.started === null) return false;
    this.take(step);
    return true;
  }

  /** Takes the line after a step, and starts the alert of the step. */
  private take(step: LineStep): void {
    const { current, waiting } = step.line;
    if (current !== this.line.current || waiting !== this.line.waiting) this.setLine(step.line);
    if (step.started !== null) this.start(step.started);
  }

  /** Empties the line: the alert on stream stops, and no alert waits. */
  private clear(): void {
    if (this.line.current !== null || this.line.waiting.length > 0) this.setLine(EMPTY_LINE);
    this.keepLinks();
  }

  /** The character of `subject` reacts when the topic credit `alert` starts. The line in storage has no subject. */
  private link(alert: PendingAlert, subject: AlertSubject): void {
    this.links.set(alert.view.id, subject);
  }

  /** Forgets the subject of each topic credit that left the line without a start: it was dropped or removed. */
  private keepLinks(): void {
    if (this.links.size === 0) return;
    const waiting = new Set<string>(this.line.waiting.map(alertId));
    for (const id of this.links.keys()) if (!waiting.has(id)) this.links.delete(id);
  }

  /** Stores the line: one row for each alert that waits, and the alert on stream with the state. */
  private setLine(next: AlertLine): void {
    const sql: SqlStorage = this.options.sql;
    const known = new Set<string>(this.line.waiting.map(alertId));
    const kept = new Set<string>(next.waiting.map(alertId));
    for (const id of known) if (!kept.has(id)) ALERTS.drop(sql, id);
    for (const alert of next.waiting) if (!known.has(alert.view.id)) ALERTS.wait(sql, alert);
    const moved: boolean = next.current !== this.line.current;
    this.line = next;
    this.unsent = true;
    if (moved) this.save();
  }

  private save(): void {
    const state: StoredState = { v: 1, muted: this.muted, current: this.line.current, plays: this.plays };
    ALERTS.write(this.options.sql, "state", state);
  }

  /**
   * An alert starts. Its character reacts: the character of the supporter, or the crowd. An alert without a banner
   * is not in the state, so the sockets get it as its own message, when the chat marks it.
   */
  private start(alert: StartedAlert): void {
    const { view, action } = alert;
    // A topic credit has its subject in memory only.
    const subject: AlertSubject | null = alert.subject ?? this.links.get(view.id) ?? null;
    this.links.delete(view.id);
    if (action !== null) {
      // One playground serves the two outputs. An output that shows only Twitch must show no reaction to an event
      // of a different platform, so the crowd then leaves the Twitch characters out.
      const hidden: boolean = this.config?.twitchOnly === true && !alertShownOn(view, "twitch");
      const skip: ActivityPlatform | undefined = hidden ? "twitch" : undefined;
      if (action === "crowd") this.options.react(null, "cheer", skip);
      else this.options.react(subject, action, skip);
    }
    if (!view.banner && view.chat) this.send(this.options.sockets(), { type: "alert", alert: view });
  }

  /** The state for a client. An alert whose time is over is not on stream, also when the alarm is late. */
  private reply(now: number): AlertsReply {
    const current: AlertView | null = this.line.current;
    return {
      at: now,
      muted: this.muted,
      current: current !== null && now < current.endsAt ? current : null,
      waiting: this.line.waiting.length,
      goal: this.counting()?.progress ?? null,
    };
  }

  /** Sends the state to each socket when it changed. */
  private flush(now: number): void {
    if (!this.unsent) return;
    this.unsent = false;
    this.send(this.options.sockets(), { type: "alerts", ...this.reply(now) });
  }

  private send(sockets: WebSocket[], message: AlertsMessage): void {
    const text: string = JSON.stringify(message);
    for (const socket of sockets) {
      try {
        socket.send(text);
      } catch {
        // The socket already closed; the runtime calls webSocketClose.
      }
    }
  }

  /** True when the copy of the layers can be old: a change notice that did not arrive must not stay for long. */
  private old(now: number): boolean {
    return now - this.configAt >= LAYER_CHECK_MS;
  }

  /**
   * Reads the layers once, also for callers that ask while a read runs. With `changed` (the saved layers changed),
   * a read that already runs is followed by one more. A failed read keeps what is known and gives false.
   */
  private refresh(changed = false): Promise<boolean> {
    if (this.refreshing) {
      this.stale ||= changed;
      return this.refreshing;
    }
    const reading: Promise<boolean> = this.read().finally((): void => {
      // A wipe can start a new read while this one runs: that read stays.
      if (this.refreshing === reading) this.refreshing = null;
    });
    this.refreshing = reading;
    return reading;
  }

  private async read(): Promise<boolean> {
    const wipes: number = this.wipes;
    let ok: boolean;
    do {
      this.stale = false;
      try {
        const layers: OverlayLayers = await this.options.readLayers();
        if (wipes !== this.wipes) return false;
        this.apply(layers);
        ok = true;
      } catch (error: unknown) {
        console.error("alerts_config_failed", { cause: cause(error) });
        ok = false;
      }
      this.triedAt = Date.now();
    } while (this.stale);
    return ok;
  }

  private apply(layers: OverlayLayers): void {
    // The goal counts while its layer has a place on a grid. The switch "Show on stream" does not stop the count.
    const placed: boolean = layers.cells.horizontal.goal !== null || layers.cells.vertical.goal !== null;
    const config: AlertConfig = {
      shown: onAnyOutput(layers, "alerts"),
      rules: layers.alerts.rules,
      twitchOnly: layers.twitchOnly.horizontal || layers.twitchOnly.vertical,
      goal: placed ? layers.goal.counts : null,
    };
    const counted: StoredGoal | null = this.counting();
    this.configAt = Date.now();
    // An unchanged copy writes nothing: the alarm reads the layers every LAYER_CHECK_MS while the host uses them.
    if (JSON.stringify(config) !== JSON.stringify(this.config)) ALERTS.write(this.options.sql, "config", config);
    this.config = config;
    // Off stream, the alerts stop: no page shows them.
    if (!config.shown) this.clear();
    // A goal that counts a different thing starts again at the read. A new title or a new target changes nothing here.
    // The first goal also counts the live events that woke the read.
    const startAt: number = this.goal === null ? Math.min(this.configAt, this.goalFrom) : this.configAt;
    if (config.goal !== null && this.goal?.progress.counts !== config.goal) this.startGoal(config.goal, startAt);
    if (this.counting() !== counted) this.unsent = true;
  }
}
