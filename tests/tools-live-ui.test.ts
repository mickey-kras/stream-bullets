import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityFeed } from "../app/components/overlay/activity-feed";
import type { OverlayPoll, OverlayScene } from "../app/components/overlay/overlay-stage";
import type { ControlAction } from "../app/components/overlay/use-overlay-state";
import { FullChatView, LiveChat, type ChatModel } from "../app/components/tools/live-chat";
import { LiveMessage } from "../app/components/tools/live-message";
import { NotOnGrid, placed } from "../app/components/tools/live-part";
import { LivePoll } from "../app/components/tools/live-poll";
import { LiveSection, onAirTitle } from "../app/components/tools/live-section";
import { supportLine } from "../app/components/tools/live-support";
import { LIVE_TOPICS, LiveTopics, liveTopics } from "../app/components/tools/live-topics";
import { DEFAULT_LOCALE, LOCALES, loadCatalog, setLocaleSource, type Locale } from "../app/i18n";
import { SUPPORT_KINDS, type ActivityPlatform } from "../app/lib/activity";
import type { ChannelView } from "../app/lib/channel-health";
import type { LiveChatRow, LiveSupportRow } from "../app/lib/live-chat";
import { DEFAULT_LAYERS, emptyCells, type CellRect, type OverlayLayers } from "../app/lib/overlay-layers";
import type { OverlayData, OverlayState } from "../app/types";

// The Live section of Streamer tools, as the server renders it for each on-air state.

const cell = (c: number): CellRect => ({ c, r: 0, w: 8, h: 4 });
/** The poll, the topic and the message banner on the grid of the horizontal orientation. */
const onGrid: OverlayLayers = {
  ...DEFAULT_LAYERS,
  cells: { horizontal: { ...emptyCells(), poll: cell(0), topic: cell(8), message: cell(16) }, vertical: emptyCells() },
};

/** The same layers on the grid of the vertical output only. The editor shows the horizontal output. */
const otherOutput: OverlayLayers = {
  ...onGrid,
  cells: { horizontal: emptyCells(), vertical: onGrid.cells.horizontal },
};

function layersWith(items: Partial<OverlayLayers["items"]>, layers: OverlayLayers = onGrid): OverlayLayers {
  return { ...layers, items: { ...layers.items, ...items } };
}

function stateOf(layers: OverlayLayers, more: Partial<OverlayState> = {}): OverlayState {
  return { showResults: false, message: "", messageStyle: "info", layers, chatTestUntil: 0, revision: 1, ...more };
}

function poll(id: string, more: Partial<OverlayPoll> = {}): OverlayPoll {
  return {
    id,
    title: `Poll ${id}`,
    kind: "choice",
    options: ["Tea", "Coffee"],
    endsAt: null,
    revealed: false,
    counts: [2, 1],
    total: 3,
    mash: null,
    byOwner: true,
    ...more,
  };
}

function topic(n: number): OverlayData["topics"][number] {
  return {
    id: `t${n}`,
    title: `Topic ${n}`,
    category: "",
    author: `Viewer ${n}`,
    avatar: null,
    avatarPreset: null,
    likes: 0,
  };
}

const data: OverlayData = { polls: [], topics: [], cards: [], next: null, support: null };

function sceneOf(state: OverlayState, more: Partial<OverlayScene> = {}): OverlayScene {
  return {
    name: "Host",
    handle: "host",
    host: "stream.example.test",
    origin: "https://stream.example.test",
    overlay: state,
    polls: [poll("p1")],
    data,
    now: 1000,
    ...more,
  };
}

function run(_action: ControlAction): void {
  // A static render never calls a handler.
}
function send(_action: ControlAction): Promise<boolean> {
  return Promise.resolve(true);
}

const feed: ActivityFeed = { subscribe: () => (): void => undefined, status: "live" };

function pollPart(state: OverlayState, more: Partial<OverlayScene> = {}): string {
  return renderToStaticMarkup(createElement(LivePoll, { scene: sceneOf(state, more), state, busy: false, run }));
}

describe("poll on stream", (): void => {
  it("shows the poll of the poll layer with each on-air control", (): void => {
    const html: string = pollPart(stateOf(onGrid));
    expect(html).toContain("Poll p1");
    expect(html).toContain("On air");
    expect(html).toContain("3 votes");
    expect(html).toContain("Results hidden on stream");
    for (const label of ["Copy link", "Hide QR code", "Reveal results", "Close voting", "Take off air"])
      expect(html, label).toContain(label);
    expect(html).toContain("Taking the poll off air keeps voting open on your page.");
  });

  it("names the other state of each switch", (): void => {
    const layers: OverlayLayers = layersWith({ poll: { ...onGrid.items.poll, enabled: false, qr: false } });
    const html: string = pollPart(stateOf(layers, { showResults: true }));
    expect(html).toContain("Off air");
    expect(html).toContain("Put on air");
    expect(html).not.toContain("Take off air");
    expect(html).toContain("Show QR code");
    expect(html).toContain("Hide results");
    expect(html).toContain("Results show on stream");
  });

  it("has the actions that change the stream in one row, and the link and the QR code above it", (): void => {
    /** The buttons of the row, by their test attribute, in their order. */
    const row = (html: string): string[] => {
      const inner: string = html.split("data-live-poll-actions")[1].split("</div>")[0];
      return [...inner.matchAll(/<button[^>]*data-live-poll-(\w+)="true"/g)].map((match: RegExpMatchArray) => match[1]);
    };
    const html: string = pollPart(stateOf(onGrid));
    expect(html).toMatch(/<div class="tl-fill-row" data-live-poll-actions="true">/);
    expect(row(html)).toEqual(["results", "close", "air"]);
    // The row has only these buttons. Its styles give each of them the same width.
    const before: string = html.split("data-live-poll-actions")[0];
    expect(before).toContain("Copy link");
    expect(before).toContain("data-live-poll-qr");
    // The buttons of the row have the full size, for a finger.
    expect(html.split("data-live-poll-actions")[1]).not.toContain("small-button");
    // A poll that viewers cannot vote on has two actions: the row has two equal columns.
    expect(row(pollPart(stateOf(onGrid), { polls: [poll("p1", { revealed: true })] }))).toEqual(["results", "air"]);
  });

  it("offers Close voting only while viewers can vote on a poll that is not a Mash Battle", (): void => {
    const state: OverlayState = stateOf(onGrid);
    // The note under the buttons also names Close voting, so look for the button.
    const close = "data-live-poll-close";
    expect(pollPart(state)).toContain(close);
    expect(pollPart(state, { polls: [poll("p1", { revealed: true })] })).not.toContain(close);
    expect(pollPart(state, { polls: [poll("p1", { endsAt: 500 })] })).not.toContain(close);
    expect(pollPart(state, { polls: [poll("p1", { endsAt: 5000 })] })).toContain(close);
    const mash: NonNullable<OverlayPoll["mash"]> = {
      durationS: 30,
      phase: "setup",
      startsAt: null,
      endsAt: null,
      winner: null,
      totals: [0, 0],
      players: 0,
      assisted: 0,
    };
    expect(pollPart(state, { polls: [poll("p1", { mash })] })).not.toContain(close);
  });

  it("shows the poll that the layer names, and says when the page has no poll", (): void => {
    const named: OverlayLayers = layersWith({ poll: { ...onGrid.items.poll, ref: "p2" } });
    expect(pollPart(stateOf(named), { polls: [poll("p1"), poll("p2")] })).toContain("Poll p2");
    const none: string = pollPart(stateOf(onGrid), { polls: [] });
    expect(none).toContain("You have no poll yet.");
    expect(none).toContain('href="/@host?view=polls"');
    expect(none).not.toContain("Take off air");
  });

  it("counts a poll on the grid of the output that the editor does not show as on stream", (): void => {
    const html: string = pollPart(stateOf(otherOutput));
    expect(html).toContain("On air");
    expect(html).toContain("Take off air");
    expect(html).not.toContain("data-live-not-on-grid");
    const off: string = pollPart(stateOf(layersWith({ poll: { ...onGrid.items.poll, enabled: false } }, otherOutput)));
    expect(off).toContain("Off air");
    expect(off).toContain("Put on air");
  });

  it("sends the owner to the Overlay section when the poll layer is not on the grid", (): void => {
    const html: string = pollPart(stateOf(DEFAULT_LAYERS));
    expect(html).toContain("The Poll layer is not on the grid, so it cannot show on stream.");
    expect(html).toContain('href="/tools?view=overlay"');
    expect(html).not.toContain("Put on air");
    expect(placed(DEFAULT_LAYERS, "poll")).toBe(false);
    expect(placed(onGrid, "poll")).toBe(true);
    // The two outputs are on stream at the same time: a cell in one of them counts, whatever the editor shows.
    expect(placed({ ...onGrid, orientation: "vertical" }, "poll")).toBe(true);
    for (const orientation of ["horizontal", "vertical"] as const)
      for (const layer of ["poll", "topic", "message"] as const)
        expect(placed({ ...otherOutput, orientation }, layer), `${layer} ${orientation}`).toBe(true);
    expect(placed(otherOutput, "chat")).toBe(false);
    for (const layer of ["poll", "topic", "message"] as const)
      expect(renderToStaticMarkup(createElement(NotOnGrid, { layer }))).toContain(`data-live-not-on-grid="${layer}"`);
  });
});

describe("viewer topics", (): void => {
  const topics = Array.from({ length: 9 }, (_, n: number) => topic(n + 1));

  function part(state: OverlayState, list: OverlayData["topics"] = topics): string {
    const scene: OverlayScene = sceneOf(state, { data: { ...data, topics: list } });
    return renderToStaticMarkup(createElement(LiveTopics, { scene, state, busy: false, run }));
  }

  it("lists the newest topics, and the topic of the layer first when it is older", (): void => {
    expect(liveTopics(topics, null).map((item) => item.id)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
    expect(liveTopics(topics, "t3")).toHaveLength(LIVE_TOPICS);
    expect(liveTopics(topics, "t9").map((item) => item.id)).toEqual(["t9", "t1", "t2", "t3", "t4", "t5"]);
    expect(liveTopics(topics, "gone")).toHaveLength(LIVE_TOPICS);
    expect(liveTopics([], "t1")).toEqual([]);
  });

  it("offers each topic for the stream and marks the topic on air", (): void => {
    const layers: OverlayLayers = layersWith({ topic: { ...onGrid.items.topic, ref: "t2" } });
    const html: string = part(stateOf(layers));
    expect(html).toContain('aria-label="Feature on stream: Topic 1"');
    expect(html).toContain('aria-label="Take off air: Topic 2"');
    expect(html).toContain("From Viewer 2");
    expect(html.match(/data-live-topic=/g)).toHaveLength(LIVE_TOPICS);
    expect(html).toContain('href="/@host?view=topics"');
    // A topic layer that is off shows no topic, so no topic is on air.
    const off: OverlayLayers = layersWith({ topic: { ...onGrid.items.topic, ref: "t2", enabled: false } });
    expect(part(stateOf(off))).not.toContain("Take off air");
  });

  it("gives the button of each topic the class of the common width", (): void => {
    const layers: OverlayLayers = layersWith({ topic: { ...onGrid.items.topic, ref: "t2" } });
    const html: string = part(stateOf(layers));
    // One button for each row, also for the topic on air: the styles give this class one width.
    expect(html.match(/<button type="button" class="tl-action"/g)).toHaveLength(LIVE_TOPICS);
    expect(html.match(/<button/g)).toHaveLength(LIVE_TOPICS);
    expect(html).not.toContain("small-button");
  });

  it("marks the topic on air in the output that the editor does not show", (): void => {
    const layers: OverlayLayers = layersWith({ topic: { ...onGrid.items.topic, ref: "t2" } }, otherOutput);
    const html: string = part(stateOf(layers));
    expect(html).toContain('aria-label="Take off air: Topic 2"');
    expect(html).toContain('aria-label="Feature on stream: Topic 1"');
    expect(html).not.toContain("data-live-not-on-grid");
  });

  it("has no buttons without a place for the topic layer, and says when no topic exists", (): void => {
    const html: string = part(stateOf(DEFAULT_LAYERS));
    expect(html).not.toContain("<button");
    expect(html).toContain("The Topic layer is not on the grid, so it cannot show on stream.");
    const none: string = part(stateOf(DEFAULT_LAYERS), []);
    expect(none).toContain("No topics yet.");
    expect(none).not.toContain("data-live-not-on-grid");
  });
});

describe("message banner", (): void => {
  function part(state: OverlayState): string {
    return renderToStaticMarkup(createElement(LiveMessage, { state, busy: false, send }));
  }

  it("offers to put a draft on stream, and not an empty text", (): void => {
    const draft: string = part(
      stateOf(layersWith({ message: { ...onGrid.items.message, enabled: false } }), { message: "BRB" }),
    );
    expect(draft).toContain('value="BRB"');
    expect(draft).toContain("Off air");
    expect(draft).toContain("Put on stream");
    expect(draft).not.toContain("Take off air");
    expect(draft).toMatch(/<button type="submit"[^>]*data-live-message-show="true">/);
    const empty: string = part(stateOf(layersWith({ message: { ...onGrid.items.message, enabled: false } })));
    expect(empty).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it("takes no edit while a save runs, so the form that the save puts here drops none", (): void => {
    const state: OverlayState = stateOf(onGrid, { message: "BRB" });
    const saving: string = renderToStaticMarkup(createElement(LiveMessage, { state, busy: true, send }));
    expect(saving).toMatch(/<input[^>]*readOnly=""[^>]*data-live-message="true"/);
    expect(saving.match(/<button type="button" aria-pressed="(?:true|false)" disabled=""/g)).toHaveLength(2);
    expect(part(state)).not.toContain("readOnly");
  });

  it("offers an update and the way off air for a banner on stream", (): void => {
    const html: string = part(stateOf(onGrid, { message: "BRB", messageStyle: "hype" }));
    expect(html).toContain("On air");
    expect(html).toContain("Update on stream");
    expect(html).toContain("Take off air");
    // Nothing changed yet, so there is nothing to update.
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Hype/);
  });

  it("gives its buttons the class of the buttons that feature a topic, after the state", (): void => {
    const draft: string = part(
      stateOf(layersWith({ message: { ...onGrid.items.message, enabled: false } }), { message: "BRB" }),
    );
    // The state is first in the row, and the styles put the buttons at the end of the row.
    expect(draft).toMatch(
      /<div class="tl-actions tl-air-row"><span class="tl-state">Off air<\/span><button type="submit" class="tl-action"/,
    );
    expect(draft.match(/class="tl-action"/g)).toHaveLength(1);
    const onAir: string = part(stateOf(onGrid, { message: "BRB" }));
    expect(onAir.match(/class="tl-action"/g)).toHaveLength(2);
    expect(onAir.indexOf("data-live-message-show")).toBeLessThan(onAir.indexOf("data-live-message-off"));
    expect(onAir).not.toContain("small-button");
  });

  it("counts a banner on the grid of the output that the editor does not show as on stream", (): void => {
    const html: string = part(stateOf(otherOutput, { message: "BRB" }));
    expect(html).toContain("On air");
    expect(html).toContain("Take off air");
    expect(html).not.toContain("is not on the grid");
  });

  it("sends the owner to the Overlay section when the banner is not on the grid", (): void => {
    const html: string = part(stateOf(DEFAULT_LAYERS, { message: "BRB" }));
    expect(html).toContain("The Message banner layer is not on the grid");
    expect(html).not.toContain("Put on stream");
  });
});

describe("chat panel", (): void => {
  function part(status: ActivityFeed["status"], delivers: boolean): string {
    return renderToStaticMarkup(createElement(LiveChat, { feed: { ...feed, status }, delivers, hideCommands: true }));
  }

  it("starts empty and following, with each platform shown", (): void => {
    const html: string = part("live", true);
    expect(html).toContain('role="log"');
    expect(html).toContain("No messages yet.");
    expect(html).toContain("Pause chat");
    expect(html).not.toContain("Jump to latest");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
    expect(html).not.toContain("data-chat-feed");
    expect(html).not.toContain("data-chat-no-channel");
  });

  it("tells a feed that is not live and a page without a channel that delivers chat", (): void => {
    expect(part("connecting", true)).toContain("Connecting to chat…");
    expect(part("reconnecting", true)).toContain("Chat disconnected, retrying…");
    expect(part("refused", true)).toContain("Chat is not available right now.");
    expect(part("off", true)).toContain("Chat is not available right now.");
    const none: string = part("live", false);
    expect(none).toContain("No channel delivers chat right now.");
    expect(none).toContain('href="/tools?view=channels"');
  });
});

describe("full-screen chat", (): void => {
  const row: LiveChatRow = {
    kind: "chat",
    id: "twitch:m1",
    seq: 1,
    platform: "twitch",
    userId: "u1",
    name: "Viewer 1",
    badges: [],
    fragments: [{ type: "text", text: "hello" }],
    truncated: false,
    receivedAt: 1,
    removed: false,
    command: false,
  };
  const nothing = (): void => undefined;

  function model(more: Partial<ChatModel> = {}): ChatModel {
    return {
      rows: [row],
      paused: false,
      waiting: 0,
      pause: nothing,
      jump: nothing,
      hidden: new Set(),
      toggle: nothing,
      list: nothing,
      scrolled: nothing,
      status: "live",
      ...more,
    };
  }

  function view(more: Partial<Parameters<typeof FullChatView>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(FullChatView, {
        chat: model(),
        delivers: true,
        onAir: null,
        wake: "on",
        step: 2,
        onStep: nothing,
        onExit: nothing,
        ...more,
      }),
    );
  }

  it("has Exit, the text sizes, the platform buttons, the pause and the chat at the selected size", (): void => {
    const html: string = view();
    expect(html).toContain("Exit");
    expect(html).toContain('aria-label="Smaller text"');
    expect(html).toContain('aria-label="Larger text"');
    expect(html.match(/data-chat-filter=/g)).toHaveLength(3);
    expect(html).toContain("Pause chat");
    expect(html).toContain("hello");
    expect(html).toContain("font-size:1.25rem");
    expect(html).not.toContain("data-chat-wake");
    expect(html).not.toContain("data-chat-on-air");
  });

  it("stops the text size buttons at the smallest and the largest size", (): void => {
    expect(view({ step: 0 })).toMatch(/aria-label="Smaller text" disabled=""/);
    expect(view({ step: 0 })).not.toMatch(/aria-label="Larger text" disabled=""/);
    expect(view({ step: 4 })).toMatch(/aria-label="Larger text" disabled=""/);
    expect(view({ step: 4 })).toContain("font-size:2rem");
  });

  it("shows the item on stream in one line, the count of a paused chat, and how to keep the screen on", (): void => {
    const html: string = view({
      onAir: "Tea or coffee",
      chat: model({ paused: true, waiting: 4 }),
      wake: "unsupported",
    });
    expect(html).toContain("On air: Tea or coffee");
    expect(html).toContain("Chat paused. New messages: 4");
    expect(html).toContain("Jump to latest");
    expect(html).toContain("This browser cannot keep the screen on.");
    expect(view({ wake: "off" })).toContain('data-chat-wake="off"');
    expect(view({ delivers: false })).toContain("No channel delivers chat right now.");
  });

  it("names what is on stream: the poll, else the topic, else the message banner", (): void => {
    const topics = [topic(1)];
    const state: OverlayState = stateOf(layersWith({ topic: { ...onGrid.items.topic, ref: "t1" } }), {
      message: "BRB",
    });
    const scene: OverlayScene = sceneOf(state, { data: { ...data, topics } });
    expect(onAirTitle(scene, state.layers)).toBe("Poll p1");
    const noPoll: OverlayLayers = layersWith({ poll: { ...onGrid.items.poll, enabled: false } }, state.layers);
    expect(onAirTitle(scene, noPoll)).toBe("Topic 1");
    const noTopic: OverlayLayers = layersWith({ topic: { ...onGrid.items.topic, enabled: false } }, noPoll);
    expect(onAirTitle(scene, noTopic)).toBe("BRB");
    expect(onAirTitle(sceneOf(stateOf(noTopic)), noTopic)).toBeNull();
    expect(onAirTitle(scene, DEFAULT_LAYERS)).toBeNull();
    // The content of each output is on stream, also of the output that the editor does not show.
    const vertical: OverlayLayers = {
      ...state.layers,
      cells: { horizontal: emptyCells(), vertical: state.layers.cells.horizontal },
    };
    expect(vertical.orientation).toBe("horizontal");
    expect(onAirTitle(scene, vertical)).toBe("Poll p1");
    expect(onAirTitle(scene, layersWith({ poll: { ...onGrid.items.poll, enabled: false } }, vertical))).toBe("Topic 1");
  });

  it("offers the full-screen view from the chat part when the page can open it", (): void => {
    const part = (more: Partial<Parameters<typeof LiveChat>[0]>): string =>
      renderToStaticMarkup(createElement(LiveChat, { feed, delivers: true, hideCommands: true, ...more }));
    expect(part({})).not.toContain("Open chat full screen");
    expect(part({ onFull: nothing })).toContain("Open chat full screen");
    // While the view is open, the page under it has no list.
    expect(part({ onFull: nothing, full: true })).not.toContain('role="log"');
    expect(part({ onFull: nothing, full: false })).toContain('role="log"');
  });
});

describe("support events in the chat", (): void => {
  function supportRow(event: LiveSupportRow["event"], more: Partial<LiveSupportRow> = {}): LiveSupportRow {
    return {
      kind: "support",
      id: `twitch:${event}`,
      seq: 1,
      event,
      platform: "twitch",
      name: "Viewer 1",
      amount: null,
      currency: null,
      text: null,
      receivedAt: 1,
      ...more,
    };
  }
  const line = (event: LiveSupportRow["event"], more: Partial<LiveSupportRow> = {}): string =>
    supportLine(supportRow(event, more));
  const nothing = (): void => undefined;

  afterEach((): void => {
    setLocaleSource((): Locale => DEFAULT_LOCALE);
  });

  it("says what each kind is, with its amount", (): void => {
    expect(line("follow")).toBe("followed");
    expect(line("subscription", { amount: 1 })).toBe("subscribed");
    expect(line("subscription", { amount: 14 })).toBe("subscribed for 14 months");
    expect(line("membership", { amount: 1 })).toBe("became a member");
    expect(line("membership", { amount: 2 })).toBe("member for 2 months");
    expect(line("gift", { amount: 1 })).toBe("gave 1 subscription");
    expect(line("gift", { amount: 5, platform: "kick" })).toBe("gave 5 subscriptions");
    expect(line("gift", { amount: 5, platform: "youtube" })).toBe("gave 5 memberships");
    expect(line("raid", { amount: 1200 })).toBe("raid with 1,200 viewers");
    expect(line("bits", { amount: 100 })).toBe("100 Bits");
    expect(line("bits", { amount: 1 })).toBe("1 Bit");
    expect(line("kicks", { amount: 50 })).toBe("50 KICKs");
    expect(line("reactions", { amount: 3 })).toBe("3 reactions");
  });

  it("shows money in its currency, from micros", (): void => {
    expect(line("super_chat", { amount: 5_000_000, currency: "USD" })).toBe("Super Chat: $5.00");
    expect(line("super_sticker", { amount: 1_990_000, currency: "EUR" })).toBe("Super Sticker: €1.99");
    expect(line("tip", { amount: 500_000_000, currency: "JPY", platform: "direct" })).toBe("tip: ¥500");
    // An event without a currency is not valid in the feed. Its amount still shows as a number.
    expect(line("tip", { amount: 2_500_000 })).toBe("tip: 2.5");
  });

  it("has a line for each kind of support event", (): void => {
    const lines: string[] = SUPPORT_KINDS.map((kind) => line(kind, { amount: 2_000_000, currency: "USD" }));
    expect(new Set(lines).size).toBe(SUPPORT_KINDS.length);
    for (const text of lines) expect(text).not.toBe("");
  });

  it("follows the plural rules and the money format of the language", async (): Promise<void> => {
    await Promise.all([loadCatalog("ru"), loadCatalog("de")]);
    setLocaleSource((): Locale => "ru");
    expect(line("gift", { amount: 1 })).toBe("дарит 1 подписку");
    expect(line("gift", { amount: 3 })).toBe("дарит 3 подписки");
    expect(line("gift", { amount: 5 })).toBe("дарит 5 подписок");
    setLocaleSource((): Locale => "de");
    expect(line("super_chat", { amount: 5_000_000, currency: "EUR" })).toBe("Super Chat: 5,00\u00a0€");
  });

  it("shows a support row with the platform, the supporter, the line and the text as text", (): void => {
    const rows: LiveSupportRow[] = [
      supportRow("bits", { id: "twitch:d1", name: null, amount: 100, text: "<b>gg</b>" }),
      supportRow("follow", { id: "kick:d2", seq: 2, platform: "kick" }),
      supportRow("tip", { id: "direct:d3", seq: 3, platform: "direct", amount: 3_000_000, currency: "USD" }),
    ];
    const html: string = renderToStaticMarkup(
      createElement(FullChatView, {
        chat: {
          rows,
          paused: false,
          waiting: 0,
          pause: nothing,
          jump: nothing,
          hidden: new Set<ActivityPlatform>(),
          toggle: nothing,
          list: nothing,
          scrolled: nothing,
          status: "live",
        },
        delivers: true,
        onAir: null,
        wake: "on",
        step: 2,
        onStep: nothing,
        onExit: nothing,
      }),
    );
    const items: string[] = html.split("<li ").slice(1);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain('class="tl-chat-row tl-support" data-chat-row="support:twitch:d1" data-support="bits"');
    expect(items[0]).toContain('<span class="sr-only">Twitch </span>');
    expect(items[0]).toContain("<bdi>Anonymous</bdi>");
    expect(items[0]).toContain('<span class="tl-support-line">100 Bits</span>');
    // The text of the supporter is untrusted: it is text, never markup.
    expect(items[0]).toContain('<span class="tl-chat-text" dir="auto">&lt;b&gt;gg&lt;/b&gt;</span>');
    expect(items[1]).toContain('data-platform="kick"');
    expect(items[1]).toContain("<bdi>Viewer 1</bdi>");
    expect(items[1]).toContain('<span class="tl-support-line">followed</span>');
    expect(items[1]).not.toContain("tl-chat-text");
    // A direct tip is from no platform: it has no platform icon.
    expect(items[2]).toContain('data-platform="direct"');
    expect(items[2]).not.toContain("sr-only");
    expect(items[2]).toContain("icon-heart");
  });
});

describe("Live section", (): void => {
  const connection = { displayName: "host", code: null, connectedAt: 1, lastEventAt: null, updatedAt: 1 };
  const channels: ChannelView[] = [
    {
      platform: "twitch",
      available: true,
      connection: { ...connection, status: "active" },
      support: false,
    },
    {
      platform: "youtube",
      available: true,
      connection: { ...connection, status: "error" },
      support: false,
    },
    { platform: "kick", available: true, connection: null, support: false },
  ];

  function section(more: Partial<Parameters<typeof LiveSection>[0]> = {}): string {
    const state: OverlayState = stateOf(onGrid);
    return renderToStaticMarkup(
      createElement(LiveSection, { initial: state, scene: sceneOf(state), channels, ...more }),
    );
  }

  it("tells the health of each channel and the state of OBS in words", (): void => {
    const html: string = section({ sources: { count: 2, seenAt: 900 } });
    expect(html).toContain("Twitch: connected");
    expect(html).toContain("YouTube: needs attention.");
    expect(html).toContain("This channel has a problem. Reconnect to try again.");
    expect(html).toContain("Kick: not connected");
    expect(html).toContain("OBS is connected: 2 sources.");
    expect(section()).toContain("The state of OBS shows when live updates connect.");
  });

  it("has each part, and the preview of what OBS shows", (): void => {
    const html: string = section();
    for (const part of ["status", "preview", "poll", "topics", "message", "chat"])
      expect(html, part).toContain(`data-live-part="${part}"`);
    expect(html).toContain("Changes reach OBS at once.");
    expect(html).not.toContain("ov-conn");
    const empty: string = section({ initial: stateOf(DEFAULT_LAYERS) });
    expect(empty).toContain("No layer is on stream.");
  });

  it("has a link to the Overlay section beside the title of the preview, and only there", (): void => {
    const html: string = section();
    const preview: string = html.split('data-live-part="preview"')[1].split("</section>")[0];
    // The title and the link are one line. The link has only an icon, so its name is also its tooltip.
    expect(preview).toMatch(
      /^><div class="tl-part-head"><h2 class="ov-step-title" id="[^"]+">What OBS shows<\/h2><a class="icon-button" aria-label="Edit the overlay" title="Edit the overlay" href="\/tools\?view=overlay"><svg[^>]*icon-pencil/,
    );
    expect(html.match(/class="tl-part-head"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Edit the overlay"/g)).toHaveLength(1);
    // The preview stays read-only: it has no button and no field.
    expect(preview).not.toMatch(/<button|<input|<select|<textarea/);
  });

  it("names the link to the Overlay section in each language", async (): Promise<void> => {
    await Promise.all(LOCALES.map((locale: Locale) => loadCatalog(locale)));
    const names: Set<string> = new Set();
    try {
      for (const locale of LOCALES) {
        setLocaleSource((): Locale => locale);
        const name: string = /class="icon-button" aria-label="([^"]+)"/.exec(section())?.[1] ?? "";
        expect(name, locale).not.toBe("");
        expect(name, locale).not.toContain("!");
        names.add(name);
      }
    } finally {
      setLocaleSource((): Locale => DEFAULT_LOCALE);
    }
    // Each language has its own text: no catalog has the English text as a placeholder.
    expect(names.size).toBe(LOCALES.length);
  });

  it("marks the window of the camera frame in the preview", (): void => {
    const framed: OverlayLayers = {
      ...onGrid,
      camera: { enabled: true },
      cells: { ...onGrid.cells, horizontal: { ...onGrid.cells.horizontal, camera: { c: 20, r: 12, w: 12, h: 6 } } },
    };
    expect(section({ initial: stateOf(framed) })).toContain("Your OBS camera shows here");
  });

  it("says that live updates are away, and offers a reconnect when the page stopped trying", (): void => {
    expect(section({ connected: false })).toContain("Overlay disconnected, retrying…");
    const offline: string = section({ connected: false, reconnect: (): void => undefined });
    expect(offline).toContain("Live updates offline.");
    expect(offline).toContain("Reconnect");
  });

  it("leaves out a platform that this site does not offer", (): void => {
    const off: ChannelView[] = [
      {
        platform: "kick",
        available: false,
        connection: { ...connection, status: "active" },
        support: false,
      },
    ];
    expect(section({ channels: off })).not.toContain("Kick:");
  });
});
