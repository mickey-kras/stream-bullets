import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../app/components/api";
import { ControlApiContext, SESSION_API, dockApi } from "../app/components/overlay/control-api";
import {
  ActivityView,
  failedText,
  type ActivityViewProps,
  type AlertsControl,
} from "../app/components/tools/live-activity";
import { FullChatView, type ChatModel } from "../app/components/tools/live-chat";
import { DEFAULT_LOCALE, LOCALES, loadCatalog, setLocaleSource, t, type Locale } from "../app/i18n";
import { ALERT_REFUSALS, type AlertRefusal } from "../app/lib/alert-control";
import type { AlertView } from "../app/lib/alerts";
import { REFUSAL_TEXT, REPLAY_WINDOW_MS, type ActivityRow, type ShownAlerts } from "../app/lib/live-activity";

// The Activity part of Live and the dock, as the page renders it for each state of the alerts.

const T0 = 1_800_000_000_000;

beforeEach((): void => {
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
});

afterEach((): void => {
  vi.useRealTimers();
  setLocaleSource((): Locale => DEFAULT_LOCALE);
});

const idle: AlertsControl = {
  busy: new Set<string>(),
  reply: null,
  gone: new Set<string>(),
  send: (): void => undefined,
};
const quiet: ShownAlerts = { muted: false, current: null, waiting: 0, goal: null, until: 0 };

function alert(more: Partial<AlertView> = {}): AlertView {
  return {
    id: "twitch:d1",
    origin: "live",
    kind: "gift",
    platform: "twitch",
    name: "LanternFox",
    anonymous: false,
    amount: 5,
    currency: null,
    banner: true,
    chat: true,
    startsAt: T0,
    endsAt: T0 + 6000,
    ...more,
  };
}

function row(id: string, more: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: `twitch:${id}`,
    kind: "gift",
    platform: "twitch",
    name: "LanternFox",
    amount: 5,
    currency: null,
    receivedAt: T0 - 2 * 60_000,
    original: true,
    ...more,
  };
}

function render(more: Partial<ActivityViewProps> = {}, key: string | null = null): string {
  // By default the server keeps each original row that the test shows.
  const rows: readonly ActivityRow[] = more.rows ?? [];
  const kept: string[] = rows.filter((one: ActivityRow): boolean => one.original).map((one: ActivityRow) => one.id);
  const props: ActivityViewProps = {
    alerts: quiet,
    rows,
    kept,
    now: T0,
    onStream: true,
    control: idle,
    dock: false,
    ...more,
  };
  const api = key === null ? SESSION_API : dockApi("host", key);
  return renderToStaticMarkup(
    createElement(ControlApiContext.Provider, { value: api }, createElement(ActivityView, props)),
  );
}

/** The HTML of one element that `marker` starts, up to its end tag. */
function element(html: string, marker: string, end: string): string {
  const start: number = html.indexOf(marker);
  expect(start, marker).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf(end, start) + end.length);
}

describe("the controls of the alerts", (): void => {
  it("has Test alert and Mute alerts in the title line, and the closing line with a link to Overlay", (): void => {
    const html: string = render();
    expect(html).toMatch(
      /^<section class="ov-step tl-part"[^>]*data-live-part="activity"><div class="tl-part-head"><h2[^>]*>Activity<\/h2><div class="tl-activity-actions"><button[^>]*data-live-alerts-test[^>]*>.*Test alert<\/button><button[^>]*aria-pressed="false"[^>]*data-live-alerts-mute[^>]*>.*Mute alerts<\/button><\/div><\/div>/,
    );
    expect(html).toContain(
      'Test and Replay show an alert again. They do not count for goals or revenue. Choose what each event does in <span class="tl-nowrap"><a class="text-link" href="/tools?view=overlay">Overlay</a>,</span> in the Alerts layer.',
    );
    expect(html).toContain("No support events yet.");
    expect(html).not.toContain("data-live-alerts-muted");
    expect(html).not.toContain("data-live-alert-now");
  });

  it("shows clearly that the alerts are muted: a pressed toggle and a line", (): void => {
    const html: string = render({ alerts: { ...quiet, muted: true } });
    expect(element(html, "<button", "</button>")).toContain("Test alert");
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*data-live-alerts-mute/);
    expect(html).toContain('<p class="tl-activity-muted" data-live-alerts-muted="true">');
    expect(html).toContain("Alerts are muted. No alert shows on stream. Events still count for the goal.");
  });

  it("disables only the control that runs", (): void => {
    const html: string = render({ control: { ...idle, busy: new Set<string>(["mute"]) } });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-live-alerts-mute/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-live-alerts-test/);
  });
});

describe("the alert on stream", (): void => {
  it("shows who and what with Skip, the seconds left, and the alerts that wait", (): void => {
    const html: string = render({ alerts: { ...quiet, current: alert(), waiting: 2, until: T0 + 4000 } });
    const box: string = element(html, '<div class="tl-event tl-event-now"', "</div>");
    expect(box).toContain('data-live-alert-now="live"');
    expect(box).toContain("On stream now: <bdi>LanternFox</bdi> gave 5 subscriptions");
    expect(box).toMatch(/<button type="button" class="small-button" data-live-alert-skip="true">.*Skip<\/button>/);
    expect(box).toContain('<span class="tl-event-meta" data-live-alert-left="true">4 s left · 2 alerts wait</span>');
  });

  it("has no count of waiting alerts when none waits, and says that a test or a replay is one", (): void => {
    const test: string = render({ alerts: { ...quiet, current: alert({ origin: "test" }), until: T0 + 1500 } });
    expect(test).toContain('data-live-alert-left="true">Test · 2 s left</span>');
    const replay: string = render({ alerts: { ...quiet, current: alert({ origin: "replay" }), until: T0 + 900 } });
    expect(replay).toContain('data-live-alert-left="true">Replay · 1 s left</span>');
  });

  it("names an anonymous supporter with the word, never with a name", (): void => {
    const html: string = render({
      alerts: { ...quiet, current: alert({ anonymous: true, name: "Hidden" }), until: T0 + 4000 },
    });
    expect(html).toContain("On stream now: <bdi>Anonymous</bdi> gave 5 subscriptions");
    expect(html).not.toContain("Hidden");
  });
});

describe("the recent support events", (): void => {
  it("shows each row with its icon, the title beside Replay, and the details line below", (): void => {
    const html: string = render({
      rows: [row("d2", { kind: "bits", amount: 500, receivedAt: T0 - 1000 }), row("d1")],
    });
    const list: string = element(html, '<ol class="tl-events"', "</ol>");
    expect(list).toContain('aria-label="Activity"');
    const first: string = element(list, "<li", "</li>");
    expect(first).toContain('data-activity-row="twitch:d2"');
    expect(first).toContain('data-replay="true"');
    expect(first).toMatch(/icon-zap/);
    expect(first).toContain('<span class="tl-event-title"><bdi>LanternFox</bdi> 500 Bits</span>');
    expect(first).toContain('aria-label="Replay: LanternFox 500 Bits"');
    expect(first).toContain('<span class="tl-event-meta" data-activity-meta="true">Twitch · 1 second ago</span>');
    expect(list).toContain("Twitch · 2 minutes ago");
    // Newest first: the order of the rows.
    expect(list.indexOf("twitch:d2")).toBeLessThan(list.indexOf("twitch:d1"));
  });

  it("hides Replay on a row that is too old, on a replay, and on an event that the server no longer keeps", (): void => {
    const rows: ActivityRow[] = [
      row("fresh", { receivedAt: T0 }),
      row("again", { original: false, receivedAt: T0 - 1 }),
      row("gone", { receivedAt: T0 - 2 }),
      row("old", { receivedAt: T0 - REPLAY_WINDOW_MS }),
    ];
    const html: string = render({ rows, control: { ...idle, gone: new Set<string>(["twitch:gone"]) } });
    // A row that the server does not keep has no Replay.
    expect(render({ rows, kept: [] })).not.toContain("data-activity-replay");
    const replays: string[] = [...html.matchAll(/aria-label="Replay: [^"]*"[^>]*data-activity-replay/g)].map(
      (match: RegExpMatchArray): string => match[0],
    );
    expect(replays).toHaveLength(1);
    const items: string[] = html.match(/<li[^>]*>/g) ?? [];
    expect(items.map((item: string): boolean => item.includes("data-replay"))).toEqual([true, false, false, false]);
    // A row without Replay says so when it is itself a replay, and it shows its age.
    expect(html).toContain("Twitch · just now · Replay");
    expect(html).toContain("Twitch · 10 minutes ago");
  });

  it("names the source of a tip and of a topic credit", (): void => {
    const html: string = render({
      rows: [
        row("tip", { kind: "tip", platform: "direct", amount: 10_000_000, currency: "EUR", name: null }),
        row("topic", { kind: "topic", platform: "direct", amount: null, receivedAt: T0 - 3 }),
      ],
    });
    expect(html).toContain("<bdi>Anonymous</bdi> tip: €10.00");
    expect(html).toContain("Your tip page · 2 minutes ago");
    expect(html).toContain("StreamBullets · just now");
    expect(html).toMatch(/icon-heart/);
  });
});

describe("the Alerts layer off stream", (): void => {
  it("says so with a link to Overlay, and Test and Replay are off with that reason", (): void => {
    const html: string = render({ onStream: false, rows: [row("d1", { receivedAt: T0 })] });
    const note: string = element(html, '<p class="muted tl-note" id=', "</p>");
    const id: string = /id="([^"]+)"/.exec(note)?.[1] ?? "";
    expect(note).toContain(
      'The Alerts layer is not on stream, so Test and Replay cannot show an alert. <a class="text-link" href="/tools?view=overlay">Open Overlay</a>',
    );
    expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*aria-describedby="${id}"[^>]*data-live-alerts-test`));
    expect(html).toMatch(new RegExp(`<button[^>]*aria-describedby="${id}"[^>]*disabled=""[^>]*data-activity-replay`));
    // The mute and the skip still work: the owner can always stop the alerts.
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-live-alerts-mute/);
  });
});

describe("the dock", (): void => {
  it("has Mute alerts beside the title, Test alert and Skip alert in one row, and Replay on each row", (): void => {
    const html: string = render({ dock: true, rows: [row("d1", { receivedAt: T0 })] }, "k".repeat(43));
    expect(html).toMatch(
      /<div class="tl-part-head"><h2[^>]*>Activity<\/h2><button[^>]*data-live-alerts-mute[^>]*>.*?Mute alerts<\/button><\/div>/,
    );
    expect(html).toMatch(
      /<div class="tl-activity-actions"><button[^>]*data-live-alerts-test[^>]*>.*?Test alert<\/button><button[^>]*disabled=""[^>]*data-live-alert-skip="true">.*?Skip alert<\/button><\/div>/,
    );
    expect(html).toContain("data-activity-replay");
    // The narrow panel has no details line, no closing line, and no link to Streamer tools.
    expect(html).not.toContain("data-activity-meta");
    expect(html).not.toContain("data-live-activity-note");
    expect(html).not.toContain("href=");
  });

  it("enables Skip alert while an alert is on stream, and names that alert", (): void => {
    const html: string = render(
      { dock: true, alerts: { ...quiet, current: alert(), until: T0 + 4000 } },
      "k".repeat(43),
    );
    expect(html).toMatch(/<button type="button" class="small-button tl-activity-button" data-live-alert-skip="true">/);
    expect(html).toContain("On stream now: <bdi>LanternFox</bdi> gave 5 subscriptions");
    const off: string = render({ dock: true, onStream: false }, "k".repeat(43));
    expect(off).toContain("The Alerts layer is not on stream, so Test and Replay cannot show an alert. </p>");
  });
});

describe("a failed control", (): void => {
  it("has the text of each refusal of the alert host", (): void => {
    for (const code of Object.keys(ALERT_REFUSALS) as AlertRefusal[]) {
      const error = new ApiError("English text of the server", ALERT_REFUSALS[code], code);
      expect(failedText(error), code).toBe(t(REFUSAL_TEXT[code]));
    }
    expect(failedText(new ApiError("Too many", 429, null))).toBe(
      "Too many tests and replays. Wait a minute, then try again.",
    );
    expect(failedText(new ApiError("Alerts are off on this server.", 503, null))).toBe(
      "Alerts are not available now. Try again later.",
    );
  });

  it("has the general text of other errors", (): void => {
    expect(failedText(new ApiError("Frozen", 423, "page_frozen"))).toBe(t("error.pageFrozen"));
    expect(failedText(new TypeError("Failed to fetch"))).toBe(t("common.failed"));
  });

  it("has a translated text in each language", async (): Promise<void> => {
    await Promise.all(LOCALES.map((locale: Locale) => loadCatalog(locale)));
    for (const locale of LOCALES) {
      setLocaleSource((): Locale => locale);
      const texts = new Set<string>(
        (Object.keys(ALERT_REFUSALS) as AlertRefusal[]).map((code: AlertRefusal): string =>
          failedText(new ApiError("x", ALERT_REFUSALS[code], code)),
        ),
      );
      expect(texts.size, locale).toBe(Object.keys(ALERT_REFUSALS).length);
      for (const text of texts) expect(text, locale).not.toContain("!");
      if (locale !== "en") expect(texts.has(t(REFUSAL_TEXT.alert_gone)), locale).toBe(true);
    }
  });
});

describe("the full-screen chat", (): void => {
  it("has no activity part", (): void => {
    const chat: ChatModel = {
      rows: [],
      paused: false,
      waiting: 0,
      pause: (): void => undefined,
      jump: (): void => undefined,
      hidden: new Set(),
      toggle: (): void => undefined,
      list: (): void => undefined,
      scrolled: (): void => undefined,
      status: "live",
    };
    const html: string = renderToStaticMarkup(
      createElement(FullChatView, {
        chat,
        delivers: true,
        onAir: null,
        wake: "on",
        step: 1,
        onStep: (): void => undefined,
        onExit: (): void => undefined,
      }),
    );
    expect(html).not.toContain("data-live-part");
    expect(html).not.toContain("Replay");
  });
});
