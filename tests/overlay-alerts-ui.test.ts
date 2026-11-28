import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALERT_ICONS,
  ALERT_LEAVE_MS,
  AlertBanner,
  AlertsLayer,
  alertWho,
  bannerAlert,
} from "../app/components/overlay/alerts-layer";
import { ChatLayer } from "../app/components/overlay/chat-layer";
import { GoalCard, GoalLayer } from "../app/components/overlay/goal-layer";
import {
  OverlayComposition,
  usesActivityFeed,
  usesAlerts,
  usesCharacters,
} from "../app/components/overlay/overlay-composition";
import type { OverlayScene } from "../app/components/overlay/overlay-stage";
import { DEFAULT_LOCALE, LOCALES, loadCatalog, setLocaleSource, type Locale } from "../app/i18n";
import { SAMPLE_ALERT, alertFace, type AlertFace } from "../app/lib/alert-feed";
import { ALERT_KINDS, ALERT_SHOW_MS, type AlertKind, type AlertView } from "../app/lib/alerts";
import { SAMPLE_CHAT, type AlertRow, type ChatRow } from "../app/lib/chat-feed";
import type { GoalProgress } from "../app/lib/goals";
import {
  DEFAULT_LAYERS,
  emptyCells,
  type LayerCells,
  type OverlayLayer,
  type OverlayLayers,
} from "../app/lib/overlay-layers";
import type { OverlayData, OverlayState } from "../app/types";

// The alerts layer, the mark of an alert in chat, and the goal layer on the overlay (issue #1043).

/** A text of a supporter. It must never be in the markup of the overlay. */
const SUPPORTER_TEXT = "Keep the lights on, everyone";

function view(override: Partial<AlertView> = {}): AlertView {
  return {
    id: "twitch:d1",
    origin: "live",
    kind: "gift",
    platform: "twitch",
    name: "LanternFox",
    anonymous: false,
    amount: 5,
    currency: null,
    text: SUPPORTER_TEXT,
    banner: true,
    chat: true,
    startsAt: 1000,
    endsAt: 1000 + ALERT_SHOW_MS,
    ...override,
  };
}

function face(override: Partial<AlertView> = {}): AlertFace {
  return alertFace(view(override));
}

function banner(alert: AlertFace, more: { showMs?: number; still?: boolean } = {}): string {
  return renderToStaticMarkup(createElement(AlertBanner, { alert, ...more }));
}

/** The visible text of markup. */
function textOf(html: string): string {
  let text: string = "";
  let inTag: boolean = false;
  for (const char of html) {
    if (char === "<") inTag = true;
    else if (char === ">") inTag = false;
    else if (!inTag) text += char;
  }
  return text.replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
}

afterEach((): void => {
  setLocaleSource((): Locale => DEFAULT_LOCALE);
});

describe("the banner of an alert", (): void => {
  it("tells who and what with the amount, and the platform", (): void => {
    const html: string = banner(face(), { showMs: ALERT_SHOW_MS });
    expect(html).toContain('<h1 data-alert-title="true"><bdi>LanternFox</bdi> gave 5 subscriptions</h1>');
    expect(html).toContain('<p class="ov-meta" data-alert-meta="true">Twitch · Thank you</p>');
    expect(html).toMatch(
      /^<article class="ov-card ov-alert" data-overlay-alert="gift" data-alert-origin="live" data-platform="twitch"/,
    );
    expect(html).toContain("icon-gift");
  });

  it("has a line and an icon for each kind of alert", (): void => {
    const lines: string[] = ALERT_KINDS.map((kind: AlertKind): string => {
      const direct: boolean = kind === "topic";
      const html: string = banner(
        face({ kind, platform: direct ? "direct" : "youtube", amount: direct || kind === "follow" ? null : 3 }),
      );
      expect(html).toContain(`icon-${ALERT_ICONS[kind]}`);
      return /<h1[^>]*>(.*)<\/h1>/.exec(html)?.[1] ?? "";
    });
    expect(new Set(lines).size).toBe(ALERT_KINDS.length);
    for (const line of lines) expect(textOf(line)).toMatch(/^LanternFox \S/);
  });

  it("shows the amount where the kind has one", (): void => {
    expect(textOf(banner(face({ kind: "bits", amount: 500 })))).toContain("LanternFox 500 Bits");
    expect(textOf(banner(face({ kind: "kicks", platform: "kick", amount: 100 })))).toContain("LanternFox 100 KICKs");
    expect(textOf(banner(face({ kind: "raid", amount: 38 })))).toContain("LanternFox raid with 38 viewers");
    expect(textOf(banner(face({ kind: "subscription", amount: 14 })))).toContain("subscribed for 14 months");
    expect(textOf(banner(face({ kind: "follow", amount: null })))).toContain("LanternFox followed");
    const paid: string = textOf(
      banner(face({ kind: "super_chat", platform: "youtube", amount: 5_000_000, currency: "USD" })),
    );
    expect(paid).toContain("LanternFox Super Chat: $5.00");
    expect(paid).toContain("YouTube · Thank you");
  });

  it("names no platform for a topic credit: it is not from a platform", (): void => {
    const html: string = banner(face({ kind: "topic", platform: "direct", amount: null, text: "Which boss first?" }));
    expect(html).toContain('<p class="ov-meta" data-alert-meta="true">Thank you</p>');
    expect(textOf(html)).toContain("LanternFox topic on stream");
    // The title of the topic is the text of the alert: it does not show.
    expect(html).not.toContain("Which boss first?");
  });

  it("never shows the text of the supporter", (): void => {
    for (const kind of ALERT_KINDS) {
      const direct: boolean = kind === "topic";
      const html: string = banner(face({ kind, platform: direct ? "direct" : "twitch" }), { showMs: 6000 });
      expect(html).not.toContain(SUPPORTER_TEXT);
    }
    // The face that the banner gets has no text at all.
    expect(face()).not.toHaveProperty("text");
  });

  it("shows the word for Anonymous and no name for an anonymous alert", (): void => {
    const html: string = banner(face({ anonymous: true, name: null }));
    expect(html).toContain("<bdi>Anonymous</bdi> gave 5 subscriptions");
    expect(alertWho({ anonymous: true, name: null })).toBe("Anonymous");
    // A name that a faulty producer sends with an anonymous alert is nowhere in the markup.
    const faulty: string = banner(alertFace(view({ anonymous: true, name: "LanternFox" })));
    expect(faulty).not.toContain("LanternFox");
    expect(faulty).toContain("<bdi>Anonymous</bdi>");
    // Also not in a face that did not go through alertFace.
    expect(banner({ ...face(), anonymous: true })).not.toContain("LanternFox");
    // A platform that gives no name: the same word.
    expect(banner(face({ name: null }))).toContain("<bdi>Anonymous</bdi>");
    expect(banner(face({ name: "" }))).toContain("<bdi>Anonymous</bdi>");
  });

  it("keeps a long name whole and a right-to-left name in its own direction", (): void => {
    const long: string = "W".repeat(100);
    expect(banner(face({ name: long }))).toContain(`<bdi>${long}</bdi>`);
    const arabic: string = "ليلى";
    expect(banner(face({ name: arabic }))).toContain(`<bdi>${arabic}</bdi> gave 5 subscriptions`);
    // A name is text, never markup.
    expect(banner(face({ name: "<img src=x>" }))).toContain("<bdi>&lt;img src=x&gt;</bdi>");
  });

  it("looks the same for a test and a replay as for a live alert, with a small TEST mark only on a test", (): void => {
    const live: string = banner(face());
    const replay: string = banner(face({ id: "twitch:d1~r1", origin: "replay" }));
    const test: string = banner(face({ origin: "test" }));
    const mark = '<span class="wl-test" data-alert-test="true">TEST</span>';
    expect(live).not.toContain("data-alert-test");
    expect(replay).not.toContain("data-alert-test");
    expect(replay.replace('data-alert-origin="replay"', 'data-alert-origin="live"')).toBe(live);
    expect(test).toContain(mark);
    expect(test.replace(mark, "").replace('data-alert-origin="test"', 'data-alert-origin="live"')).toBe(live);
  });

  it("fades before its end, and appears and goes with no transition with reduced motion", (): void => {
    const moving: string = banner(face(), { showMs: ALERT_SHOW_MS });
    expect(moving).toContain('data-leaves="true"');
    expect(moving).toContain(`style="--ov-alert-out:${ALERT_SHOW_MS - ALERT_LEAVE_MS}ms"`);
    expect(moving).not.toContain("data-still");
    // A page that connects in the last moment of an alert: the fade starts at once.
    expect(banner(face(), { showMs: 100 })).toContain('style="--ov-alert-out:0ms"');
    const still: string = banner(face(), { showMs: ALERT_SHOW_MS, still: true });
    expect(still).toContain('data-still="true"');
    expect(still).not.toContain("data-leaves");
    expect(still).not.toContain("--ov-alert-out");
    // The same content with and without motion.
    expect(textOf(still)).toBe(textOf(moving));
    // The style sheet takes each animation off a still banner.
    const css: string = readFileSync(
      new URL("../app/components/overlay/wasteland/wasteland.css", import.meta.url),
      "utf8",
    );
    expect(css).toMatch(/\.ov-alert\[data-still\] \{\s*animation: none;\s*\}/);
    // The fade of the style sheet has the length that the banner counts with.
    expect(css).toContain(`ov-alert-out ${ALERT_LEAVE_MS / 1000}s ease-in var(--ov-alert-out, 0s) forwards`);
  });

  it("has no end without a time: the sample of the editor", (): void => {
    const sample: string = banner(SAMPLE_ALERT, { still: true });
    expect(sample).not.toContain("data-leaves");
    expect(banner(SAMPLE_ALERT)).not.toContain("data-leaves");
    expect(sample).toContain("<bdi>Mad Maxine</bdi> gave 5 subscriptions");
  });

  it("has the texts in each language, with the plural form of the count", async (): Promise<void> => {
    await Promise.all(LOCALES.map((locale: Locale): Promise<void> => loadCatalog(locale)));
    const thanks = new Set<string>();
    for (const locale of LOCALES) {
      setLocaleSource((): Locale => locale);
      const html: string = banner(face({ anonymous: true, name: null, origin: "test" }));
      const meta: string = /data-alert-meta="true">([^<]*)</.exec(html)?.[1] ?? "";
      // The name of the platform is not translated.
      expect(meta.startsWith("Twitch · ")).toBe(true);
      thanks.add(meta);
      expect(textOf(html)).not.toContain("!");
      expect(alertWho({ anonymous: true, name: null })).not.toBe("");
    }
    expect(thanks.size).toBe(LOCALES.length);
    setLocaleSource((): Locale => "pl");
    expect(textOf(banner(face({ amount: 1 })))).toContain("LanternFox daruje 1 subskrypcję");
    expect(textOf(banner(face({ amount: 3 })))).toContain("LanternFox daruje 3 subskrypcje");
    expect(textOf(banner(face({ amount: 5 })))).toContain("LanternFox daruje 5 subskrypcji");
    expect(banner(face({ anonymous: true, name: null }))).toContain("<bdi>Anonim</bdi>");
    setLocaleSource((): Locale => "de");
    expect(textOf(banner(face({ anonymous: true, name: null })))).toContain("Anonym verschenkt 5 Abos");
    expect(textOf(banner(face()))).toContain("Twitch · Danke");
  });
});

describe("the alert that the banner of an output shows", (): void => {
  it("is the alert on stream when its rule has the banner on", (): void => {
    expect(bannerAlert(view(), null)).toEqual(face());
    expect(bannerAlert(null, null)).toBeNull();
    expect(bannerAlert(view({ banner: false }), null)).toBeNull();
  });

  it("has no text of the supporter", (): void => {
    expect(JSON.stringify(bannerAlert(view(), null))).not.toContain(SUPPORTER_TEXT);
  });
});

describe("the alerts layer", (): void => {
  const layer = (more: Partial<Parameters<typeof AlertsLayer>[0]> = {}): string =>
    renderToStaticMarkup(createElement(AlertsLayer, { feed: null, ...more }));

  it("is an empty cell between alerts", (): void => {
    expect(layer()).toBe('<div class="ov-fit"><div class="ov-stage" data-overlay-type="alerts"></div></div>');
  });

  it("shows a sample banner without motion and without an end in the editor preview", (): void => {
    const html: string = layer({ sample: true });
    expect(html).toContain('<div class="ov-fit"><div class="ov-stage" data-overlay-type="alerts"><article');
    expect(html).toContain("<bdi>Mad Maxine</bdi> gave 5 subscriptions");
    expect(html).toContain('data-still="true"');
    expect(html).not.toContain("data-leaves");
    expect(html).not.toContain("data-alert-test");
  });
});

describe("the mark of an alert in chat", (): void => {
  function row(alert: AlertFace, more: Partial<AlertRow> = {}): AlertRow {
    return {
      id: `alert:${alert.id}`,
      seq: 2,
      alert,
      receivedAt: 1000,
      shownAt: 1000,
      phase: "shown",
      phaseAt: 1000,
      animate: false,
      ...more,
    };
  }
  const message: ChatRow = {
    id: "twitch:m1",
    seq: 1,
    platform: "twitch",
    userId: "u1",
    name: "RustBucket",
    badges: [],
    fragments: [{ type: "text", text: "Grab a seat" }],
    truncated: false,
    receivedAt: 900,
    shownAt: 900,
    phase: "shown",
    phaseAt: 900,
    animate: false,
    command: false,
  };
  const chat = (rows: ChatRow[]): string =>
    renderToStaticMarkup(createElement(ChatLayer, { chat: { rows, epoch: 0, at: 1000 } }));

  it("is one highlight row in the list, with the information of the banner and no text of the supporter", (): void => {
    const html: string = chat([message, row(face(), { phase: "entering", animate: true })]);
    const items: string[] = html.match(/<li [^>]*>/g) ?? [];
    expect(items).toHaveLength(2);
    expect(items[1]).toBe(
      '<li class="wl-item" data-row-id="alert:twitch:d1" data-phase="entering" data-platform="twitch" ' +
        'data-alert="gift" data-enter="true" data-newest="true">',
    );
    expect(html).toContain(
      '<span class="wl-user"><bdi>LanternFox</bdi></span> <span class="wl-msg">gave 5 subscriptions</span>',
    );
    // The platform has its icon and its name for a screen reader, as a message has.
    expect(html.match(/<span class="sr-only">Twitch <\/span>/g)).toHaveLength(2);
    expect(html).not.toContain(SUPPORTER_TEXT);
    expect(html).not.toContain("data-alert-test");
  });

  it("shows the word for Anonymous and no name for an anonymous alert", (): void => {
    const html: string = chat([row(alertFace(view({ anonymous: true, name: null })))]);
    expect(html).toContain("<bdi>Anonymous</bdi>");
    expect(chat([row({ ...face(), anonymous: true })])).not.toContain("LanternFox");
  });

  it("has a heart for a topic credit, a small TEST mark for a test, and the whole of a long name", (): void => {
    const topic: string = chat([row(face({ id: "direct:t1", kind: "topic", platform: "direct", amount: null }))]);
    expect(topic).toContain("icon-heart");
    expect(topic).toContain('data-platform="direct"');
    expect(topic).toContain('<span class="wl-msg">topic on stream</span>');
    const test: string = chat([row(face({ origin: "test" }))]);
    expect(test).toContain('<span class="wl-mark-test" data-alert-test="true">TEST</span>');
    const long: string = "W".repeat(100);
    expect(chat([row(face({ name: long }))])).toContain(`<bdi>${long}</bdi>`);
  });

  it("fades with the other rows when it leaves", (): void => {
    expect(chat([row(face(), { phase: "leaving" })])).toContain('data-phase="leaving"');
    expect(chat([row(face(), { phase: "leaving" })])).not.toContain("data-newest");
  });
});

describe("the goal on stream", (): void => {
  const settings = { title: "New subscribers", counts: "subs", target: 25 } as const;
  const progress = (value: number): GoalProgress => ({ counts: "subs", value, startedAt: 0 });
  const card = (value: GoalProgress | null, goal: Parameters<typeof GoalCard>[0]["goal"] = settings): string =>
    renderToStaticMarkup(createElement(GoalCard, { goal, progress: value }));

  it("shows the title, 0 of the target, and an empty bar before any message", (): void => {
    const html: string = card(null);
    expect(textOf(html)).toBe("New subscribers · 0 of 25");
    expect(html).toContain('<bdi data-goal-title="true">New subscribers</bdi>');
    expect(html).toContain('<span class="ov-goal-count" data-goal-count="true">0 of 25</span>');
    expect(html).toContain(
      '<progress class="ov-goal-bar" value="0" max="25" aria-label="New subscribers" aria-valuetext="0 of 25">',
    );
    expect(html).not.toContain("data-goal-full");
  });

  it("shows 17 of 25 with a bar in the middle", (): void => {
    const html: string = card(progress(17));
    expect(textOf(html)).toBe("New subscribers · 17 of 25");
    expect(html).toContain('value="17" max="25" aria-label="New subscribers" aria-valuetext="17 of 25"');
    expect(html).not.toContain("data-goal-full");
  });

  it("shows the real number above the target, and never more than a full bar", (): void => {
    const html: string = card(progress(40));
    expect(textOf(html)).toBe("New subscribers · 40 of 25");
    expect(html).toContain('value="25" max="25" aria-label="New subscribers" aria-valuetext="40 of 25"');
    expect(html).toContain('data-goal-full="true"');
    expect(card(progress(25))).toContain('value="25" max="25"');
    expect(card(progress(25))).toContain('data-goal-full="true"');
  });

  it("shows the count and the bar only for a goal without a title", (): void => {
    const html: string = card(progress(3), { ...settings, title: "  " });
    expect(textOf(html)).toBe("3 of 25");
    expect(html).not.toContain("data-goal-title");
    expect(html).toContain('aria-label="Goal"');
  });

  it("keeps the title as text, and writes large numbers in the format of the language", async (): Promise<void> => {
    expect(card(null, { ...settings, title: "<b>Subs</b>" })).toContain("&lt;b&gt;Subs&lt;/b&gt;");
    const large = { ...settings, counts: "bits", target: 10_000 } as const;
    expect(textOf(card({ counts: "bits", value: 1500, startedAt: 0 }, large))).toBe(
      "New subscribers · 1,500 of 10,000",
    );
    await loadCatalog("de");
    setLocaleSource((): Locale => "de");
    expect(textOf(card({ counts: "bits", value: 1500, startedAt: 0 }, large))).toBe(
      "New subscribers · 1.500 von 10.000",
    );
  });

  it("starts at 0 while the count is of a different thing", (): void => {
    expect(textOf(card({ counts: "follows", value: 9, startedAt: 0 }))).toBe("New subscribers · 0 of 25");
  });

  it("shows on a page without a feed, in its cell", (): void => {
    const html: string = renderToStaticMarkup(createElement(GoalLayer, { feed: null, goal: settings }));
    expect(html).toMatch(
      /^<div class="ov-fit"><div class="ov-stage" data-overlay-type="goal"><article class="ov-card ov-goal"/,
    );
    expect(textOf(html)).toBe("New subscribers · 0 of 25");
  });
});

describe("the two layers in the composition", (): void => {
  const data: OverlayData = { polls: [], topics: [], cards: [], next: null, support: null };
  const state: OverlayState = {
    showResults: true,
    message: "",
    messageStyle: "info",
    layers: DEFAULT_LAYERS,
    chatTestUntil: 0,
    revision: 1,
  };
  const scene: OverlayScene = {
    name: "Host",
    handle: "host",
    host: "stream.example.test",
    origin: "https://stream.example.test",
    overlay: state,
    polls: [],
    data,
    now: 1000,
  };
  const horizontal: LayerCells = {
    ...emptyCells(),
    alerts: { c: 8, r: 0, w: 16, h: 3 },
    goal: { c: 24, r: 0, w: 8, h: 2 },
  };
  const vertical: LayerCells = {
    ...emptyCells(),
    alerts: { c: 0, r: 0, w: 18, h: 3 },
    goal: { c: 0, r: 3, w: 18, h: 2 },
  };
  const layers: OverlayLayers = {
    ...DEFAULT_LAYERS,
    alerts: { ...DEFAULT_LAYERS.alerts, enabled: true },
    goal: { enabled: true, title: "New subscribers", counts: "subs", target: 25 },
    cells: { horizontal, vertical },
  };
  const composition = (
    value: OverlayLayers,
    only: OverlayLayer | null = null,
    more: Partial<Parameters<typeof OverlayComposition>[0]> = {},
  ): string =>
    renderToStaticMarkup(createElement(OverlayComposition, { scene, layers: value, only, feed: null, ...more }));
  const boxes = (html: string): string[] =>
    [...html.matchAll(/<div class="ov-layer" data-layer="([a-z]+)" style="([^"]*)"/g)].map(
      (match: RegExpMatchArray): string => `${match[1]} ${match[2]}`,
    );

  it("shows each layer in its cell, in the horizontal and in the vertical output", (): void => {
    expect(boxes(composition(layers))).toEqual([
      "alerts left:25%;top:0%;width:50%;height:16.666666666666664%",
      "goal left:75%;top:0%;width:25%;height:11.11111111111111%",
    ]);
    expect(boxes(composition({ ...layers, orientation: "vertical" }))).toEqual([
      "alerts left:0%;top:0%;width:100%;height:9.375%",
      "goal left:0%;top:9.375%;width:100%;height:6.25%",
    ]);
    // The content of each layer is laid out in the design pixels of its cell.
    expect(composition(layers)).toContain('<div class="ov-layer-canvas" style="width:960px;height:180px">');
    expect(composition(layers)).toContain('<div class="ov-layer-canvas" style="width:480px;height:120px">');
  });

  it("shows the goal whenever the layer is on stream, and no banner between alerts", (): void => {
    const html: string = composition(layers);
    expect(textOf(html)).toBe("New subscribers · 0 of 25");
    expect(html).toContain('<div class="ov-stage" data-overlay-type="alerts"></div>');
  });

  it("shows a sample banner in a preview that plays sample chat", (): void => {
    const html: string = composition(layers, null, { samples: SAMPLE_CHAT });
    expect(html).toContain("<bdi>Mad Maxine</bdi> gave 5 subscriptions");
    expect(html).toContain("New subscribers");
  });

  it("is off stream without a cell, and while Show on stream is off", (): void => {
    const none = '<div class="ov-composition"></div>';
    expect(composition({ ...layers, cells: { horizontal: emptyCells(), vertical } })).toBe(none);
    const off: OverlayLayers = {
      ...layers,
      alerts: { ...layers.alerts, enabled: false },
      goal: { ...layers.goal, enabled: false },
    };
    expect(composition(off)).toBe(none);
    expect(boxes(composition({ ...layers, goal: { ...layers.goal, enabled: false } }))).toHaveLength(1);
  });

  it("goes with the content layers of a per-layer source, and not with the chat or the characters", (): void => {
    expect(boxes(composition(layers, "content")).map((box: string): string => box.split(" ")[0])).toEqual([
      "alerts",
      "goal",
    ]);
    expect(composition(layers, "chat")).toBe('<div class="ov-composition" data-overlay-only="chat"></div>');
    expect(composition(layers, "characters")).toBe('<div class="ov-composition" data-overlay-only="characters"></div>');
  });

  it("shows the goal on an output for Twitch only", (): void => {
    const only: OverlayLayers = { ...layers, twitchOnly: { horizontal: true, vertical: false } };
    const html: string = composition(only);
    expect(html).toContain('data-overlay-platform="twitch"');
    expect(textOf(html)).toBe("New subscribers · 0 of 25");
  });

  it("opens the activity feed for a page that shows one of the two layers of its output", (): void => {
    expect(usesActivityFeed(DEFAULT_LAYERS, null)).toBe(false);
    expect(usesAlerts(layers, null)).toBe(true);
    expect(usesActivityFeed(layers, null)).toBe(true);
    expect(usesActivityFeed(layers, "content")).toBe(true);
    // The feed of these layers has no playground frames.
    expect(usesCharacters(layers, null)).toBe(false);
    // A chat source and a characters source do not show the two layers.
    expect(usesActivityFeed(layers, "chat")).toBe(false);
    expect(usesActivityFeed(layers, "characters")).toBe(false);
    // One layer is sufficient, and only the layers of the output of the page count.
    const goalOnly: OverlayLayers = { ...layers, alerts: { ...layers.alerts, enabled: false } };
    expect(usesActivityFeed(goalOnly, null)).toBe(true);
    const alertsOnly: OverlayLayers = { ...layers, goal: { ...layers.goal, enabled: false } };
    expect(usesActivityFeed(alertsOnly, "content")).toBe(true);
    const verticalOnly: OverlayLayers = { ...layers, cells: { horizontal: emptyCells(), vertical } };
    expect(usesActivityFeed(verticalOnly, null)).toBe(false);
    expect(usesActivityFeed({ ...verticalOnly, orientation: "vertical" }, null)).toBe(true);
    const off: OverlayLayers = { ...goalOnly, goal: { ...layers.goal, enabled: false } };
    expect(usesActivityFeed(off, null)).toBe(false);
  });
});
