import { createElement, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import { ChannelPanel, type ChannelView } from "../app/components/channels/channel-panel";
import { ChatDeliveryContext } from "../app/components/channels/use-live-channels";
import type { CharactersControl } from "../app/components/overlay/characters-controls";
import { ChatLayer, chatStyle, shortName } from "../app/components/overlay/chat-layer";
import { LayerPalette } from "../app/components/overlay/layer-palette";
import { LayerProperties, OVERLAY_MESSAGE_MAX } from "../app/components/overlay/layer-properties";
import { LAYER_NAMES, LayoutGrid, type LayoutGridHandle } from "../app/components/overlay/layout-grid";
import { CharactersSlot, OverlayComposition, usesDesignCanvas } from "../app/components/overlay/overlay-composition";
import { controlState, OverlayControl } from "../app/components/overlay/overlay-control";
import { sourcesText } from "../app/components/overlay/overlay-link";
import {
  OverlayStage,
  optionColumns,
  overlayPoll,
  qrTarget,
  type OverlayPoll,
  type OverlayScene,
} from "../app/components/overlay/overlay-stage";
import { QR_MIN, QrCode, qrSide } from "../app/components/overlay/qr-code";
import { StudioTest } from "../app/components/overlay/studio-test";
import { t } from "../app/i18n";
import type { ChatRow } from "../app/lib/chat-feed";
import {
  DEFAULT_LAYERS,
  GRID_LAYERS,
  emptyCells,
  type ContentSource,
  type GridLayer,
  type OverlayLayer,
  type OverlayLayers,
} from "../app/lib/overlay-layers";
import type { OverlayData, OverlayState } from "../app/types";

const data: OverlayData = { polls: [], topics: [], cards: [], next: null, support: null };
/** The chat and the poll on the grid. The chat is off stream. */
const placed: OverlayLayers = {
  ...DEFAULT_LAYERS,
  cells: {
    horizontal: { ...emptyCells(), chat: { c: 0, r: 0, w: 10, h: 14 }, poll: { c: 10, r: 0, w: 22, h: 14 } },
    vertical: emptyCells(),
  },
};
const state: OverlayState = {
  showResults: true,
  message: "Draft message",
  messageStyle: "info",
  layers: placed,
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
const populated: OverlayData = {
  ...data,
  polls: [
    { id: "poll", title: "Poll", mash: false, author: "Host", byOwner: true },
    { id: "battle", title: "Battle", mash: true, author: "Host", byOwner: true },
    { id: "viewer-poll", title: "Viewer poll", mash: false, author: "Viewer", byOwner: false },
  ],
  topics: [{ id: "topic", title: "Topic", category: "", author: "Viewer", avatar: null, avatarPreset: null, likes: 0 }],
  cards: [
    { id: "card", icon: null, title: "First card", body: "", label: null, target: null },
    { id: "card-2", icon: null, title: "Second card", body: "", label: null, target: null },
  ],
};

function stage(source: ContentSource, override: Partial<OverlayScene> = {}, qr: boolean = false): string {
  return renderToStaticMarkup(createElement(OverlayStage, { scene: { ...scene, ...override }, source, qr }));
}

function poll(id: string, override: Partial<OverlayPoll> = {}): OverlayPoll {
  return {
    id,
    title: id,
    kind: "choice",
    options: ["Tea", "Coffee"],
    endsAt: null,
    revealed: false,
    counts: [0, 0],
    total: 0,
    mash: null,
    byOwner: true,
    ...override,
  };
}

function nothing(): void {
  // A handler that a static render never calls.
}

/** The character playground as the editor reads it. No request runs in a static render. */
function playground(override: Partial<CharactersControl> = {}): CharactersControl {
  return {
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
    ...override,
  };
}

describe("overlay control page", () => {
  function control(initial: OverlayState = state, connected: boolean = true): string {
    return renderToStaticMarkup(createElement(OverlayControl, { initial, scene, hasOverlayKey: false, connected }));
  }

  it("has the studio as step 2 and the OBS link as step 3, without the old live control", () => {
    const html: string = control();
    expect(html).toContain('<span class="ov-step-num">2</span> Build your overlay</h2>');
    expect(html).toContain('<span class="ov-step-num">3</span> Add to OBS</h2>');
    expect(html.match(/class="ov-step-num"/g)).toHaveLength(2);
    expect(html).toContain("Changes go live right away");
    for (const gone of ["data-ov-monitor", "data-ov-take", "ov-take-dock", "ov-sources", "<kbd", "Instant switch"])
      expect(html, gone).not.toContain(gone);
    for (const text of ["Preview:", "On air", "Position", "Shortcuts", "On-air content", ">Auto<", ">Hidden<"])
      expect(html, text).not.toContain(text);
  });

  it("shows the OBS connection of a page that has an overlay link", () => {
    const html = (hasOverlayKey: boolean, count: number): string =>
      renderToStaticMarkup(
        createElement(OverlayControl, { initial: state, scene, hasOverlayKey, sources: { count, seenAt: null } }),
      );
    expect(html(true, 2)).toContain('data-ov-sources="2"');
    expect(html(true, 2)).toContain("OBS is connected: 2 sources.");
    expect(html(true, 0)).toContain("OBS did not connect yet.");
    expect(html(false, 2)).not.toContain("data-ov-sources");
    expect(sourcesText({ count: 1, seenAt: 0 }, 0)).toBe("OBS is connected: 1 source.");
    expect(sourcesText({ count: 0, seenAt: 1000 }, 181_000)).toBe("OBS is not connected. Last seen 3 minutes ago.");
    expect(sourcesText({ count: 0, seenAt: 1000 }, 1000)).toBe("OBS is not connected. Last seen just now.");
  });

  it("offers each layer one time in the palette and marks the layers on the grid", () => {
    const html: string = control();
    const chips: string[] = [...html.matchAll(/<button type="button" class="ov-palette-chip"[^>]*>/g)].map(
      (match: RegExpMatchArray): string => match[0],
    );
    expect(chips.map((chip: string): string | undefined => /data-comp-layer="([a-z]+)"/.exec(chip)?.[1])).toEqual([
      ...GRID_LAYERS,
    ]);
    const marked: boolean[] = chips.map((chip: string): boolean => chip.includes('data-placed="true"'));
    expect(marked).toEqual([true, false, true, false, false, false, false, false]);
    for (const name of ["Chat", "Characters", "Poll", "Topic", "Up next", "Message banner", "Community card"])
      expect(html).toContain(`<span class="ov-palette-name">${name}</span>`);
    expect(html).toContain('<span class="ov-palette-name">Support banner</span>');
    expect(html.match(/class="ov-palette-placed">Placed</g)).toHaveLength(2);
    // A placed chip is a toggle for the selection. A chip of a layer off the grid adds the layer.
    expect(chips[0]).toContain('aria-pressed="false"');
    expect(chips[1]).not.toContain("aria-pressed");
  });

  it("starts with no layer selected, and the test needs a layer on stream", () => {
    const html: string = control();
    expect(html).toContain('data-comp-props=""');
    expect(html).toContain("No layer selected");
    expect(html).toContain("Select a layer on the grid to change it.");
    expect(html).not.toContain("data-props-remove");
    expect(html).toMatch(
      /<button type="button" aria-disabled="true" aria-describedby="[^"]+" data-test-toggle="true">Start test</,
    );
    expect(html).toContain("Put Chat or Characters on stream to start the test.");
    // The chat is on the grid and off stream: its box is dimmed and the preview has no chat.
    expect(html).toMatch(/data-grid-box="chat"[^>]* data-off="true"/);
    expect(html).not.toMatch(/data-grid-box="poll"[^>]* data-off/);
    expect(html).not.toContain('class="ov-layer" data-layer="chat"');
    expect(html).toContain('class="ov-layer" data-layer="poll"');
    expect(html).not.toContain("data-comp-sample");
  });

  it("makes the test available and names the sample chat while the chat is on stream", () => {
    const on: OverlayLayers = { ...placed, chat: { ...placed.chat, enabled: true } };
    const html: string = control({ ...state, layers: on });
    expect(html).toMatch(
      /<button type="button" aria-disabled="false" aria-describedby="[^"]+" data-test-toggle="true">Start test</,
    );
    expect(html).toContain("Shows sample chat for 60 seconds and sample viewers as characters for 5 minutes in OBS.");
    expect(html).toContain("The preview shows sample messages, not your chat.");
    expect(html).toContain('class="ov-layer" data-layer="chat"');
  });

  it("tells a disconnected owner that the overlay retries, without a reconnect button", () => {
    const html: string = control(state, false);
    expect(html).toContain("Overlay disconnected, retrying");
    expect(html).not.toContain(">Reconnect</button>");
    expect(control()).not.toContain("Overlay disconnected");
  });

  it("keeps the message draft when newer public state arrives and ignores stale updates", () => {
    const loaded: OverlayState = { ...state, revision: 2, message: "Unsaved banner" };
    const live: OverlayState = { ...state, revision: 3, message: "", showResults: false, chatTestUntil: 5 };
    expect(controlState(state, loaded, live)).toEqual({ ...live, message: "Unsaved banner" });
    expect(controlState(loaded, state, state)).toBe(loaded);
    expect(controlState(state, loaded, null)).toBe(loaded);
    const cells = { ...placed.cells, horizontal: { ...placed.cells.horizontal, message: { c: 0, r: 14, w: 8, h: 4 } } };
    const onStream: OverlayState = { ...live, layers: { ...placed, cells }, message: "On stream" };
    expect(controlState(state, loaded, onStream).message).toBe("On stream");
  });
});

describe("settings of the selected layer", () => {
  function settings(
    layer: GridLayer | null,
    options: { layers?: OverlayLayers; data?: OverlayData; state?: OverlayState; characters?: CharactersControl } = {},
  ): string {
    return renderToStaticMarkup(
      createElement(LayerProperties, {
        layer,
        layers: options.layers ?? placed,
        state: options.state ?? state,
        data: options.data ?? populated,
        busy: false,
        run: nothing,
        change: nothing,
        characters: options.characters ?? playground(),
        onRemove: nothing,
      }),
    );
  }
  const withItem = (layer: "poll" | "topic" | "card" | "message" | "next", item: object): OverlayLayers => ({
    ...placed,
    items: { ...placed.items, [layer]: { ...placed.items[layer], ...item } },
  });

  it("shows a hint without a layer", () => {
    const html: string = settings(null);
    expect(html).toContain('data-comp-props=""');
    expect(html).toContain("No layer selected");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
  });

  it.each(GRID_LAYERS)("names the %s layer and offers Show on stream and Remove from grid", (layer: GridLayer) => {
    const html: string = settings(layer);
    expect(html).toContain(`data-comp-props="${layer}"`);
    expect(html).toContain("Selected layer");
    expect(html).toMatch(new RegExp(`<h3 class="ov-props-name" id="[^"]+">${t(LAYER_NAMES[layer])}</h3>`));
    expect(html).toContain("Show on stream");
    expect(html).toMatch(/<button type="button" data-props-remove="true">Remove from grid<\/button>/);
    // The characters have no background. The chat, the characters and the message banner have no QR code.
    expect(html.includes("data-props-background")).toBe(layer !== "characters");
    expect(html.includes("data-props-qr")).toBe(layer !== "chat" && layer !== "characters" && layer !== "message");
  });

  it("warns in the chat settings when the chat is on stream and no channel delivers chat", () => {
    const chatSettings = (enabled: boolean, delivers: boolean): string =>
      renderToStaticMarkup(
        createElement(
          ChatDeliveryContext.Provider,
          { value: delivers },
          createElement(LayerProperties, {
            layer: "chat",
            layers: { ...placed, chat: { ...placed.chat, enabled } },
            state,
            data: populated,
            busy: false,
            run: nothing,
            change: nothing,
            characters: playground(),
            onRemove: nothing,
          }),
        ),
      );
    const warning: string = chatSettings(true, false);
    expect(warning).toMatch(
      /<p class="ch-problem ov-comp-note" data-comp-chat-down="true"><svg[^>]*icon-warning[^>]*>.*?<\/svg><span>No channel delivers chat right now\. See <a class="text-link" href="#channels-title">step 1<\/a>\.<\/span><\/p>/,
    );
    // Off stream, with a healthy channel, or without live channel data, the line does not show.
    expect(chatSettings(false, false)).not.toContain("data-comp-chat-down");
    expect(chatSettings(true, true)).not.toContain("data-comp-chat-down");
    expect(settings("chat", { layers: { ...placed, chat: { ...placed.chat, enabled: true } } })).not.toContain(
      "data-comp-chat-down",
    );
  });

  it("reads Show on stream from the layer", () => {
    const shown = (html: string): boolean => html.includes('data-props-show="true" checked=""');
    expect(shown(settings("chat"))).toBe(false);
    expect(shown(settings("chat", { layers: { ...placed, chat: { ...placed.chat, enabled: true } } }))).toBe(true);
    expect(shown(settings("characters"))).toBe(false);
    expect(shown(settings("poll"))).toBe(true);
    expect(shown(settings("poll", { layers: withItem("poll", { enabled: false }) }))).toBe(false);
  });

  it("offers the latest active poll and the polls of the page, and the results switch", () => {
    // The picker shows the icon of its value. A static render has no value text.
    const icon = (html: string): string | undefined =>
      /class="cselect-icon"[^>]*><svg[^>]*class="[^"]*icon-20 (icon-[a-z-]+)/.exec(html)?.[1];
    const html: string = settings("poll");
    expect(html).toContain('role="combobox"');
    expect(html).toMatch(/<span class="field-label" id="[^"]+">Poll<\/span>/);
    // Without a ref the layer shows the latest active poll.
    expect(icon(html)).toBe("icon-polls");
    expect(icon(settings("poll", { layers: withItem("poll", { ref: "poll" }) }))).toBe("icon-poll-choice");
    expect(icon(settings("poll", { layers: withItem("poll", { ref: "battle" }) }))).toBe("icon-zap");
    // A poll that the page no longer has shows no value.
    expect(icon(settings("poll", { layers: withItem("poll", { ref: "gone" }) }))).toBeUndefined();
    expect(html).toContain('data-props-results="true" checked=""');
    expect(html).toContain("Show results");
    const hidden: string = settings("poll", { state: { ...state, showResults: false } });
    expect(hidden).toContain('data-props-results="true"/>');
    // A page without polls keeps the automatic choice and says how to get a poll.
    const empty: string = settings("poll", { data });
    expect(icon(empty)).toBe("icon-polls");
    expect(empty).toContain("Create a poll or Mash Battle on your page first.");
    expect(html).not.toContain("Create a poll or Mash Battle on your page first.");
  });

  it.each([
    ["topic", "No topics yet."],
    ["card", "Add Community cards from Edit your page first."],
  ] as const)("explains an empty %s picker", (layer, message) => {
    const html: string = settings(layer, { data });
    expect(html).toContain(message);
    expect(html).not.toContain('role="combobox"');
    expect(settings(layer)).toContain('role="combobox"');
    expect(settings(layer)).not.toContain(message);
  });

  it("shows the icon of the picked topic, and no value for a topic layer without a topic", () => {
    expect(settings("topic")).not.toContain("cselect-icon");
    expect(settings("topic", { layers: withItem("topic", { ref: "topic" }) })).toContain("icon-topics");
    expect(settings("card")).toMatch(/<span class="field-label" id="[^"]+">Community card<\/span>/);
  });

  it("edits the message with its limit and its style", () => {
    const html: string = settings("message");
    expect(OVERLAY_MESSAGE_MAX).toBe(120);
    expect(html).toContain("Message (up to 120 characters)");
    expect(html).toMatch(/<input id="[^"]+" maxLength="120" data-ov-message="true" value="Draft message"\/>/);
    expect(html).toMatch(/<button type="button" aria-pressed="true">Info<\/button>/);
    expect(html).toMatch(/<button type="button" aria-pressed="false">Hype<\/button>/);
    // Nothing to save until the text changes.
    expect(html).toMatch(/<button type="submit" class="small-button" disabled="">/);
    const hype: string = settings("message", { state: { ...state, messageStyle: "hype" } });
    expect(hype).toMatch(/<button type="button" aria-pressed="true">Hype<\/button>/);
  });

  it("gives Up next and the support banner no settings of their own", () => {
    for (const layer of ["next", "support"] as const) {
      const html: string = settings(layer);
      expect(html).not.toContain('role="combobox"');
      // "Show on stream", the QR code switch and the background.
      expect(html.match(/<input/g)).toHaveLength(3);
    }
  });

  it("offers the QR code switch on each content layer with a page, with the saved value and a hint", () => {
    const poll: string = settings("poll");
    // The poll layer shows a QR code by default.
    expect(poll).toMatch(
      /<input type="checkbox" aria-describedby="([^"]+)" data-props-qr="true" checked=""\/><span>Show QR code<\/span>/,
    );
    expect(poll).toMatch(
      /<p class="muted ov-comp-note" id="[^"]+">Viewers scan it with a phone to open this item\.<\/p>/,
    );
    expect(settings("poll", { layers: withItem("poll", { qr: false }) })).toContain('data-props-qr="true"/>');
    for (const layer of ["topic", "next", "card", "support"] as const)
      expect(settings(layer), layer).toContain('data-props-qr="true"/><span>Show QR code</span>');
    expect(settings("next", { layers: withItem("next", { qr: true }) })).toContain('data-props-qr="true" checked=""/>');
    // No page to open: the message banner, the chat and the characters.
    for (const layer of ["message", "chat", "characters"] as const)
      expect(settings(layer), layer).not.toContain("data-props-qr");
  });

  it("shows the background of a content layer and of the chat as a range with its value", () => {
    const poll: string = settings("poll", { layers: withItem("poll", { backgroundOpacity: 45 }) });
    expect(poll).toMatch(
      /<input id="[^"]+" type="range" min="0" max="100" step="5" aria-valuetext="45%"[^>]* value="45"\/>/,
    );
    expect(poll).toContain(">Background</label>");
    expect(poll).toContain('data-props-background-value="true">45%</span>');
    const chat: string = settings("chat", { layers: { ...placed, chat: { ...placed.chat, backgroundOpacity: 0 } } });
    expect(chat).toContain(">Message background</label>");
    expect(chat).toContain('aria-valuetext="0%"');
  });

  it("keeps the chat settings on the chat layer", () => {
    const html: string = settings("chat");
    expect(html).toContain("Hide chat commands (!jump)");
    expect(html).toContain('data-props-commands="true" checked=""');
    expect(html).toContain('<a class="text-link" href="#channels-title">Connect channels</a>');
    expect(settings("poll")).not.toContain("data-props-commands");
  });

  it("keeps the characters settings on the characters layer, without a test button of their own", () => {
    const off: string = settings("characters");
    expect(off).toContain("Each viewer who chats gets a character.");
    expect(off).toContain("data-characters-timeout");
    expect(off).toMatch(/>Maximum characters on screen<\/label><input id="[^"]+" type="text" inputMode="numeric"/);
    expect(off).toMatch(/aria-describedby="[^"]+" data-characters-max="true" value="40"\/>/);
    expect(off).toContain("A whole number from 5 to 40. Saved when you leave the field or press Enter.");
    const lowered: string = settings("characters", {
      layers: { ...placed, characters: { ...placed.characters, max: 12 } },
    });
    expect(lowered).toMatch(/data-characters-max="true" value="12"\/>/);
    expect(off).toMatch(
      /<button type="button" aria-disabled="true" aria-describedby="[^"]+" data-characters-pause="true">Pause</,
    );
    expect(off).toContain("data-characters-needs-layer");
    expect(off).toContain("Turn on “Show on stream” to see the characters here.");
    expect(off).not.toContain("data-characters-test-toggle");
    expect(off).not.toMatch(/Start (characters )?test/);
    const on: string = settings("characters", { characters: playground({ enabled: true, paused: true }) });
    expect(on).toMatch(/<button type="button" aria-disabled="false" data-characters-pause="true">Resume</);
    expect(on).toContain("data-characters-paused");
    expect(on).not.toContain("data-characters-needs-layer");
    const errors: string = settings("characters", {
      characters: playground({ off: true, statusError: "No answer", busy: true, enabled: true }),
    });
    expect(errors).toContain("Characters are off on this server.");
    expect(errors).toContain("Cannot read the state of the playground: No answer");
    expect(errors).toMatch(/aria-disabled="true" data-characters-reset="true"/);
  });
});

describe("the test control", () => {
  function test(options: { chatOn?: boolean; chatUntil?: number; characters?: Partial<CharactersControl> }): string {
    return renderToStaticMarkup(
      createElement(StudioTest, {
        chatUntil: options.chatUntil ?? 0,
        now: 1000,
        chatOn: options.chatOn ?? false,
        characters: playground(options.characters),
        onSaved: nothing,
      }),
    );
  }
  const status = (html: string): string | undefined => /data-test-status="true">([^<]*)</.exec(html)?.[1];
  const label = (html: string): string | undefined => /data-test-toggle="true">([^<]*)</.exec(html)?.[1];
  const unavailable = (html: string): boolean => html.includes('aria-disabled="true"');

  it("needs the chat or the characters on stream", () => {
    const html: string = test({});
    expect(label(html)).toBe("Start test");
    expect(unavailable(html)).toBe(true);
    expect(status(html)).toBe("Put Chat or Characters on stream to start the test.");
    // The news region is empty until the test starts or stops.
    expect(html).toContain('<p class="sr-only" aria-live="polite" data-test-news="true"></p>');
  });

  it("is available with one of the two layers on stream", () => {
    for (const options of [{ chatOn: true }, { characters: { enabled: true } }]) {
      const html: string = test(options);
      expect(label(html)).toBe("Start test");
      expect(unavailable(html)).toBe(false);
      expect(status(html)).toBe(
        "Shows sample chat for 60 seconds and sample viewers as characters for 5 minutes in OBS. " +
          "Nothing goes to your channels. Viewers see a TEST badge.",
      );
    }
    // A paused playground resumes with the test.
    expect(status(test({ characters: { enabled: true, paused: true } }))).toContain(
      "Starting the test resumes the playground.",
    );
    expect(status(test({ chatOn: true, characters: { paused: true } }))).not.toContain("resumes");
  });

  it("ignores presses while a request of the playground runs", () => {
    expect(unavailable(test({ chatOn: true, characters: { busy: true } }))).toBe(true);
  });

  it("offers Stop and counts down the longer of the two tests", () => {
    const chat: string = test({ chatOn: true, chatUntil: 31_000 });
    expect(label(chat)).toBe("Stop test");
    expect(unavailable(chat)).toBe(false);
    expect(status(chat)).toBe("The test runs in OBS. 30 s left.");
    const both: string = test({
      chatUntil: 31_000,
      characters: { enabled: true, testRunning: true, testLeft: 240_500 },
    });
    expect(status(both)).toBe("The test runs in OBS. 241 s left.");
    // A test can stop also after its layer went off stream.
    expect(label(test({ characters: { testRunning: true, testLeft: 9_000 } }))).toBe("Stop test");
    expect(unavailable(test({ characters: { testRunning: true, testLeft: 9_000 } }))).toBe(false);
    // Another tab started the characters test: its end is not known here.
    expect(status(test({ characters: { enabled: true, testRunning: true } }))).toBe("The test runs in OBS.");
  });
});

describe("layer palette and layout grid", () => {
  const grid: RefObject<LayoutGridHandle | null> = { current: null };

  function palette(selected: GridLayer | null, drop: "ready" | "over" | null = null): string {
    return renderToStaticMarkup(
      createElement(LayerPalette, { placed: ["chat", "poll"], selected, grid, onSelect: nothing, drop }),
    );
  }

  it("marks the selected chip and shows the drop place while a layer is carried", () => {
    expect(palette(null)).toContain("Layers · one of each");
    expect(palette(null)).not.toContain('aria-pressed="true"');
    const selected: string = palette("poll");
    expect(selected).toMatch(/data-comp-layer="poll" data-placed="true" aria-pressed="true"/);
    expect(selected).toMatch(/data-comp-layer="chat" data-placed="true" aria-pressed="false"/);
    // A selection that is off the grid marks no chip.
    expect(palette("topic")).not.toContain('aria-pressed="true"');
    expect(palette(null)).not.toContain("data-comp-palette-drop");
    expect(palette(null, "ready")).toMatch(/data-drop="ready".*Drop here to remove/);
    expect(palette(null, "over")).toContain('data-drop="over"');
  });

  function layout(layers: OverlayLayers, selected: GridLayer | null): string {
    return renderToStaticMarkup(
      createElement(LayoutGrid, {
        layers,
        scene,
        background: "checker",
        charactersFeed: null,
        selected,
        onSelect: nothing,
        onPlace: nothing,
        onRemove: nothing,
        removeZone: { current: null },
        onRemoveDrop: nothing,
      }),
    );
  }

  it("draws a box for each layer on the grid, with handles on the selected one", () => {
    const html: string = layout(placed, "poll");
    expect([...html.matchAll(/data-grid-box="([a-z]+)"/g)].map((match: RegExpMatchArray): string => match[1])).toEqual([
      "chat",
      "poll",
    ]);
    expect(html).toMatch(/data-grid-box="poll" data-selected="true"/);
    expect(html).toContain("Poll · 1320 × 840");
    expect(html.match(/data-grid-handle=/g)).toHaveLength(8);
    // No selection, or a selected layer that is off this grid: no handles.
    expect(layout(placed, null)).not.toContain("data-grid-handle");
    expect(layout(placed, "topic")).not.toContain("data-selected");
    expect(layout({ ...placed, orientation: "vertical" }, "poll")).not.toContain("data-grid-box");
    expect(layout(placed, "poll")).toContain('data-background="checker"');
  });
});

describe("overlay source fallbacks", () => {
  it("uses an explicitly chosen poll, otherwise finds the newest open poll before falling back to a closed one", () => {
    const closed: OverlayPoll = poll("closed", { revealed: true });
    const expired: OverlayPoll = poll("expired", { endsAt: 999 });
    const active: OverlayPoll = poll("active", { endsAt: 1001 });
    expect(overlayPoll({ type: "auto", ref: null }, [closed, expired, active], 1000)).toBe(active);
    expect(overlayPoll({ type: "auto", ref: null }, [closed, expired], 1000)).toBe(closed);
    expect(overlayPoll({ type: "poll", ref: "expired" }, [closed, expired, active], 1000)).toBe(expired);
    expect(overlayPoll({ type: "poll", ref: "deleted" }, [closed], 1000)).toBeUndefined();
    expect(overlayPoll({ type: "message", ref: null }, [active], 1000)).toBeUndefined();
  });

  it("renders deleted references transparently instead of silently selecting another item", () => {
    for (const type of ["topic", "card", "next"] as const) {
      expect(stage({ type, ref: "deleted" })).not.toContain("<article");
    }
    expect(stage({ type: "poll", ref: "deleted" })).toContain("Waiting for the next poll");
    expect(stage({ type: "auto", ref: null })).toContain("Waiting for the next poll");
    // The content of a layer has no position or size class: its cell places it.
    expect(stage({ type: "next", ref: null })).toBe('<div class="ov-stage" data-overlay-type="next"></div>');
  });

  it.each([
    ["tab:topics", "stream.example.test/@host"],
    ["https://discord.gg/host", "discord.gg/host"],
    [null, "Join us"],
  ])("renders a community card target %s", (target: string | null, shown: string) => {
    const card: OverlayData["cards"][number] = {
      id: "card",
      icon: null,
      title: "Community",
      body: "Welcome",
      label: "Join us",
      target,
    };
    const html: string = stage({ type: "card", ref: null }, { data: { ...data, cards: [card] } });
    expect(html).toContain("Community");
    expect(html).toContain(shown);
    expect(stage({ type: "card", ref: "deleted" }, { data: { ...data, cards: [card] } })).not.toContain("<article");
    expect(
      stage({ type: "card", ref: "card" }, { data: { ...data, cards: [{ ...card, label: null }] } }),
    ).not.toContain('class="ov-cta"');
  });

  describe("the QR code", () => {
    const page = "https://stream.example.test/@host";
    const link = { kind: "kofi", label: null, url: "https://ko-fi.com/host" } as const;
    const card: OverlayData["cards"][number] = {
      id: "c1",
      icon: null,
      title: "Rules",
      body: "",
      label: null,
      target: null,
    };
    const full: OverlayScene = {
      ...scene,
      polls: [poll("closed", { revealed: true }), poll("open"), poll("viewer", { byOwner: false })],
      data: { ...populated, cards: [card], next: { title: "Next stream", startsAt: 5000 }, support: link },
    };

    it("links each layer to the public page of its item", () => {
      expect(qrTarget(full, { type: "poll", ref: "viewer" })).toBe(`${page}?view=polls&entry=viewer`);
      // The automatic poll: the poll that the layer shows.
      expect(qrTarget(full, { type: "auto", ref: null })).toBe(`${page}?view=polls&entry=open`);
      expect(qrTarget(full, { type: "topic", ref: "topic" })).toBe(`${page}?view=topics&entry=topic`);
      expect(qrTarget(full, { type: "next", ref: null })).toBe(`${page}?view=schedule`);
      expect(qrTarget(full, { type: "card", ref: null })).toBe(`${page}?view=community`);
      expect(qrTarget(full, { type: "card", ref: "c1" })).toBe(`${page}?view=community`);
      expect(qrTarget(full, { type: "support", ref: null })).toBe("https://ko-fi.com/host");
      // The support banner without a link opens the page.
      expect(qrTarget(scene, { type: "support", ref: null })).toBe(page);
      // The origin comes from the scene, with or without a slash at its end.
      expect(qrTarget({ ...full, origin: "http://localhost:5173/" }, { type: "next", ref: null })).toBe(
        "http://localhost:5173/@host?view=schedule",
      );
    });

    it("has no link for a layer with nothing to show, and never for the message banner", () => {
      expect(qrTarget(scene, { type: "auto", ref: null })).toBeNull();
      expect(qrTarget(full, { type: "poll", ref: "deleted" })).toBeNull();
      expect(qrTarget(full, { type: "topic", ref: "deleted" })).toBeNull();
      expect(qrTarget(full, { type: "topic", ref: null })).toBeNull();
      expect(qrTarget(scene, { type: "next", ref: null })).toBeNull();
      expect(qrTarget(full, { type: "card", ref: "deleted" })).toBeNull();
      expect(qrTarget(scene, { type: "card", ref: null })).toBeNull();
      expect(qrTarget(full, { type: "message", ref: null })).toBeNull();
    });

    it("sizes the code from the card height, inside the limits", () => {
      // 22% of the height, at least the minimum, at most 30% of the width.
      expect(qrSide(1200, 517)).toBe(114);
      expect(qrSide(1200, 200)).toBe(QR_MIN);
      expect(qrSide(480, 2000)).toBe(144);
      // A very narrow card keeps the minimum, so a phone can still read the code.
      expect(qrSide(200, 2000)).toBe(QR_MIN);
    });

    it("draws the code as an SVG picture with a name, the same for the same link", () => {
      const html: string = renderToStaticMarkup(createElement(QrCode, { url: `${page}?view=schedule` }));
      expect(html).toMatch(
        new RegExp(
          `^<img class="ov-qr" src="data:image/svg\\+xml,[^"]+" alt="QR code: open on your phone" ` +
            `style="width:${QR_MIN}px;height:${QR_MIN}px" data-overlay-qr="${page}\\?view=schedule"/>$`,
        ),
      );
      const svg: string = decodeURIComponent(/src="data:image\/svg\+xml,([^"]+)"/.exec(html)?.[1] ?? "");
      // Version 3 (29 modules) with a quiet zone of 2 modules on each side: dark modules on the light plate.
      expect(svg).toMatch(
        /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 33 33"><rect fill="#f7edcf" width="33" height="33"\/><path fill="#0b2228" d="M2,2h1v1h-1z/,
      );
      expect(renderToStaticMarkup(createElement(QrCode, { url: `${page}?view=schedule` }))).toBe(html);
      expect(renderToStaticMarkup(createElement(QrCode, { url: page }))).not.toBe(html);
    });

    it("shows the code inside the card of each layer with the setting on, and not with it off", () => {
      const sources: readonly ContentSource[] = [
        { type: "auto", ref: null },
        { type: "poll", ref: "open" },
        { type: "topic", ref: "topic" },
        { type: "next", ref: null },
        { type: "card", ref: null },
        { type: "support", ref: null },
      ];
      for (const source of sources) {
        const on: string = stage(source, full, true);
        const link: string = (qrTarget(full, source) ?? "").replaceAll("&", "&amp;");
        // The text keeps the left side. The code is the last part of the card. A poll has the code beside its
        // question, in the head of the card.
        if (source.type === "auto" || source.type === "poll") {
          expect(on, source.type).toMatch(/<div class="ov-poll-head"><h1>[^<]+<\/h1><img class="ov-qr"/);
          expect(on, source.type).toContain(`data-overlay-qr="${link}"/></div><div class="poll-choices`);
        } else {
          expect(on, source.type).toMatch(/<article [^>]*><div class="ov-qr-row"><div class="ov-qr-text">/);
          expect(on.endsWith(`data-overlay-qr="${link}"/></div></article></div>`), source.type).toBe(true);
        }
        expect(on.match(/class="ov-qr"/g), source.type).toHaveLength(1);
        const off: string = stage(source, full);
        expect(off, source.type).toContain("<article");
        expect(off, source.type).not.toContain("ov-qr");
      }
    });

    it("gives long option names wide bars: a row for each of up to three, else two columns", () => {
      expect(optionColumns(["Yes", "No"])).toBeUndefined();
      expect(optionColumns(["Twelve chars", "No"])).toBeUndefined();
      expect(optionColumns(["Thirteen chars", "No"])).toBe(1);
      expect(optionColumns(["A long option name", "b", "c"])).toBe(1);
      expect(optionColumns(["A long option name", "b", "c", "d"])).toBe(2);
    });

    it("shows no code for the message banner or for a layer with nothing to show", () => {
      expect(stage({ type: "message", ref: null }, full, true)).not.toContain("ov-qr");
      expect(stage({ type: "auto", ref: null }, scene, true)).toBe(
        '<div class="ov-stage" data-overlay-type="auto"><div class="overlay-empty">Waiting for the next poll</div></div>',
      );
      expect(stage({ type: "card", ref: "deleted" }, full, true)).toBe(
        '<div class="ov-stage" data-overlay-type="card"></div>',
      );
      expect(stage({ type: "topic", ref: "deleted" }, full, true)).not.toContain("ov-qr");
      expect(stage({ type: "next", ref: null }, scene, true)).not.toContain("ov-qr");
    });

    it("shows the code on a Mash Battle card", () => {
      const battle: OverlayPoll = poll("battle", {
        kind: "mash",
        mash: {
          durationS: 30,
          phase: "live",
          startsAt: 0,
          endsAt: 30_000,
          winner: null,
          totals: [1, 2],
          players: 2,
          assisted: 0,
        },
      });
      const html: string = stage({ type: "poll", ref: "battle" }, { ...full, polls: [battle] }, true);
      expect(html).toContain('data-overlay-mash="live"><div class="ov-qr-row"><div class="ov-qr-text">');
      expect(html).toContain(`data-overlay-qr="${page}?view=polls&amp;entry=battle"`);
    });
  });

  it("shows support and message setup hints until content has been saved", () => {
    expect(stage({ type: "support", ref: null })).toContain("<span>add a link</span>");
    const link = { kind: "kofi", label: null, url: "https://ko-fi.com/host" } as const;
    expect(stage({ type: "support", ref: null }, { data: { ...data, support: link } })).toContain(
      "<span>ko-fi.com/host</span>",
    );
    expect(stage({ type: "message", ref: null }, { overlay: { ...state, message: "" } })).toContain("Your message");
    expect(
      stage({ type: "message", ref: null }, { overlay: { ...state, message: "Back soon", messageStyle: "hype" } }),
    ).toContain("style-hype");
  });

  it("renders a transparent characters canvas at the cell's design dimensions before a feed is available", () => {
    const html: string = renderToStaticMarkup(
      createElement(CharactersSlot, {
        feed: null,
        rect: { x: 0, y: 0, w: 720, h: 240 },
      }),
    );
    expect(html).toMatch(/^<div aria-hidden="true"[^>]*><canvas class="characters-layer" width="720" height="240"/);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<button");
  });

  it("keeps long chat names intact at grapheme boundaries and renders unsafe emotes as text", () => {
    const family: string = "👨‍👩‍👧‍👦";
    expect(shortName(family.repeat(21))).toBe(`${family.repeat(19)}…`);
    const row: ChatRow = {
      id: "chat-1",
      seq: 1,
      platform: "twitch",
      userId: "viewer",
      name: family.repeat(21),
      badges: [],
      fragments: [
        { type: "emote", id: "unsafe", name: "Unsafe emote", url: "https://untrusted.example.test/emote.png" },
      ],
      truncated: false,
      receivedAt: 1000,
      shownAt: 1000,
      phase: "shown",
      phaseAt: 1000,
      animate: false,
      command: false,
    };
    const html: string = renderToStaticMarkup(
      createElement(ChatLayer, {
        chat: { rows: [row], epoch: 0, at: 1000 },
        className: "editor-chat",
      }),
    );
    expect(html).toContain('class="wl-chat editor-chat"');
    expect(html).toContain(`${family.repeat(19)}…`);
    expect(html).toContain("Unsafe emote");
    expect(html).not.toContain("<img");
    // Without a message background setting the card is as before: full opacity and no text outline.
    expect(html).toContain("--wl-bg:1");
    expect(html).not.toContain("data-outline");
  });

  it("puts the message background on the chat root and outlines the text only below 50 percent", () => {
    const chat = { rows: [], epoch: 0, at: 1000 };
    const render = (backgroundOpacity: number): string =>
      renderToStaticMarkup(createElement(ChatLayer, { chat, backgroundOpacity }));
    expect(chatStyle(60)).toMatchObject({ "--wl-bg": "0.6", "--wl-card": "rgba(8, 43, 46, 0.9)" });
    expect(render(100)).toMatch(/^<ol class="wl-chat" style="[^"]*--wl-bg:1"/);
    expect(render(60)).toContain("--wl-bg:0.6");
    expect(render(50)).not.toContain("data-outline");
    expect(render(45)).toMatch(/--wl-bg:0\.45"[^>]* data-outline="true"/);
    expect(render(0)).toMatch(/--wl-bg:0"[^>]* data-outline="true"/);
  });
});

describe("layers in the composition", () => {
  const layers: OverlayLayers = {
    ...DEFAULT_LAYERS,
    chat: { ...DEFAULT_LAYERS.chat, enabled: true },
    items: {
      ...DEFAULT_LAYERS.items,
      topic: { ...DEFAULT_LAYERS.items.topic, ref: "topic", backgroundOpacity: 40 },
      message: { ...DEFAULT_LAYERS.items.message, backgroundOpacity: 0 },
      support: { ...DEFAULT_LAYERS.items.support, enabled: false },
    },
    cells: {
      horizontal: {
        ...emptyCells(),
        chat: { c: 0, r: 0, w: 10, h: 14 },
        characters: { c: 0, r: 14, w: 32, h: 4 },
        poll: { c: 16, r: 0, w: 16, h: 6 },
        topic: { c: 10, r: 0, w: 6, h: 6 },
        message: { c: 10, r: 6, w: 8, h: 4 },
        support: { c: 18, r: 6, w: 8, h: 4 },
      },
      vertical: emptyCells(),
    },
  };
  const topic: OverlayData["topics"][number] = {
    id: "topic",
    title: "Speedrun night",
    category: "games",
    author: "Viewer",
    avatar: null,
    avatarPreset: null,
    likes: 3,
  };
  const shown: OverlayScene = { ...scene, polls: [poll("Open poll")], data: { ...data, topics: [topic] } };

  function composition(value: OverlayLayers, only: OverlayLayer | null = null): string {
    return renderToStaticMarkup(createElement(OverlayComposition, { scene: shown, layers: value, only, feed: null }));
  }

  function boxes(html: string): string[] {
    return [
      ...html.matchAll(/<div class="ov-layer" data-layer="([a-z]+)"(?: data-alone="true")? style="([^"]*)"/g),
    ].map((match: RegExpMatchArray): string => `${match[1]} ${match[2]}`);
  }

  it("shows each layer on stream in its cell, with its source and its card background", () => {
    const html: string = composition(layers);
    expect(boxes(html)).toEqual([
      "poll left:50%;top:0%;width:50%;height:33.33333333333333%;--ov-bg:1",
      "topic left:31.25%;top:0%;width:18.75%;height:33.33333333333333%;--ov-bg:0.4",
      "message left:31.25%;top:33.33333333333333%;width:25%;height:22.22222222222222%;--ov-bg:0",
      "chat left:0%;top:0%;width:31.25%;height:77.77777777777779%",
    ]);
    // A poll layer without a ref shows the latest active poll. Each cell centres its content.
    expect(html).toContain('<div class="ov-fit"><div class="ov-stage" data-overlay-type="auto">');
    expect(html).toContain('data-overlay-poll="Open poll"');
    expect(html).toContain('data-overlay-type="topic"');
    expect(html).toContain("Speedrun night");
    expect(html).toContain("Draft message");
    // A layer that is off stays out: the support banner and the characters. Nothing shows outside a layer box.
    expect(html).not.toContain('data-layer="support"');
    expect(html).not.toContain('data-layer="characters"');
    expect(html).not.toMatch(/<div class="ov-composition"><div class="ov-stage/);
  });

  it("gives each content layer its QR code setting: the poll by default, never the message banner", () => {
    const codes = (html: string): string[] =>
      [...html.matchAll(/data-overlay-qr="([^"]+)"/g)].map((match: RegExpMatchArray): string => match[1]);
    expect(codes(composition(layers))).toEqual(["https://stream.example.test/@host?view=polls&amp;entry=Open+poll"]);
    const all: OverlayLayers = {
      ...layers,
      items: {
        ...layers.items,
        poll: { ...layers.items.poll, qr: false },
        topic: { ...layers.items.topic, qr: true },
        message: { ...layers.items.message, qr: true },
      },
    };
    expect(codes(composition(all))).toEqual(["https://stream.example.test/@host?view=topics&amp;entry=topic"]);
  });

  it("shows nothing for layers without a cell in the selected orientation", () => {
    expect(composition({ ...layers, orientation: "vertical" })).toBe('<div class="ov-composition"></div>');
    expect(composition(DEFAULT_LAYERS)).toBe('<div class="ov-composition"></div>');
    // On without a cell, and a cell while off, are both off stream.
    const noCell: OverlayLayers = { ...layers, cells: { ...layers.cells, horizontal: emptyCells() } };
    expect(composition(noCell)).toBe('<div class="ov-composition"></div>');
    expect(composition({ ...layers, chat: { ...layers.chat, enabled: false } })).not.toContain('data-layer="chat"');
  });

  it("shows one part alone for a per-layer source", () => {
    // The content layers stay at their cells in the frame.
    const content: string = composition(layers, "content");
    expect(content).toContain('data-overlay-only="content"');
    expect(boxes(content).map((box: string): string => box.split(" ")[0])).toEqual(["poll", "topic", "message"]);
    expect(boxes(content)[0]).toBe("poll left:50%;top:0%;width:50%;height:33.33333333333333%;--ov-bg:1");
    // The chat alone fills the page.
    expect(boxes(composition(layers, "chat"))).toEqual(["chat left:0;top:0;width:100%;height:100%"]);
    expect(composition(layers, "chat")).toContain('data-alone="true"');
    expect(composition(layers, "characters")).toBe('<div class="ov-composition" data-overlay-only="characters"></div>');
    const characters: OverlayLayers = { ...layers, characters: { ...layers.characters, enabled: true } };
    expect(boxes(composition(characters, "characters"))).toEqual(["characters left:0;top:0;width:100%;height:100%"]);
    expect(boxes(composition(characters))[0]).toMatch(/^characters left:0%;top:77\./);
  });

  it("uses the design canvas for the composition and for the content layers alone", () => {
    expect(usesDesignCanvas(null)).toBe(true);
    expect(usesDesignCanvas("content")).toBe(true);
    expect(usesDesignCanvas("chat")).toBe(false);
    expect(usesDesignCanvas("characters")).toBe(false);
  });
});

describe("the channel cards", (): void => {
  const offered: ChannelView[] = [
    { platform: "twitch", available: true, connection: null },
    { platform: "youtube", available: true, connection: null },
    { platform: "kick", available: true, connection: null },
  ];
  function cards(channels: ChannelView[]): string[] {
    const Stub = createRoutesStub([
      {
        path: "/overlay-control",
        Component: () =>
          createElement(ChannelPanel, { channels, providers: ["google"], signInProvider: "google", result: null }),
      },
    ]);
    const markup: string = renderToStaticMarkup(createElement(Stub, { initialEntries: ["/overlay-control"] }));
    return markup.split('<li class="ch-item"').slice(1);
  }

  it("show the name and status, one sentence, the button, and then closed notes", (): void => {
    const [twitch, youtube, kick] = cards(offered);
    for (const card of [twitch, youtube, kick]) {
      // Four parts in one order, so the buttons of the cards are on one line.
      expect(card.match(/class="ch-(head|body|actions|foot)"/g)).toEqual([
        'class="ch-head"',
        'class="ch-body"',
        'class="ch-actions"',
        'class="ch-foot"',
      ]);
      expect(card.match(/<details/g)).toHaveLength(1);
      expect(card).toContain('<details class="ch-more"><summary>What is read and the limits</summary>');
      expect(card).not.toContain("<details open");
      expect(card).not.toContain("ch-reauth");
    }
    expect(twitch).toContain('<div class="ch-body"><p>Chat starts as soon as the channel is connected.</p></div>');
    expect(youtube).toContain(
      '<div class="ch-body"><p>Chat starts when an overlay with your overlay link is open.</p></div>',
    );
    expect(kick).toContain('<div class="ch-body"><p>Chat starts as soon as the channel is connected.</p></div>');
    expect(twitch).toContain(
      "<ul><li>Read: chat messages, message deletions, chat clears, bans and timeouts.</li>" +
        "<li>Twitch emotes show as images.</li>" +
        "<li>If Twitch stops sending events, reconnect the channel to resume.</li></ul>",
    );
    expect(youtube).toContain(
      "<ul><li>Read: chat messages, message deletions, bans and timeouts.</li>" +
        "<li>Each page can show about 5 hours of YouTube chat a day. If the channel data cannot be refreshed " +
        "for 30 days, the connection is removed.</li>" +
        "<li>YouTube does not report chat clears or unbans.</li></ul>",
    );
    expect(kick).toContain(
      "<ul><li>Read: chat messages, bans and timeouts.</li>" +
        "<li>Kick emotes show as their names, not as images.</li>" +
        "<li>Kick does not report message deletions, chat clears or unbans.</li></ul>",
    );
  });

  it("keep the YouTube terms sentence in view beside the YouTube button only", (): void => {
    const [twitch, youtube, kick] = cards(offered);
    const terms: string = "By connecting YouTube, you agree to the YouTube Terms of Service.";
    expect(youtube.indexOf(terms)).toBeGreaterThan(youtube.indexOf('class="ch-actions"'));
    expect(youtube.indexOf(terms)).toBeLessThan(youtube.indexOf("Connect YouTube"));
    expect(youtube.indexOf("Connect YouTube")).toBeLessThan(youtube.indexOf("<details"));
    expect(twitch).not.toContain(terms);
    expect(kick).not.toContain(terms);
  });

  it("give a platform that the site does not offer no button and no notes", (): void => {
    const [twitch] = cards([{ platform: "twitch", available: false, connection: null }]);
    expect(twitch).toContain("This platform is not set up on this site yet.");
    expect(twitch).not.toContain("<button");
    expect(twitch).not.toContain("<details");
  });

  it("mark the health of each card with an icon and words", (): void => {
    const connection = { displayName: "Host", code: null, connectedAt: 1, lastEventAt: null, updatedAt: 1 };
    const [twitch, youtube, kick] = cards([
      { platform: "twitch", available: true, connection: { ...connection, status: "active" } },
      { platform: "youtube", available: true, connection: { ...connection, status: "needs_reauth" } },
      { platform: "kick", available: true, connection: null },
    ]);
    const mark = (card: string): string | undefined =>
      /<span class="ch-mark" data-health="([a-z]+)"><svg[^>]*class="[^"]*(icon-[a-z-]+)"[^>]*>.*?<\/svg>([^<]+)<\/span>/
        .exec(card)
        ?.slice(1)
        .join(" ");
    expect(mark(twitch)).toBe("healthy icon-success Healthy");
    expect(mark(youtube)).toBe("attention icon-warning Needs attention");
    expect(mark(kick)).toBe("none icon-minus Not connected");
    // The mark is beside the name of the connection, in the head of the card.
    expect(twitch).toMatch(/<strong>Connected as Host<\/strong><span class="ch-mark"/);
    expect(twitch.indexOf("ch-mark")).toBeLessThan(twitch.indexOf('class="ch-body"'));
    // "Not connected" shows once: the mark says it.
    expect(kick.match(/Not connected/g)).toHaveLength(1);
    expect(kick).not.toContain("<strong>");
    // A connection without a chat event says so on the server already. An age waits for the viewer's clock.
    expect(twitch).toContain('<p class="muted">No chat event yet</p>');
    const [aged] = cards([
      { platform: "kick", available: true, connection: { ...connection, status: "active", lastEventAt: 5 } },
    ]);
    expect(aged).not.toContain("Last chat event");
    // A platform that the site does not offer has no health mark.
    const [gone] = cards([{ platform: "twitch", available: false, connection: { ...connection, status: "error" } }]);
    expect(gone).not.toContain("ch-mark");
  });

  it("say that the status is old only while the reads fail", (): void => {
    const panel = (stale: boolean): string => {
      const Stub = createRoutesStub([
        {
          path: "/overlay-control",
          Component: () =>
            createElement(ChannelPanel, {
              channels: offered,
              stale,
              providers: [],
              signInProvider: null,
              result: null,
            }),
        },
      ]);
      return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/overlay-control"] }));
    };
    expect(panel(true)).toContain(
      '<p class="muted" data-channels-stale="true">Status could not be refreshed. Next try in a moment.</p>',
    );
    expect(panel(false)).not.toContain("data-channels-stale");
  });
});
