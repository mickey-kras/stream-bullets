import { z } from "zod";
import { CHANNEL_PLATFORMS } from "../../db/enums";
// Types only: app/lib/activity.ts reads the schemas of this module.
import type { ActivityPlatform, ActivitySupport, SupportKind, SupportSource } from "./activity";
import { goalProgressSchema, type GoalProgress } from "./goals";

/**
 * Alerts on stream (issue #1043): the rules that make an alert from a support event, what a client shows, and the
 * line of alerts. This module is pure. The server keeps the line and sends the messages on the activity socket; the
 * alerts layer holds the rules (app/lib/overlay-layers.ts).
 */

/** One alert shows at one time, for this long. */
export const ALERT_SHOW_MS = 6000;
/** The largest number of alerts that wait in the line. Null: the line has no limit. */
export const ALERT_QUEUE_MAX: number | null = null;
/** The longest text of the supporter in an alert, in characters. The text of the event is cut to it. */
export const ALERT_TEXT_LENGTH = 200;

/**
 * The rules of the alerts layer, in the sequence of the editor. `subscription` is also for a membership, `bits`
 * also for KICKs, and `paid` is for a Super Chat and a Super Sticker.
 */
export const ALERT_RULES = ["follow", "subscription", "gift", "bits", "paid", "raid", "topic"] as const;
export type AlertRuleId = (typeof ALERT_RULES)[number];

/** The support kinds that can make an alert. A direct tip and reactions have no rule, so they make no alert. */
export const ALERT_KINDS = [
  "follow",
  "subscription",
  "membership",
  "gift",
  "raid",
  "bits",
  "super_chat",
  "super_sticker",
  "kicks",
  "topic",
] as const satisfies readonly SupportKind[];
export type AlertKind = (typeof ALERT_KINDS)[number];

/** The rule of each kind. */
export const KIND_RULES: Readonly<Record<AlertKind, AlertRuleId>> = {
  follow: "follow",
  subscription: "subscription",
  membership: "subscription",
  gift: "gift",
  raid: "raid",
  bits: "bits",
  super_chat: "paid",
  super_sticker: "paid",
  kicks: "bits",
  topic: "topic",
};

/** One value for each rule. */
export function ruleRecord<T>(value: (rule: AlertRuleId) => T): Record<AlertRuleId, T> {
  return {
    follow: value("follow"),
    subscription: value("subscription"),
    gift: value("gift"),
    bits: value("bits"),
    paid: value("paid"),
    raid: value("raid"),
    topic: value("topic"),
  };
}

function isAlertKind(kind: SupportKind): kind is AlertKind {
  const kinds: readonly string[] = ALERT_KINDS;
  return kinds.includes(kind);
}

/** What one rule does. */
export interface AlertRule {
  /**
   * The smallest amount that starts the alert: gifts in a bundle, Bits or KICKs, or viewers of a raid. Only the
   * rules of THRESHOLD_RULES use it. Each other rule has 1 and makes an alert for each event.
   */
  min: number;
  /** The banner shows in the alerts layer. */
  banner: boolean;
  /** The chat layer marks the event. */
  chat: boolean;
  /** The character of the viewer reacts in the characters layer. */
  character: boolean;
}
export type AlertRules = Record<AlertRuleId, AlertRule>;

/** The rules with an amount where the alert starts. */
export const THRESHOLD_RULES = ["gift", "bits", "raid"] as const satisfies readonly AlertRuleId[];
export type ThresholdRule = (typeof THRESHOLD_RULES)[number];

export function hasThreshold(rule: AlertRuleId): rule is ThresholdRule {
  const rules: readonly string[] = THRESHOLD_RULES;
  return rules.includes(rule);
}

/** The limits of the amount where an alert starts: the one source for the layers and the editor. */
export const ALERT_MIN = { min: 1, max: 1_000_000 } as const;

/**
 * The amounts where an alert starts by default: each gift bundle, 100 Bits or 100 KICKs, and a raid of 5 viewers.
 * Bits and KICKs have one rule, and thus one amount.
 */
export const DEFAULT_THRESHOLDS: Readonly<Record<ThresholdRule, number>> = { gift: 1, bits: 100, raid: 5 };

const ALL_ON = { min: ALERT_MIN.min, banner: true, chat: true, character: true } as const;

/** The rules of a page that changed none. A follow has no banner: follows come often. */
export const DEFAULT_RULES: Readonly<Record<AlertRuleId, Readonly<AlertRule>>> = {
  follow: { ...ALL_ON, banner: false },
  subscription: ALL_ON,
  gift: { ...ALL_ON, min: DEFAULT_THRESHOLDS.gift },
  bits: { ...ALL_ON, min: DEFAULT_THRESHOLDS.bits },
  paid: ALL_ON,
  raid: { ...ALL_ON, min: DEFAULT_THRESHOLDS.raid },
  topic: ALL_ON,
};

/** What a character does for an alert. `crowd` makes each character on screen cheer. */
export const ALERT_ACTIONS = ["wave", "jump", "crowd"] as const;
export type AlertAction = (typeof ALERT_ACTIONS)[number];

/** The character action of each rule. An alert without a known character always gets the crowd action. */
export const RULE_ACTIONS: Readonly<Record<AlertRuleId, AlertAction>> = {
  follow: "wave",
  subscription: "jump",
  gift: "jump",
  bits: "jump",
  paid: "jump",
  raid: "crowd",
  topic: "wave",
};

/** Why an alert plays: a live event, a replay of the owner, or a test. A replay and a test never count. */
export const ALERT_ORIGINS = ["live", "replay", "test"] as const;
export type AlertOrigin = (typeof ALERT_ORIGINS)[number];

/**
 * What a client shows for one alert. It has the display name and never a user ID. Each text field is untrusted
 * input: render it as text, never as HTML.
 */
export interface AlertView {
  /** One play of an alert: the ID of the event, and for a replay also the number of the play. */
  id: string;
  origin: AlertOrigin;
  kind: AlertKind;
  /** `direct` for a topic credit, and only for it. */
  platform: SupportSource;
  /** The display name of the supporter. Null: anonymous, or the platform does not say. */
  name: string | null;
  /** True when the supporter asked to stay anonymous. An anonymous view never has a name. */
  anonymous: boolean;
  /** The amount in the native unit of the kind, as in the support event. */
  amount: number | null;
  currency: string | null;
  /** The text of the supporter, at most ALERT_TEXT_LENGTH characters. For a topic credit: the title of the topic. */
  text?: string;
  /** The alerts layer shows the banner. */
  banner: boolean;
  /** The chat layer marks the event. */
  chat: boolean;
  /** The server times of the banner. They are equal for an alert without a banner. */
  startsAt: number;
  endsAt: number;
}

/** An alert before it starts: it has no times. */
export type AlertDraft = Omit<AlertView, "startsAt" | "endsAt">;

/** The participant whose character reacts to an alert. Only the server has it: no message to a client has a user ID. */
export interface AlertSubject {
  platform: ActivityPlatform;
  userId: string;
}

/** An alert that waits in the line, or starts. */
export interface PendingAlert {
  view: AlertDraft;
  /** Null: anonymous, a test, or the event does not name a participant of a platform. */
  subject: AlertSubject | null;
  /** Null: the rule has the character switch off. */
  action: AlertAction | null;
}

/** An alert that started: its view has the times. */
export interface StartedAlert extends Omit<PendingAlert, "view"> {
  view: AlertView;
}

const time = z.number().int().nonnegative();
const draftShape = {
  id: z.string().min(1).max(200),
  origin: z.enum(ALERT_ORIGINS),
  kind: z.enum(ALERT_KINDS),
  platform: z.enum([...CHANNEL_PLATFORMS, "direct"]),
  name: z.string().max(100).nullable(),
  anonymous: z.boolean(),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  text: z.string().max(ALERT_TEXT_LENGTH).optional(),
  banner: z.boolean(),
  chat: z.boolean(),
};

/** An anonymous view never has a name. */
function nameless(view: AlertDraft): boolean {
  return !view.anonymous || view.name === null;
}

/** A topic credit is direct, and no other alert is. */
function sourced(view: AlertDraft): boolean {
  return (view.kind === "topic") === (view.platform === "direct");
}

/** A view from a socket message or from storage. The parser drops each field that is not a field of a view. */
export const alertViewSchema: z.ZodType<AlertView> = z
  .object({ ...draftShape, startsAt: time, endsAt: time })
  .refine(nameless)
  .refine(sourced)
  .refine((view: AlertView): boolean => view.endsAt >= view.startsAt);

/** An alert of the line from storage. An anonymous alert has no subject. */
export const pendingAlertSchema: z.ZodType<PendingAlert> = z
  .object({
    view: z.object(draftShape).refine(nameless).refine(sourced),
    subject: z.object({ platform: z.enum(CHANNEL_PLATFORMS), userId: z.string().min(1).max(128) }).nullable(),
    action: z.enum(ALERT_ACTIONS).nullable(),
  })
  .refine((alert: PendingAlert): boolean => !alert.view.anonymous || alert.subject === null);

/** `value` without the characters after `max`. It never cuts a character in two. */
export function cut(value: string, max: number): string {
  let text = "";
  for (const char of value) {
    if (text.length + char.length > max) break;
    text += char;
  }
  return text;
}

/** The participant of an event. A test has no viewer, and a direct event has no participant of a platform. */
function subjectOf(event: ActivitySupport, origin: AlertOrigin): AlertSubject | null {
  if (origin === "test" || event.platform === "direct" || event.anonymous || event.sender === null) return null;
  return { platform: event.platform, userId: event.sender.id };
}

/**
 * The alert of a support event, or null when the event makes none: its kind has no rule, the amount of a live event
 * is below the amount of the rule, or the rule has its three switches off. A replay and a test ignore the amount of
 * the rule: the owner asked for them. `play` is the number of a replay, so each replay has its own ID.
 */
export function alertFor(
  event: ActivitySupport,
  rules: Readonly<AlertRules>,
  origin: AlertOrigin = "live",
  play: number = 0,
): PendingAlert | null {
  if (!isAlertKind(event.kind)) return null;
  const id: AlertRuleId = KIND_RULES[event.kind];
  const rule: AlertRule = rules[id];
  if (origin === "live" && hasThreshold(id) && (event.amount ?? 0) < rule.min) return null;
  if (!rule.banner && !rule.chat && !rule.character) return null;
  const text: string = cut(event.text ?? "", ALERT_TEXT_LENGTH);
  return {
    view: {
      id: origin === "replay" ? `${event.id}~r${play}` : event.id,
      origin,
      kind: event.kind,
      platform: event.platform,
      // A platform can give an empty name: then the view has none.
      name: event.anonymous ? null : event.sender?.displayName || null,
      anonymous: event.anonymous,
      amount: event.amount,
      currency: event.currency,
      ...(text ? { text } : {}),
      banner: rule.banner,
      chat: rule.chat,
    },
    subject: subjectOf(event, origin),
    action: rule.character ? RULE_ACTIONS[id] : null,
  };
}

/**
 * True when an output that shows only `platform` shows the alert. Null is an output for all platforms. A topic
 * credit is content of StreamBullets, so each output shows it.
 */
export function alertShownOn(alert: Pick<AlertView, "kind" | "platform">, platform: ActivityPlatform | null): boolean {
  return platform === null || alert.platform === platform || alert.kind === "topic";
}

/** The alert on stream and the alerts that wait, the oldest first. Only an alert with a banner is in the line. */
export interface AlertLine {
  current: AlertView | null;
  waiting: readonly PendingAlert[];
}

/** The line with no alert. Mute puts the line in this state. */
export const EMPTY_LINE: AlertLine = { current: null, waiting: [] };

/** The line after a step, and the alert that started with the step: the server sends it and moves its character. */
export interface LineStep {
  line: AlertLine;
  started: StartedAlert | null;
}

/**
 * The line at the server time `now`. While the alert on stream has time left, nothing changes. Else the oldest
 * alert that waits starts, or the line is empty.
 */
export function lineAdvance(line: AlertLine, now: number): LineStep {
  if (line.current !== null && now < line.current.endsAt) return { line, started: null };
  const [next, ...waiting] = line.waiting;
  if (next === undefined) return { line: line.current === null ? line : EMPTY_LINE, started: null };
  const view: AlertView = { ...next.view, startsAt: now, endsAt: now + ALERT_SHOW_MS };
  return { line: { current: view, waiting }, started: { ...next, view } };
}

/**
 * The line after a new alert at the server time `now`. An alert without a banner starts at once and is not in the
 * line. An alert with a banner starts when no alert is on stream, else it waits. While an alert is on stream and
 * `queueMax` alerts wait, the line drops a new alert.
 */
export function lineAdd(
  line: AlertLine,
  alert: PendingAlert,
  now: number,
  queueMax: number | null = ALERT_QUEUE_MAX,
): LineStep {
  if (!alert.view.banner) return { line, started: { ...alert, view: { ...alert.view, startsAt: now, endsAt: now } } };
  const busy: boolean = line.current !== null && now < line.current.endsAt;
  if (busy && queueMax !== null && line.waiting.length >= queueMax) return { line, started: null };
  return lineAdvance({ current: line.current, waiting: [...line.waiting, alert] }, now);
}

/** The line after Skip: the alert on stream ends now, and the next alert starts. */
export function lineSkip(line: AlertLine, now: number): LineStep {
  return lineAdvance({ current: null, waiting: line.waiting }, now);
}

/** The state of the alerts of a page, as the owner controls and the overlay pages read it. */
export interface AlertsState {
  /** The owner muted the alerts: no alert starts. */
  muted: boolean;
  /** The alert on stream, or null. */
  current: AlertView | null;
  /** The number of alerts that wait in the line. */
  waiting: number;
  /** The count of the goal, or null when the page counts no goal. */
  goal: GoalProgress | null;
}

/**
 * The alert messages of the activity socket. `alerts` is the whole state at the server time `at`: the server sends
 * it when a socket opens and after each change. `alert` is one alert without a banner, which plays at once.
 */
export type AlertsMessage = ({ type: "alerts"; at: number } & AlertsState) | { type: "alert"; alert: AlertView };

export const alertsMessageSchema: z.ZodType<AlertsMessage> = z.union([
  z.object({
    type: z.literal("alerts"),
    at: time,
    muted: z.boolean(),
    current: alertViewSchema.nullable(),
    waiting: z.number().int().nonnegative(),
    goal: goalProgressSchema.nullable(),
  }),
  z.object({ type: z.literal("alert"), alert: alertViewSchema }),
]);

/** The test alerts that the owner can send, in the sequence of the editor. `anonymous` is an anonymous gift. */
export const TEST_ALERTS = [
  "follow",
  "subscription",
  "gift",
  "bits",
  "super_chat",
  "raid",
  "topic",
  "anonymous",
] as const;
export type TestAlert = (typeof TEST_ALERTS)[number];
/** The test alert that the editor selects first. */
export const DEFAULT_TEST_ALERT: TestAlert = "gift";

interface TestSample {
  kind: AlertKind;
  platform: SupportSource;
  /** Null: an anonymous event. */
  name: string | null;
  amount?: number;
  currency?: string;
  text?: string;
}

const TEST_SAMPLES: Readonly<Record<TestAlert, TestSample>> = {
  follow: { kind: "follow", platform: "twitch", name: "RustBucket" },
  subscription: { kind: "subscription", platform: "twitch", name: "scav_kid", amount: 1 },
  gift: { kind: "gift", platform: "twitch", name: "Mad Maxine", amount: 5 },
  bits: { kind: "bits", platform: "twitch", name: "dune_runner", amount: 500, text: "Keep the lights on!" },
  super_chat: {
    kind: "super_chat",
    platform: "youtube",
    name: "Ngozi Okafor",
    amount: 5_000_000,
    currency: "USD",
    text: "Greetings from Lagos 👋🏾",
  },
  raid: { kind: "raid", platform: "twitch", name: "Long Haul Trucker", amount: 38 },
  topic: { kind: "topic", platform: "direct", name: "Zoë_Ünter", text: "Which boss first?" },
  anonymous: { kind: "gift", platform: "twitch", name: null, amount: 5 },
};

/**
 * The sample support event of a test alert. `play` is the number of the test, so each test has its own ID. The
 * event is only the source of the alert (`alertFor` with the origin `test`): the server never sends it or stores it.
 * It has the replay mark, so it never counts.
 */
export function testSupport(test: TestAlert, play: number, now: number): ActivitySupport {
  const sample: TestSample = TEST_SAMPLES[test];
  const deliveryId = `test-${play}`;
  return {
    kind: sample.kind,
    id: `${sample.platform}:${deliveryId}`,
    platform: sample.platform,
    deliveryId,
    sender: sample.name === null ? null : { id: `test-${test}`, displayName: sample.name },
    anonymous: sample.name === null,
    amount: sample.amount ?? null,
    currency: sample.currency ?? null,
    ...(sample.text ? { text: sample.text } : {}),
    receivedAt: now,
    replay: true,
  };
}
