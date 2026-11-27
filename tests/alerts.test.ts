import { describe, expect, it } from "vitest";
import {
  activityEventSchema,
  messageForPlatform,
  parseActivityMessage,
  supportTotals,
  type ActivityMessage,
  type ActivitySupport,
  type SupportKind,
  type SupportSource,
} from "../app/lib/activity";
import {
  ALERT_ACTIONS,
  ALERT_KINDS,
  ALERT_MIN,
  ALERT_ORIGINS,
  ALERT_QUEUE_MAX,
  ALERT_RULES,
  ALERT_SHOW_MS,
  ALERT_TEXT_LENGTH,
  DEFAULT_RULES,
  DEFAULT_TEST_ALERT,
  DEFAULT_THRESHOLDS,
  EMPTY_LINE,
  KIND_RULES,
  RULE_ACTIONS,
  TEST_ALERTS,
  THRESHOLD_RULES,
  alertFor,
  alertShownOn,
  alertViewSchema,
  hasThreshold,
  lineAdd,
  lineAdvance,
  lineSkip,
  pendingAlertSchema,
  testSupport,
  type AlertLine,
  type AlertRule,
  type AlertRuleId,
  type AlertRules,
  type AlertView,
  type LineStep,
  type PendingAlert,
} from "../app/lib/alerts";
import { goalAmount } from "../app/lib/goals";

// Alerts on stream: the rules, what a client gets, and the line. Pure rules, with no server.

const DIRECT: ReadonlySet<SupportKind> = new Set<SupportKind>(["tip", "topic"]);
const MONEY: ReadonlySet<SupportKind> = new Set<SupportKind>(["super_chat", "super_sticker", "tip"]);

/** A valid event of `kind`. */
function support(kind: SupportKind, change: Partial<ActivitySupport> = {}): ActivitySupport {
  const platform: SupportSource = change.platform ?? (DIRECT.has(kind) ? "direct" : "twitch");
  const deliveryId: string = change.deliveryId ?? `d-${kind}`;
  return {
    kind,
    id: `${platform}:${deliveryId}`,
    platform,
    deliveryId,
    sender: { id: "u1", displayName: "Tess" },
    anonymous: false,
    amount: kind === "follow" || kind === "topic" ? null : 500,
    currency: MONEY.has(kind) ? "EUR" : null,
    receivedAt: 1000,
    replay: false,
    ...change,
  };
}

/** The default rules with one rule changed. */
function rulesWith(id: AlertRuleId, change: Partial<AlertRule>): AlertRules {
  return { ...DEFAULT_RULES, [id]: { ...DEFAULT_RULES[id], ...change } };
}

/** An alert with a banner, for the line. */
function banner(deliveryId: string): PendingAlert {
  const alert: PendingAlert | null = alertFor(support("bits", { deliveryId }), DEFAULT_RULES);
  if (alert === null) throw new Error("The default rules make an alert for 500 Bits.");
  return alert;
}

const allOff: Partial<AlertRule> = { banner: false, chat: false, character: false };

describe("the working defaults", (): void => {
  it("shows one alert for 6 seconds, with no limit for the line", (): void => {
    expect(ALERT_SHOW_MS).toBe(6000);
    expect(ALERT_QUEUE_MAX).toBeNull();
    expect(ALERT_TEXT_LENGTH).toBe(200);
  });

  it("has the seven rules of the design, with a banner for each rule but a follow", (): void => {
    expect(ALERT_RULES).toEqual(["follow", "subscription", "gift", "bits", "paid", "raid", "topic"]);
    const on = { banner: true, chat: true, character: true };
    expect(DEFAULT_RULES).toEqual({
      follow: { min: 1, banner: false, chat: true, character: true },
      subscription: { min: 1, ...on },
      gift: { min: 1, ...on },
      bits: { min: 100, ...on },
      paid: { min: 1, ...on },
      raid: { min: 5, ...on },
      topic: { min: 1, ...on },
    });
  });

  it("starts at 100 Bits or KICKs and at a raid of 5 viewers, and at each other event", (): void => {
    expect(THRESHOLD_RULES).toEqual(["gift", "bits", "raid"]);
    expect(DEFAULT_THRESHOLDS).toEqual({ gift: 1, bits: 100, raid: 5 });
    expect(ALERT_MIN).toEqual({ min: 1, max: 1_000_000 });
    expect(ALERT_RULES.filter(hasThreshold)).toEqual(["gift", "bits", "raid"]);
    for (const rule of ALERT_RULES)
      expect(DEFAULT_RULES[rule].min, rule).toBe(hasThreshold(rule) ? DEFAULT_THRESHOLDS[rule] : 1);
  });

  it("gives each kind with a rule its rule, and each rule its character action", (): void => {
    expect(KIND_RULES).toEqual({
      follow: "follow",
      subscription: "subscription",
      membership: "subscription",
      gift: "gift",
      raid: "raid",
      bits: "bits",
      kicks: "bits",
      super_chat: "paid",
      super_sticker: "paid",
      topic: "topic",
    });
    expect(Object.keys(KIND_RULES).sort()).toEqual([...ALERT_KINDS].sort());
    expect(new Set(Object.values(KIND_RULES))).toEqual(new Set(ALERT_RULES));
    expect(ALERT_ACTIONS).toEqual(["wave", "jump", "crowd"]);
    expect(RULE_ACTIONS).toEqual({
      follow: "wave",
      subscription: "jump",
      gift: "jump",
      bits: "jump",
      paid: "jump",
      raid: "crowd",
      topic: "wave",
    });
    expect(ALERT_ORIGINS).toEqual(["live", "replay", "test"]);
  });
});

describe("the alert of a support event", (): void => {
  it("makes the view of an event, with the switches of its rule", (): void => {
    const event: ActivitySupport = support("bits", { deliveryId: "b1", amount: 250, text: "gg" });
    expect(alertFor(event, DEFAULT_RULES)).toEqual({
      view: {
        id: "twitch:b1",
        origin: "live",
        kind: "bits",
        platform: "twitch",
        name: "Tess",
        anonymous: false,
        amount: 250,
        currency: null,
        text: "gg",
        banner: true,
        chat: true,
      },
      subject: { platform: "twitch", userId: "u1" },
      action: "jump",
    });
    // A follow has no banner by default. It has no amount and no text.
    const follow: PendingAlert | null = alertFor(support("follow"), DEFAULT_RULES);
    expect(follow?.view).toMatchObject({ kind: "follow", amount: null, banner: false, chat: true });
    expect(follow?.view).not.toHaveProperty("text");
    expect(follow?.action).toBe("wave");
    // Money keeps its micros and its currency.
    expect(
      alertFor(support("super_chat", { platform: "youtube", amount: 5_000_000 }), DEFAULT_RULES)?.view,
    ).toMatchObject({ kind: "super_chat", platform: "youtube", amount: 5_000_000, currency: "EUR" });
  });

  it("uses one rule for a subscription and a membership, and one for a Super Chat and a Super Sticker", (): void => {
    const quiet: AlertRules = { ...rulesWith("subscription", allOff), paid: { ...DEFAULT_RULES.paid, ...allOff } };
    for (const kind of ["subscription", "membership", "super_chat", "super_sticker"] as const)
      expect(alertFor(support(kind), quiet), kind).toBeNull();
    expect(alertFor(support("gift"), quiet)).not.toBeNull();
    expect(alertFor(support("membership", { platform: "youtube" }), DEFAULT_RULES)?.action).toBe("jump");
  });

  it("starts at 100 Bits: 99 make no alert, and 100 make one", (): void => {
    expect(alertFor(support("bits", { amount: 99 }), DEFAULT_RULES)).toBeNull();
    expect(alertFor(support("bits", { amount: 100 }), DEFAULT_RULES)?.view.amount).toBe(100);
  });

  it("starts at 100 KICKs: 99 make no alert, and 100 make one", (): void => {
    expect(alertFor(support("kicks", { platform: "kick", amount: 99 }), DEFAULT_RULES)).toBeNull();
    expect(alertFor(support("kicks", { platform: "kick", amount: 100 }), DEFAULT_RULES)?.view.kind).toBe("kicks");
  });

  it("starts at a raid of 5 viewers: 4 make no alert, and 5 make one for all characters", (): void => {
    expect(alertFor(support("raid", { amount: 4 }), DEFAULT_RULES)).toBeNull();
    const raid: PendingAlert | null = alertFor(support("raid", { amount: 5 }), DEFAULT_RULES);
    expect(raid?.view.amount).toBe(5);
    expect(raid?.action).toBe("crowd");
  });

  it("makes an alert for each gift bundle by default, and from the amount that the owner sets", (): void => {
    expect(alertFor(support("gift", { amount: 1 }), DEFAULT_RULES)).not.toBeNull();
    const five: AlertRules = rulesWith("gift", { min: 5 });
    expect(alertFor(support("gift", { amount: 4 }), five)).toBeNull();
    expect(alertFor(support("gift", { amount: 5 }), five)).not.toBeNull();
    const many: AlertRules = rulesWith("bits", { min: 1000 });
    expect(alertFor(support("bits", { amount: 999 }), many)).toBeNull();
    expect(alertFor(support("kicks", { platform: "kick", amount: 999 }), many)).toBeNull();
    expect(alertFor(support("bits", { amount: 1000 }), many)).not.toBeNull();
    // An event of a rule with an amount, but without one, is not valid in the feed. It makes no alert.
    expect(alertFor(support("raid", { amount: null }), DEFAULT_RULES)).toBeNull();
  });

  it("makes an alert for each event of a rule without an amount", (): void => {
    // The amount of a rule without one does nothing: a subscription of one month and a small Super Chat alert.
    const rules: AlertRules = { ...rulesWith("subscription", { min: 50 }), paid: { ...DEFAULT_RULES.paid, min: 50 } };
    expect(alertFor(support("subscription", { amount: 1 }), rules)).not.toBeNull();
    expect(alertFor(support("super_sticker", { platform: "youtube", amount: 1 }), rules)).not.toBeNull();
    expect(alertFor(support("follow"), rulesWith("follow", { min: 50 }))).not.toBeNull();
    expect(alertFor(support("topic"), rulesWith("topic", { min: 50 }))).not.toBeNull();
  });

  it("ignores the amount of the rule for a test and a replay", (): void => {
    const small: [ActivitySupport, AlertRules][] = [
      [support("bits", { amount: 1 }), DEFAULT_RULES],
      [support("kicks", { platform: "kick", amount: 99 }), DEFAULT_RULES],
      [support("raid", { amount: 4 }), DEFAULT_RULES],
      [support("gift", { amount: 2 }), rulesWith("gift", { min: 50 })],
    ];
    for (const [event, rules] of small) {
      expect(alertFor(event, rules, "live"), event.kind).toBeNull();
      expect(alertFor(event, rules, "test")?.view, event.kind).toMatchObject({ origin: "test", amount: event.amount });
      expect(alertFor(event, rules, "replay", 1)?.view, event.kind).toMatchObject({ origin: "replay" });
    }
  });

  it("makes no alert for a rule with its three switches off, also for a test and a replay", (): void => {
    const off: AlertRules = rulesWith("bits", allOff);
    for (const origin of ALERT_ORIGINS) expect(alertFor(support("bits"), off, origin), origin).toBeNull();
    // One switch is enough.
    for (const one of ["banner", "chat", "character"] as const) {
      const alert: PendingAlert | null = alertFor(support("bits"), rulesWith("bits", { ...allOff, [one]: true }));
      expect(alert?.view.banner, one).toBe(one === "banner");
      expect(alert?.view.chat, one).toBe(one === "chat");
      expect(alert?.action, one).toBe(one === "character" ? "jump" : null);
    }
  });

  it("makes no alert for a direct tip and for reactions: they have no rule", (): void => {
    expect(ALERT_KINDS).not.toContain("tip");
    expect(ALERT_KINDS).not.toContain("reactions");
    for (const origin of ALERT_ORIGINS) {
      expect(alertFor(support("tip"), DEFAULT_RULES, origin)).toBeNull();
      expect(alertFor(support("reactions"), DEFAULT_RULES, origin)).toBeNull();
    }
  });

  it("gives each play its own ID: the event ID, and the number of a replay", (): void => {
    const event: ActivitySupport = support("gift", { deliveryId: "g1" });
    expect(alertFor(event, DEFAULT_RULES)?.view.id).toBe("twitch:g1");
    expect(alertFor(event, DEFAULT_RULES, "replay", 1)?.view.id).toBe("twitch:g1~r1");
    expect(alertFor(event, DEFAULT_RULES, "replay", 2)?.view.id).toBe("twitch:g1~r2");
    expect(alertFor(event, DEFAULT_RULES, "replay")?.view.id).toBe("twitch:g1~r0");
    expect(alertFor(event, DEFAULT_RULES, "test")?.view.id).toBe("twitch:g1");
  });

  it("cuts the text of the supporter to 200 characters, and never in the middle of a character", (): void => {
    const long: PendingAlert | null = alertFor(support("bits", { text: "x".repeat(500) }), DEFAULT_RULES);
    expect(long?.view.text).toBe("x".repeat(200));
    // An emoji is two code units: 100 of them fill the text.
    const emoji: PendingAlert | null = alertFor(support("bits", { text: `x${"🔥".repeat(150)}` }), DEFAULT_RULES);
    expect(emoji?.view.text).toBe(`x${"🔥".repeat(99)}`);
    expect(emoji && alertViewSchema.safeParse({ ...emoji.view, startsAt: 1, endsAt: 2 }).success).toBe(true);
    expect(alertFor(support("bits", { text: "" }), DEFAULT_RULES)?.view).not.toHaveProperty("text");
  });
});

describe("an anonymous alert", (): void => {
  const gift: ActivitySupport = support("gift", { anonymous: true, sender: null, amount: 5 });

  it("has no name and no participant, live and in a replay", (): void => {
    for (const origin of ALERT_ORIGINS) {
      const alert: PendingAlert | null = alertFor(gift, DEFAULT_RULES, origin, 3);
      expect(alert?.view, origin).toMatchObject({ anonymous: true, name: null, amount: 5 });
      expect(alert?.subject, origin).toBeNull();
      // The rule still has its action: without a participant, the server makes all characters cheer.
      expect(alert?.action, origin).toBe("jump");
      expect(JSON.stringify(alert), origin).not.toContain("Tess");
    }
  });

  it("never takes a name from an event that says anonymous and still has a sender", (): void => {
    // Such an event is not valid in the feed. The alert still has no name and no participant.
    const wrong: ActivitySupport = { ...gift, sender: { id: "u9", displayName: "Tess" } };
    expect(activityEventSchema.safeParse(wrong).success).toBe(false);
    const alert: PendingAlert | null = alertFor(wrong, DEFAULT_RULES);
    expect(alert?.view.name).toBeNull();
    expect(alert?.subject).toBeNull();
    expect(JSON.stringify(alert)).not.toContain("u9");
  });

  it("has no name when the platform gives none, and that is not anonymous", (): void => {
    const unnamed: PendingAlert | null = alertFor(support("raid", { sender: null }), DEFAULT_RULES);
    expect(unnamed?.view).toMatchObject({ anonymous: false, name: null });
    expect(unnamed?.subject).toBeNull();
    // Twitch can give a user without a name: the participant stays.
    const empty: PendingAlert | null = alertFor(
      support("bits", { sender: { id: "u2", displayName: "" } }),
      DEFAULT_RULES,
    );
    expect(empty?.view.name).toBeNull();
    expect(empty?.subject).toEqual({ platform: "twitch", userId: "u2" });
  });

  it("is refused by the parser with a name", (): void => {
    const view: AlertView = { ...banner("b1").view, startsAt: 1000, endsAt: 7000 };
    expect(alertViewSchema.safeParse({ ...view, anonymous: true, name: null }).success).toBe(true);
    expect(alertViewSchema.safeParse({ ...view, anonymous: true, name: "Tess" }).success).toBe(false);
    expect(alertViewSchema.safeParse({ ...view, anonymous: true, name: "" }).success).toBe(false);
    // In the line: an anonymous alert has no name and no participant.
    const pending: PendingAlert = banner("b1");
    expect(pendingAlertSchema.safeParse(pending).success).toBe(true);
    expect(pendingAlertSchema.safeParse({ ...pending, view: { ...pending.view, anonymous: true } }).success).toBe(
      false,
    );
    expect(
      pendingAlertSchema.safeParse({ ...pending, view: { ...pending.view, anonymous: true, name: null } }).success,
    ).toBe(false);
    expect(
      pendingAlertSchema.safeParse({
        ...pending,
        subject: null,
        view: { ...pending.view, anonymous: true, name: null },
      }).success,
    ).toBe(true);
  });
});

describe("what a client gets", (): void => {
  const view: AlertView = { ...banner("b1").view, startsAt: 1000, endsAt: 7000 };

  it("reads a view and drops each field that is not a field of a view", (): void => {
    expect(alertViewSchema.parse(view)).toEqual(view);
    const more = { ...view, userId: "u1", sender: { id: "u1" }, subject: { platform: "twitch", userId: "u1" } };
    expect(alertViewSchema.parse(more)).toEqual(view);
    expect(JSON.stringify(alertViewSchema.parse(more))).not.toContain("u1");
  });

  it("refuses a view that is not correct", (): void => {
    const wrong: [string, unknown][] = [
      ["a kind without a rule", { ...view, kind: "tip" }],
      ["an unknown origin", { ...view, origin: "retry" }],
      ["an unknown platform", { ...view, platform: "vimeo" }],
      ["a direct alert that is no topic credit", { ...view, platform: "direct" }],
      ["a topic credit of a platform", { ...view, kind: "topic" }],
      ["a text that is too long", { ...view, text: "x".repeat(201) }],
      ["a name that is too long", { ...view, name: "x".repeat(101) }],
      ["an amount of zero", { ...view, amount: 0 }],
      ["a currency that is not a code", { ...view, currency: "eur" }],
      ["an end before the start", { ...view, endsAt: 999 }],
      ["no times", { ...view, startsAt: undefined }],
      ["no ID", { ...view, id: "" }],
      ["no switch", { ...view, banner: undefined }],
    ];
    for (const [name, value] of wrong) expect(alertViewSchema.safeParse(value).success, name).toBe(false);
    expect(alertViewSchema.safeParse({ ...view, kind: "topic", platform: "direct", amount: null }).success).toBe(true);
    // An alert without a banner has equal times.
    expect(alertViewSchema.safeParse({ ...view, banner: false, endsAt: 1000 }).success).toBe(true);
  });

  it("has the state of the alerts and the goal as one message of the activity socket", (): void => {
    const state: ActivityMessage = {
      type: "alerts",
      at: 2000,
      muted: false,
      current: view,
      waiting: 2,
      goal: { counts: "subs", value: 17, startedAt: 500 },
    };
    expect(parseActivityMessage(JSON.stringify(state))).toEqual(state);
    const idle: ActivityMessage = { type: "alerts", at: 2000, muted: true, current: null, waiting: 0, goal: null };
    expect(parseActivityMessage(JSON.stringify(idle))).toEqual(idle);
    const one: ActivityMessage = { type: "alert", alert: { ...view, banner: false, endsAt: 1000 } };
    expect(parseActivityMessage(JSON.stringify(one))).toEqual(one);
    // A field that is not a field of the message never reaches the page.
    const leak = { ...state, current: { ...view, userId: "u1" }, line: [{ subject: { userId: "u1" } }] };
    expect(parseActivityMessage(JSON.stringify(leak))).toEqual(state);
  });

  it("ignores an alert message that is not correct", (): void => {
    const state = { type: "alerts", at: 2000, muted: false, current: view, waiting: 0, goal: null };
    for (const wrong of [
      { ...state, muted: "no" },
      { ...state, waiting: -1 },
      { ...state, at: undefined },
      { ...state, current: { ...view, anonymous: true } },
      { ...state, goal: { counts: "likes", value: 1, startedAt: 0 } },
      { type: "alert", alert: { ...view, kind: "tip" } },
      { type: "alert" },
    ])
      expect(parseActivityMessage(JSON.stringify(wrong)), JSON.stringify(wrong)).toBeNull();
  });

  it("keeps an alert message for an output of one platform: the page selects the alerts", (): void => {
    const one: ActivityMessage = { type: "alert", alert: view };
    expect(messageForPlatform(one, "kick")).toBe(one);
    const state: ActivityMessage = { type: "alerts", at: 1, muted: false, current: view, waiting: 0, goal: null };
    expect(messageForPlatform(state, "twitch")).toBe(state);
  });
});

describe("an output that shows one platform", (): void => {
  const twitch: AlertView = { ...banner("b1").view, startsAt: 0, endsAt: 1 };

  it("shows the alerts of that platform and each topic credit, and no other alert", (): void => {
    const youtube: AlertView = { ...twitch, kind: "super_chat", platform: "youtube" };
    const credit: AlertView = { ...twitch, kind: "topic", platform: "direct", amount: null };
    // An output for all platforms.
    for (const alert of [twitch, youtube, credit]) expect(alertShownOn(alert, null)).toBe(true);
    expect(alertShownOn(twitch, "twitch")).toBe(true);
    expect(alertShownOn(youtube, "twitch")).toBe(false);
    expect(alertShownOn(youtube, "youtube")).toBe(true);
    expect(alertShownOn(twitch, "kick")).toBe(false);
    // A topic credit is content of StreamBullets.
    for (const platform of ["twitch", "youtube", "kick"] as const) expect(alertShownOn(credit, platform)).toBe(true);
  });
});

describe("the line of alerts", (): void => {
  const first: PendingAlert = banner("b1");
  const second: PendingAlert = banner("b2");
  const third: PendingAlert = banner("b3");
  const ids = (line: AlertLine): (string | null)[] => [
    line.current?.id ?? null,
    ...line.waiting.map((alert: PendingAlert): string => alert.view.id),
  ];

  it("starts with no alert", (): void => {
    expect(EMPTY_LINE).toEqual({ current: null, waiting: [] });
    expect(lineAdvance(EMPTY_LINE, 1000)).toEqual({ line: EMPTY_LINE, started: null });
    expect(lineSkip(EMPTY_LINE, 1000)).toEqual({ line: EMPTY_LINE, started: null });
  });

  it("starts an alert at once when no alert is on stream, for 6 seconds", (): void => {
    const step: LineStep = lineAdd(EMPTY_LINE, first, 1000);
    expect(step.line.current).toEqual({ ...first.view, startsAt: 1000, endsAt: 7000 });
    expect(step.line.waiting).toEqual([]);
    expect(step.started).toEqual({ ...first, view: step.line.current });
    expect(alertViewSchema.safeParse(step.line.current).success).toBe(true);
    expect(EMPTY_LINE).toEqual({ current: null, waiting: [] });
  });

  it("shows one alert at a time: the next alerts wait, the oldest first", (): void => {
    const one: AlertLine = lineAdd(EMPTY_LINE, first, 1000).line;
    const two: LineStep = lineAdd(one, second, 2000);
    expect(two.started).toBeNull();
    expect(ids(two.line)).toEqual(["twitch:b1", "twitch:b2"]);
    const three: LineStep = lineAdd(two.line, third, 3000);
    expect(three.started).toBeNull();
    expect(ids(three.line)).toEqual(["twitch:b1", "twitch:b2", "twitch:b3"]);
    expect(three.line.current?.endsAt).toBe(7000);
    // The line has no limit by default.
    let long: AlertLine = three.line;
    for (let index = 0; index < 500; index += 1) long = lineAdd(long, banner(`more-${index}`), 3000).line;
    expect(long.waiting).toHaveLength(502);
  });

  it("starts the next alert when the time of the alert on stream is over", (): void => {
    let line: AlertLine = lineAdd(EMPTY_LINE, first, 1000).line;
    line = lineAdd(line, second, 2000).line;
    // Before the end, nothing changes: the same line, so there is nothing to store.
    const early: LineStep = lineAdvance(line, 6999);
    expect(early).toEqual({ line, started: null });
    expect(early.line).toBe(line);
    const next: LineStep = lineAdvance(line, 7000);
    expect(next.line.current).toEqual({ ...second.view, startsAt: 7000, endsAt: 13_000 });
    expect(next.started?.view.id).toBe("twitch:b2");
    expect(next.started?.subject).toEqual({ platform: "twitch", userId: "u1" });
    expect(next.line.waiting).toEqual([]);
    // The last alert ends, and the line is empty.
    expect(lineAdvance(next.line, 12_999).line).toBe(next.line);
    expect(lineAdvance(next.line, 13_000)).toEqual({ line: EMPTY_LINE, started: null });
  });

  it("starts each alert at the time of the step, also after a late alarm", (): void => {
    let line: AlertLine = lineAdd(EMPTY_LINE, first, 1000).line;
    line = lineAdd(line, second, 2000).line;
    line = lineAdd(line, third, 3000).line;
    // The alarm comes 20 seconds late: the second alert still shows for 6 seconds.
    const late: LineStep = lineAdvance(line, 27_000);
    expect(late.line.current).toMatchObject({ id: "twitch:b2", startsAt: 27_000, endsAt: 33_000 });
    expect(ids(late.line)).toEqual(["twitch:b2", "twitch:b3"]);
    // A new alert after the time of the alert on stream: the oldest alert that waits starts, and the new one waits.
    const added: LineStep = lineAdd(line, banner("b4"), 27_000);
    expect(added.started?.view.id).toBe("twitch:b2");
    expect(ids(added.line)).toEqual(["twitch:b2", "twitch:b3", "twitch:b4"]);
    // With no alert that waits, the new alert starts.
    const alone: AlertLine = lineAdd(EMPTY_LINE, first, 1000).line;
    const after: LineStep = lineAdd(alone, second, 9000);
    expect(after.started?.view).toMatchObject({ id: "twitch:b2", startsAt: 9000, endsAt: 15_000 });
    expect(ids(after.line)).toEqual(["twitch:b2"]);
  });

  it("ends the alert on stream at Skip and starts the next alert", (): void => {
    let line: AlertLine = lineAdd(EMPTY_LINE, first, 1000).line;
    line = lineAdd(line, second, 2000).line;
    const skipped: LineStep = lineSkip(line, 2500);
    expect(skipped.started?.view).toMatchObject({ id: "twitch:b2", startsAt: 2500, endsAt: 8500 });
    expect(ids(skipped.line)).toEqual(["twitch:b2"]);
    // Skip of the last alert leaves no alert.
    expect(lineSkip(skipped.line, 3000)).toEqual({ line: EMPTY_LINE, started: null });
  });

  it("plays an alert without a banner at once, and leaves the line as it is", (): void => {
    const follow: PendingAlert | null = alertFor(support("follow", { deliveryId: "f1" }), DEFAULT_RULES);
    if (follow === null) throw new Error("The default rules make an alert for a follow.");
    const line: AlertLine = lineAdd(lineAdd(EMPTY_LINE, first, 1000).line, second, 2000).line;
    const step: LineStep = lineAdd(line, follow, 3000);
    expect(step.line).toBe(line);
    expect(step.started).toEqual({ ...follow, view: { ...follow.view, startsAt: 3000, endsAt: 3000 } });
    expect(alertViewSchema.safeParse(step.started?.view).success).toBe(true);
    expect(lineAdd(EMPTY_LINE, follow, 3000).line).toBe(EMPTY_LINE);
  });

  it("drops a new alert while the line is full, when the line has a limit", (): void => {
    let line: AlertLine = lineAdd(EMPTY_LINE, first, 1000, 1).line;
    line = lineAdd(line, second, 2000, 1).line;
    expect(ids(line)).toEqual(["twitch:b1", "twitch:b2"]);
    const full: LineStep = lineAdd(line, third, 3000, 1);
    expect(full).toEqual({ line, started: null });
    // After the time of the alert on stream, the oldest alert starts and the new alert takes its place in the line.
    const next: LineStep = lineAdd(line, third, 7000, 1);
    expect(next.started?.view.id).toBe("twitch:b2");
    expect(ids(next.line)).toEqual(["twitch:b2", "twitch:b3"]);
    // A limit of zero: only the alert on stream, and no alert waits.
    const only: AlertLine = lineAdd(EMPTY_LINE, first, 1000, 0).line;
    expect(ids(only)).toEqual(["twitch:b1"]);
    expect(lineAdd(only, second, 2000, 0)).toEqual({ line: only, started: null });
    expect(ids(lineAdd(only, second, 7000, 0).line)).toEqual(["twitch:b2"]);
  });
});

describe("the test alerts", (): void => {
  it("has the eight tests of the design, and selects the gift first", (): void => {
    expect(TEST_ALERTS).toEqual(["follow", "subscription", "gift", "bits", "super_chat", "raid", "topic", "anonymous"]);
    expect(DEFAULT_TEST_ALERT).toBe("gift");
  });

  it("makes a valid sample event for each test, with the replay mark and its own ID", (): void => {
    for (const test of TEST_ALERTS) {
      const event: ActivitySupport = testSupport(test, 4, 9000);
      expect(activityEventSchema.safeParse(event).success, test).toBe(true);
      expect(event, test).toMatchObject({ deliveryId: "test-4", receivedAt: 9000, replay: true });
      expect(testSupport(test, 5, 9000).id, test).not.toBe(event.id);
      // A test never counts for a goal, a report, or revenue.
      expect(supportTotals([event]), test).toEqual({ events: {}, amounts: {}, money: {} });
      expect(goalAmount("subs", event) + goalAmount("bits", event) + goalAmount("follows", event), test).toBe(0);
    }
    expect(testSupport("gift", 1, 0)).toMatchObject({ kind: "gift", platform: "twitch", amount: 5, anonymous: false });
    expect(testSupport("bits", 1, 0)).toMatchObject({ kind: "bits", amount: 500 });
    expect(testSupport("raid", 1, 0)).toMatchObject({ kind: "raid", amount: 38 });
    expect(testSupport("super_chat", 1, 0)).toMatchObject({ platform: "youtube", amount: 5_000_000, currency: "USD" });
    expect(testSupport("topic", 1, 0)).toMatchObject({ kind: "topic", platform: "direct", id: "direct:test-1" });
    expect(testSupport("follow", 1, 0)).not.toHaveProperty("text");
  });

  it("makes an alert for each test with the default rules, with no participant", (): void => {
    for (const test of TEST_ALERTS) {
      const alert: PendingAlert | null = alertFor(testSupport(test, 1, 9000), DEFAULT_RULES, "test");
      expect(alert?.view.origin, test).toBe("test");
      // A test has no viewer: the server makes all characters cheer.
      expect(alert?.subject, test).toBeNull();
      expect(pendingAlertSchema.safeParse(alert).success, test).toBe(true);
    }
  });

  it("plays a test below the amount of its rule", (): void => {
    const high: AlertRules = { ...rulesWith("raid", { min: 1000 }), bits: { ...DEFAULT_RULES.bits, min: 100_000 } };
    expect(alertFor(testSupport("raid", 1, 0), high, "test")?.view.amount).toBe(38);
    expect(alertFor(testSupport("bits", 1, 0), high, "test")?.view.amount).toBe(500);
    expect(alertFor({ ...testSupport("raid", 1, 0), replay: false }, high)).toBeNull();
  });

  it("has an anonymous gift with no name", (): void => {
    const event: ActivitySupport = testSupport("anonymous", 1, 0);
    expect(event).toMatchObject({ kind: "gift", anonymous: true, sender: null });
    expect(alertFor(event, DEFAULT_RULES, "test")?.view).toMatchObject({ anonymous: true, name: null, amount: 5 });
  });
});
