import { z } from "zod";
import {
  isLiveMessage,
  isSupport,
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
  type AlertView,
  type AlertsMessage,
  type LineStep,
  type PendingAlert,
  type StartedAlert,
} from "../lib/alerts";
import { onAnyOutput, type OverlayLayers } from "../lib/overlay-layers";
import type { Reaction } from "../lib/playground/crowd";
import { SNAPSHOT_MAX_AGE_MS } from "./channel-ingest-limits";
import { ALERTS, SUPPORT } from "./channel-ingest-sql";
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
 * A message to a socket has the display name of a supporter and never a user ID. The user ID stays in the line, for
 * the reaction of the character, until the alert starts.
 */

/**
 * The largest number of alerts that wait. An alert never waits longer than the object keeps its support event: the
 * line holds what plays in SNAPSHOT_MAX_AGE_MS, unless the alert contract sets its own limit.
 */
export const ALERT_LINE_MAX: number = ALERT_QUEUE_MAX ?? Math.floor(SNAPSHOT_MAX_AGE_MS / ALERT_SHOW_MS);

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

export class AlertHost {
  private muted = false;
  private line: AlertLine = EMPTY_LINE;
  /** The number of tests and replays, so each play has its own ID. */
  private plays = 0;
  private config: AlertConfig | null = null;
  /** When this instance of the object read the layers. 0: not yet, so the copy from storage can be old. */
  private configAt = 0;
  /** The state changed since the sockets got it. */
  private unsent = false;
  private refreshing: Promise<boolean> | null = null;
  /** The saved layers changed while a read ran: that read is followed by one more. */
  private stale = false;

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
    // A new instance must not find the damage again.
    if (!valid) this.save();
  }

  /** The page is going away, and the caller deleted the storage: the host starts again with empty tables. */
  wipe(): void {
    this.muted = false;
    this.line = EMPTY_LINE;
    this.plays = 0;
    this.config = null;
    this.configAt = 0;
    this.unsent = false;
    ALERTS.create(this.options.sql);
  }

  /**
   * One event that the object stored and sent to the sockets. Only a live support event makes an alert. The rules
   * decide what it does: nothing, an alert that plays at once, or a banner that waits for its turn in the line.
   */
  receive(event: ActivityEvent): void {
    if (!isSupport(event) || event.replay) return;
    const now: number = Date.now();
    const config: AlertConfig | null = this.config;
    if (!config?.shown || this.muted || this.options.sockets().length === 0) return;
    // A provider can send an old event again a long time after it occurred: it plays no alert.
    if (!isLiveMessage(event.sentAt ?? null, event.receivedAt)) return;
    const alert: PendingAlert | null = alertFor(shownEvent(event), config.rules);
    // A line that is full drops the alert.
    if (alert !== null) this.add(alert, now);
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
  async layersChanged(): Promise<void> {
    await this.refresh(true);
    this.flush(Date.now());
  }

  /** The object's `/alerts` request: one control of the owner or of the dock. The API checked who sent it. */
  async request(request: Request): Promise<Response> {
    const parsed = alertControlSchema.safeParse(await request.json().catch((): null => null));
    if (!parsed.success) return Response.json({ error: "Invalid control" }, { status: 400, headers: NO_STORE });
    const control: AlertControl = parsed.data;
    // The owner can send a test right after a layer change, so a test and a replay read the saved layers first. A
    // read that fails keeps the copy that the host has.
    const plays: boolean = control.op === "test" || control.op === "replay";
    if (plays && !(await this.refresh(true)) && this.config === null) return refuse("alerts_unavailable");
    const now: number = Date.now();
    const refusal: AlertRefusal | null = this.control(control, now);
    this.flush(now);
    await this.wake();
    return refusal === null ? Response.json(this.reply(now), { headers: NO_STORE }) : refuse(refusal);
  }

  /**
   * The object's alarm. It reads the layers again when the copy is old and a page listens, so a missed change does
   * not stay. Then it ends the alert on stream when its time is over, and starts the next one.
   */
  async alarm(): Promise<void> {
    if (this.options.sockets().length > 0 && this.old(Date.now())) await this.refresh();
    const now: number = Date.now();
    // No page listens: the alerts have nobody to play for, and none of them plays later.
    if (this.options.sockets().length === 0) this.clear();
    else this.take(lineAdvance(this.line, now));
    this.flush(now);
    await this.wake();
  }

  /** Sets the object's alarm to the end of the alert on stream. */
  async wake(): Promise<void> {
    if (this.line.current !== null) await this.options.schedule(this.line.current.endsAt);
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
    const { view, subject, action } = alert;
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
      goal: null,
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
    this.refreshing = this.read().finally((): void => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async read(): Promise<boolean> {
    let ok: boolean;
    do {
      this.stale = false;
      try {
        this.apply(await this.options.readLayers());
        ok = true;
      } catch (error: unknown) {
        console.error("alerts_config_failed", { cause: cause(error) });
        ok = false;
      }
    } while (this.stale);
    return ok;
  }

  private apply(layers: OverlayLayers): void {
    const config: AlertConfig = {
      shown: onAnyOutput(layers, "alerts"),
      rules: layers.alerts.rules,
      twitchOnly: layers.twitchOnly.horizontal || layers.twitchOnly.vertical,
    };
    this.configAt = Date.now();
    // An unchanged copy writes nothing: the alarm reads the layers every LAYER_CHECK_MS while a page listens.
    if (JSON.stringify(config) !== JSON.stringify(this.config)) ALERTS.write(this.options.sql, "config", config);
    this.config = config;
    // Off stream, the alerts stop: no page shows them.
    if (!config.shown) this.clear();
  }
}
