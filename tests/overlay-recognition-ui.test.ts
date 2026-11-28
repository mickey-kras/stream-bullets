import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../app/components/api";
import {
  AlertRulesTable,
  AlertTest,
  WholeNumberInput,
  alertsFailure,
  parseWholeNumber,
  testName,
} from "../app/components/overlay/alerts-settings";
import { SESSION_API, dockApi } from "../app/components/overlay/control-api";
import { GoalSettings } from "../app/components/overlay/goal-settings";
import { LayerProperties, withGoal, withRule } from "../app/components/overlay/layer-properties";
import { tagPlace } from "../app/components/overlay/layout-grid";
import type { CharactersControl } from "../app/components/overlay/characters-controls";
import { DEFAULT_LOCALE, loadCatalog, setLocaleSource, type Locale } from "../app/i18n";
import { ALERT_REFUSALS, type AlertRefusal, type AlertsReply } from "../app/lib/alert-control";
import { ALERT_MIN, ALERT_RULES, DEFAULT_RULES, TEST_ALERTS, type AlertRuleId } from "../app/lib/alerts";
import { GOAL_TARGET, GOAL_TITLE_LENGTH } from "../app/lib/goals";
import { DEFAULT_LAYERS, emptyCells, type GoalLayer, type OverlayLayers } from "../app/lib/overlay-layers";
import type { OverlayData, OverlayState } from "../app/types";

// The settings of the alerts layer and of the goal layer in the overlay editor (issue #1043).

function nothing(): void {
  // A handler that a static render never calls.
}

const data: OverlayData = { polls: [], topics: [], cards: [], next: null, support: null };

/** The alerts at the top and the goal at the right of the horizontal grid. `alerts` says whether alerts show. */
function layers(alerts: boolean, goal: Partial<GoalLayer> = {}): OverlayLayers {
  return {
    ...DEFAULT_LAYERS,
    alerts: { ...DEFAULT_LAYERS.alerts, enabled: alerts },
    goal: { ...DEFAULT_LAYERS.goal, enabled: true, ...goal },
    cells: {
      horizontal: { ...emptyCells(), alerts: { c: 8, r: 0, w: 16, h: 3 }, goal: { c: 24, r: 0, w: 8, h: 2 } },
      vertical: emptyCells(),
    },
  };
}

function overlayState(shown: OverlayLayers): OverlayState {
  return { showResults: true, message: "", messageStyle: "info", layers: shown, chatTestUntil: 0, revision: 1 };
}

const playground: CharactersControl = {
  feed: null,
  enabled: false,
  roster: [],
  off: false,
  statusError: null,
  busy: false,
  paused: false,
  testLeft: 0,
  testRunning: false,
  news: "",
  setNews: nothing,
  send: (): Promise<void> => Promise.resolve(),
};

function properties(layer: "alerts" | "goal", shown: OverlayLayers): string {
  return renderToStaticMarkup(
    createElement(LayerProperties, {
      layer,
      layers: shown,
      state: overlayState(shown),
      data,
      busy: false,
      run: nothing,
      change: nothing,
      characters: playground,
      feed: null,
      onRemove: nothing,
    }),
  );
}

/** The rows of the rules table: the rule and the markup of the row. */
function rows(html: string): { rule: string; html: string }[] {
  return [...html.matchAll(/<tr data-rule="([a-z]+)">(.*?)<\/tr>/gs)].map((match: RegExpMatchArray) => ({
    rule: match[1],
    html: match[2],
  }));
}

afterEach(() => {
  setLocaleSource((): Locale => DEFAULT_LOCALE);
  vi.restoreAllMocks();
});

describe("the alerts layer in the editor", () => {
  it("lists each rule, with the featured topic", () => {
    const html: string = renderToStaticMarkup(
      createElement(AlertRulesTable, { rules: DEFAULT_LAYERS.alerts.rules, onRule: nothing }),
    );
    expect(rows(html).map((row) => row.rule)).toEqual([...ALERT_RULES]);
    expect(rows(html).at(-1)?.html).toContain(
      '<span class="ov-rule-name">Featured topic</span> <span class="muted">Credits the author</span>',
    );
  });

  it("names each test alert with the amount of the sample that the server plays", () => {
    expect(TEST_ALERTS.map(testName)).toEqual([
      "Follow",
      "Subscription",
      "Gift of 5 subscriptions",
      "500 Bits",
      "Super Chat",
      "Raid with 38 viewers",
      "Featured topic",
      "Anonymous gift",
    ]);
  });

  it("has the test beside the name: the list, Send test, and the reason when the layer is off stream", () => {
    const off: string = properties("alerts", layers(false));
    const head: string = off.slice(off.indexOf('class="ov-props-head"'), off.indexOf("data-props-show"));
    expect(head).toContain(">Alerts</h3>");
    const label: string | undefined = /<span class="field-label" id="([^"]+)">Test alert<\/span>/.exec(head)?.[1];
    expect(head).toContain(`class="cselect-trigger" aria-labelledby="${label}"`);
    const send: string | undefined = /<button type="button" class="small-button"[^>]*data-alert-send[^>]*>/.exec(
      off,
    )?.[0];
    expect(send).toContain('aria-disabled="true"');
    const reason: string | undefined = /aria-describedby="([^"]+)"/.exec(send ?? "")?.[1];
    expect(off).toContain(`id="${reason}" data-alert-needs-layer="true">Turn on “Show on stream” to send a test.</p>`);
    // On stream: the button is available and has no reason.
    const on: string = renderToStaticMarkup(createElement(AlertTest, { onStream: true }));
    expect(on).toMatch(/aria-disabled="false" data-alert-send="true"/);
    expect(on).not.toContain("data-alert-needs-layer");
    expect(on).toContain('<p class="sr-only" aria-live="polite" data-alert-news="true"></p>');
  });

  it("has a table of rules with a header row and one row with a header cell for each rule", () => {
    const html: string = renderToStaticMarkup(
      createElement(AlertRulesTable, { rules: DEFAULT_LAYERS.alerts.rules, onRule: nothing }),
    );
    expect(html).toContain('<caption class="sr-only">What each event does</caption>');
    expect([...html.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((match) => match[1])).toEqual([
      "Event",
      "Starts at",
      "Banner",
      "In chat",
      "Character",
    ]);
    const shown = rows(html);
    expect(shown.map((row) => row.rule)).toEqual(["follow", "subscription", "gift", "bits", "paid", "raid", "topic"]);
    for (const row of shown) expect(row.html).toMatch(/^<th scope="row" class="ov-rule-event">/);
    const byRule = (rule: AlertRuleId): string => shown.find((row) => row.rule === rule)?.html ?? "";
    expect(byRule("follow")).toContain(
      '<span class="ov-rule-name">Follow</span> <span class="muted">Twitch, Kick</span>',
    );
    expect(byRule("paid")).toContain("Super Chat, Super Sticker");
    expect(byRule("gift")).toContain("One alert for the bundle");
  });

  it("has a number only for the rules with an amount, and a named switch for each part of each rule", () => {
    const rules = { ...DEFAULT_LAYERS.alerts.rules, bits: { ...DEFAULT_RULES.bits, min: 250, chat: false } };
    const shown = rows(renderToStaticMarkup(createElement(AlertRulesTable, { rules, onRule: nothing })));
    const amount = (html: string): string | undefined =>
      /<input type="text" inputMode="numeric"[^>]* aria-label="([^"]+)"[^>]* value="(\d+)"/
        .exec(html)
        ?.slice(1)
        .reverse()
        .join("|");
    expect(shown.map((row) => amount(row.html) ?? null)).toEqual([
      null,
      null,
      "1|Starts at: smallest amount for Gift",
      "250|Starts at: smallest amount for Bits, KICKs",
      null,
      "5|Starts at: smallest amount for Raid",
      null,
    ]);
    expect(shown[0].html).toContain('<span class="muted">Each one</span>');
    const switches = (html: string): string[] =>
      [...html.matchAll(/<input type="checkbox" aria-label="([^"]+)" data-rule-switch="([a-z]+)"( checked="")?/g)].map(
        (match: RegExpMatchArray): string => `${match[2]}:${match[3] ? "on" : "off"}:${match[1]}`,
      );
    // A follow has no banner by default: follows come often.
    expect(switches(shown[0].html)).toEqual([
      "banner:off:Banner for Follow",
      "chat:on:Mark in chat for Follow",
      "character:on:Character action for Follow: Wave",
    ]);
    expect(switches(shown[3].html)[1]).toBe("chat:off:Mark in chat for Bits, KICKs");
    // The visible text of the character switch is the action, and it is part of the name of the switch.
    expect(shown[5].html).toContain("Character action for Raid: All cheer");
    expect(shown[5].html).toContain('<span aria-hidden="true">All cheer</span>');
  });

  it("explains the behavior in a closed details element, with the decisions of the owner", () => {
    const html: string = renderToStaticMarkup(
      createElement(AlertRulesTable, { rules: DEFAULT_LAYERS.alerts.rules, onRule: nothing }),
    );
    const help: string = html.slice(html.indexOf("<details"));
    expect(help).toMatch(
      /^<details class="ch-details ov-props-more" data-alert-help="true"><summary>How alerts behave/,
    );
    expect(help).not.toContain(" open");
    const items: string[] = [...help.matchAll(/<li>([^<]*)<\/li>/g)].map((match: RegExpMatchArray): string => match[1]);
    expect(items).toHaveLength(6);
    expect(items[0]).toContain("with the name and the amount only");
    expect(items[2]).toContain("never a name");
    expect(items[3]).toBe("A test and a replay never count for a goal, a report, or revenue.");
    expect(items[4]).toContain("Mute stops the alert on stream and discards the alerts that wait.");
    expect(items[5]).toContain("reduced motion");
  });

  it("changes one field of one rule", () => {
    const before: OverlayLayers = layers(true);
    const after: OverlayLayers = withRule(before, "bits", { min: 300 });
    expect(after.alerts.rules.bits).toEqual({ ...before.alerts.rules.bits, min: 300 });
    expect(after.alerts.rules.gift).toBe(before.alerts.rules.gift);
    expect(before.alerts.rules.bits.min).toBe(100);
  });
});

describe("a whole number in the editor", () => {
  it("takes only a whole number in the limits", () => {
    expect(parseWholeNumber("100", ALERT_MIN)).toBe(100);
    expect(parseWholeNumber(" 7 ", ALERT_MIN)).toBe(7);
    for (const text of ["", "0", "-1", "1.5", "1e3", "abc", "1000001", "123456789"])
      expect(parseWholeNumber(text, ALERT_MIN), text).toBeNull();
    expect(parseWholeNumber("10000000", GOAL_TARGET)).toBe(10_000_000);
  });

  it("shows the saved value with its name and no error before the focus leaves", () => {
    const html: string = renderToStaticMarkup(
      createElement(WholeNumberInput, { value: 25, limits: GOAL_TARGET, labelledBy: "target", onValue: nothing }),
    );
    expect(html).toBe(
      '<span class="ov-number"><input type="text" inputMode="numeric" autoComplete="off" size="7" ' +
        'aria-labelledby="target" value="25"/></span>',
    );
  });
});

describe("the goal layer in the editor", () => {
  it("has the title, the count, the target, the count of the server with Start again, and the one-thing note", () => {
    const html: string = properties("goal", layers(true, { title: "New subscribers", target: 40 }));
    expect(html).toContain(">Goal</h3>");
    expect(html).not.toContain("data-alert-test");
    expect(html).toMatch(
      /<label class="field-label" for="([^"]+)">Title on stream<\/label><input id="\1" maxLength="60"/,
    );
    expect(GOAL_TITLE_LENGTH).toBe(60);
    expect(html).toContain('value="New subscribers"');
    const counts: string | undefined = /<span class="field-label" id="([^"]+)">Counts<\/span>/.exec(html)?.[1];
    expect(html).toContain(`class="cselect-trigger" aria-labelledby="${counts}"`);
    const target: string | undefined = /<span class="field-label" id="([^"]+)">Target<\/span>/.exec(html)?.[1];
    expect(html).toContain(`aria-labelledby="${target}" data-goal-target="true" value="40"/>`);
    expect(html).toContain("Up to 60 characters. Viewers can see the title as soon as it saves");
    expect(html).toContain("A change of what the goal counts starts the count again at 0.");
    // Without a message of the server the count is 0, as on the overlay.
    expect(html).toMatch(/<progress value="0" max="40" aria-label="Count of the goal" aria-valuetext="0 of 40">/);
    expect(html).toContain('data-goal-progress="true">0 of 40</span>');
    expect(html).toMatch(/aria-disabled="false" data-goal-reset="true">.*Start again<\/button>/s);
    expect(html).toContain("A goal counts one thing. Bits, KICKs, and currencies do not convert.");
    // The confirmation is closed.
    expect(html).not.toContain("Start the count again?");
  });

  it("formats the numbers in the language of the page", async () => {
    await loadCatalog("de");
    setLocaleSource((): Locale => "de");
    const html: string = renderToStaticMarkup(
      createElement(GoalSettings, {
        goal: { ...DEFAULT_LAYERS.goal, target: 12_000 },
        feed: null,
        onGoal: nothing,
      }),
    );
    expect(html).toContain("0 von 12.000");
  });

  it("changes some fields of the goal", () => {
    const after: OverlayLayers = withGoal(layers(true), { counts: "bits", target: 500 });
    expect(after.goal).toEqual({ ...layers(true).goal, counts: "bits", target: 500 });
  });
});

describe("the refusals of the alert controls", () => {
  const refused = (code: AlertRefusal): ApiError => new ApiError("server text", ALERT_REFUSALS[code], code);

  it("give the text of the page for each code of the alert host", () => {
    expect(alertsFailure(refused("alerts_off_stream"))).toBe("Put the Alerts layer on stream first.");
    expect(alertsFailure(refused("alerts_muted"))).toBe(
      "Alerts are muted. Turn the mute off in Live or in the OBS dock first.",
    );
    expect(alertsFailure(refused("alerts_unwatched"))).toBe("No page shows alerts now. Open the overlay in OBS first.");
    expect(alertsFailure(refused("alert_rule_off"))).toContain("Banner, In chat, and Character off");
    expect(alertsFailure(refused("alerts_full"))).toContain("Too many alerts wait.");
    expect(alertsFailure(refused("goal_off"))).toBe("Put the Goal layer on the grid first.");
    expect(alertsFailure(refused("alert_gone"))).toBe("This event is too old for a replay.");
    expect(alertsFailure(refused("alerts_unavailable"))).toBe("Alerts are not available now. Try again.");
  });

  it("tell a server without alerts, too many requests, and a lost connection", async () => {
    expect(alertsFailure(new ApiError("Alerts are off on this server.", 503, null))).toBe(
      "Alerts are off on this server.",
    );
    expect(alertsFailure(new ApiError("Slow down", 429, null))).toMatch(/\S/);
    expect(alertsFailure(new ApiError("Slow down", 429, null))).not.toBe("Slow down");
    expect(alertsFailure(new TypeError("Failed to fetch"))).not.toContain("fetch");
    // Each language has its own text: the server text is English.
    await loadCatalog("ru");
    setLocaleSource((): Locale => "ru");
    expect(alertsFailure(refused("alerts_muted"))).toContain("Оповещения заглушены");
    expect(alertsFailure(new ApiError("Alerts are off on this server.", 503, null))).toBe(
      "Оповещения отключены на этом сервере.",
    );
  });
});

describe("the alert controls of the control API", () => {
  const reply: AlertsReply = { at: 5, muted: false, current: null, waiting: 0, goal: null };

  /** The requests of the control API: the address and the options of each. */
  function answer(): [string, RequestInit][] {
    const calls: [string, RequestInit][] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push([input instanceof Request ? input.url : input.toString(), init ?? {}]);
        return Promise.resolve(Response.json(reply));
      },
    );
    return calls;
  }

  it("send a control with the session of the owner", async () => {
    const sent = answer();
    await expect(SESSION_API.alerts({ op: "test", kind: "raid" })).resolves.toEqual(reply);
    const [url, init] = sent[0];
    expect(url).toBe("/api/overlay/alerts");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"op":"test","kind":"raid"}');
    expect(init.credentials).toBe("same-origin");
  });

  it("send a control of the dock with its key in a header", async () => {
    const sent = answer();
    await expect(dockApi("host", "dock-key").alerts({ op: "mute", on: true })).resolves.toEqual(reply);
    const [url, init] = sent[0];
    expect(url).toBe("/api/dock/host/alerts");
    expect(new Headers(init.headers).get("X-SB-Dock-Key")).toBe("dock-key");
    expect(init.body).toBe('{"op":"mute","on":true}');
  });
});

describe("the name and the size of a low box on the grid", () => {
  it("go outside the box so they do not cover the title of the goal", () => {
    expect(tagPlace("horizontal", { c: 24, r: 0, w: 8, h: 3 })).toBeUndefined();
    expect(tagPlace("horizontal", { c: 24, r: 0, w: 8, h: 2 })).toBe("below");
    expect(tagPlace("horizontal", { c: 24, r: 15, w: 8, h: 2 })).toBe("below");
    expect(tagPlace("horizontal", { c: 24, r: 16, w: 8, h: 2 })).toBe("above");
    expect(tagPlace("vertical", { c: 0, r: 30, w: 18, h: 2 })).toBe("above");
    expect(tagPlace("vertical", { c: 0, r: 3, w: 18, h: 2 })).toBe("below");
  });
});
