import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActivityFeed } from "../app/components/overlay/activity-feed";
import type { OverlayPoll, OverlayScene } from "../app/components/overlay/overlay-stage";
import type { ControlAction } from "../app/components/overlay/use-overlay-state";
import { FullChatView, LiveChat, type ChatModel } from "../app/components/tools/live-chat";
import { LiveMessage } from "../app/components/tools/live-message";
import { NotOnGrid, placed } from "../app/components/tools/live-part";
import { LivePoll } from "../app/components/tools/live-poll";
import { LiveSection, onAirTitle } from "../app/components/tools/live-section";
import { LIVE_TOPICS, LiveTopics, liveTopics } from "../app/components/tools/live-topics";
import type { ChannelView } from "../app/lib/channel-health";
import type { LiveChatRow } from "../app/lib/live-chat";
import { DEFAULT_LAYERS, emptyCells, type CellRect, type OverlayLayers } from "../app/lib/overlay-layers";
import type { OverlayData, OverlayState } from "../app/types";

// The Live section of Streamer tools, as the server renders it for each on-air state.

const cell = (c: number): CellRect => ({ c, r: 0, w: 4, h: 2 });
/** The poll, the topic and the message banner on the grid of the horizontal orientation. */
const onGrid: OverlayLayers = {
  ...DEFAULT_LAYERS,
  cells: { horizontal: { ...emptyCells(), poll: cell(0), topic: cell(4), message: cell(8) }, vertical: emptyCells() },
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

  it("sends the owner to the Overlay section when the poll layer is not on the grid", (): void => {
    const html: string = pollPart(stateOf(DEFAULT_LAYERS));
    expect(html).toContain("The Poll layer is not on the grid, so it cannot show on stream.");
    expect(html).toContain('href="/tools?view=overlay"');
    expect(html).not.toContain("Put on air");
    expect(placed(DEFAULT_LAYERS, "poll")).toBe(false);
    expect(placed(onGrid, "poll")).toBe(true);
    // The cell of the other orientation does not count.
    expect(placed({ ...onGrid, orientation: "vertical" }, "poll")).toBe(false);
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

  it("offers an update and the way off air for a banner on stream", (): void => {
    const html: string = part(stateOf(onGrid, { message: "BRB", messageStyle: "hype" }));
    expect(html).toContain("On air");
    expect(html).toContain("Update on stream");
    expect(html).toContain("Take off air");
    // Nothing changed yet, so there is nothing to update.
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Hype/);
  });

  it("sends the owner to the Overlay section when the banner is not on the grid", (): void => {
    const html: string = part(stateOf(DEFAULT_LAYERS, { message: "BRB" }));
    expect(html).toContain("The Message banner layer is not on the grid");
    expect(html).not.toContain("Put on stream");
  });
});

describe("chat panel", (): void => {
  function part(status: ActivityFeed["status"], delivers: boolean): string {
    return renderToStaticMarkup(createElement(LiveChat, { feed: { ...feed, status }, delivers, now: 0 }));
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
  });

  it("offers the full-screen view from the chat part when the page can open it", (): void => {
    const part = (more: Partial<Parameters<typeof LiveChat>[0]>): string =>
      renderToStaticMarkup(createElement(LiveChat, { feed, delivers: true, now: 0, ...more }));
    expect(part({})).not.toContain("Open chat full screen");
    expect(part({ onFull: nothing })).toContain("Open chat full screen");
    // While the view is open, the page under it has no list.
    expect(part({ onFull: nothing, full: true })).not.toContain('role="log"');
    expect(part({ onFull: nothing, full: false })).toContain('role="log"');
  });
});

describe("Live section", (): void => {
  const connection = { displayName: "host", code: null, connectedAt: 1, lastEventAt: null, updatedAt: 1 };
  const channels: ChannelView[] = [
    { platform: "twitch", available: true, connection: { ...connection, status: "active" } },
    { platform: "youtube", available: true, connection: { ...connection, status: "error" } },
    { platform: "kick", available: true, connection: null },
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

  it("says that live updates are away, and offers a reconnect when the page stopped trying", (): void => {
    expect(section({ connected: false })).toContain("Overlay disconnected, retrying…");
    const offline: string = section({ connected: false, reconnect: (): void => undefined });
    expect(offline).toContain("Live updates offline.");
    expect(offline).toContain("Reconnect");
  });

  it("leaves out a platform that this site does not offer", (): void => {
    const off: ChannelView[] = [
      { platform: "kick", available: false, connection: { ...connection, status: "active" } },
    ];
    expect(section({ channels: off })).not.toContain("Kick:");
  });
});
