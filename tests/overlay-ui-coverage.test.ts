import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { controlState, defaultRef, OverlayControl } from "../app/components/overlay/overlay-control";
import { ChatLayer, shortName } from "../app/components/overlay/chat-layer";
import { CharactersSlot, CONTENT_SELECTOR, layerSelector } from "../app/components/overlay/overlay-composition";
import {
  SAMPLE_SOURCE,
  sampleCharactersFeed,
  sampleCharactersFrame,
  sampleScene,
} from "../app/components/overlay/editor-samples";
import { chatCoversContent } from "../app/components/overlay/use-chat-overlap";
import {
  OverlayStage,
  overlayPoll,
  showsContent,
  upNextStart,
  type OverlayPoll,
  type OverlayScene,
} from "../app/components/overlay/overlay-stage";
import { DEFAULT_LAYERS } from "../app/lib/overlay-layers";
import type { ChatRow } from "../app/lib/chat-feed";
import type { OverlayData, OverlaySourceRef, OverlayState } from "../app/types";

const data: OverlayData = { polls: [], topics: [], cards: [], next: null, support: null };
const state: OverlayState = {
  air: { type: "auto", ref: null },
  preview: { type: "auto", ref: null },
  position: "lower",
  size: "m",
  instant: false,
  showResults: true,
  message: "Draft message",
  messageStyle: "info",
  layers: DEFAULT_LAYERS,
  chatTestUntil: 0,
  revision: 1,
};
const scene: OverlayScene = {
  name: "Host",
  handle: "host",
  host: "stream.example.test",
  overlay: state,
  polls: [],
  data,
  now: 1000,
};

function stage(source: OverlaySourceRef, override: Partial<OverlayScene> = {}): string {
  return renderToStaticMarkup(createElement(OverlayStage, { scene: { ...scene, ...override }, source }));
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
    ...override,
  };
}

describe("overlay source fallbacks", () => {
  it("defaults each picker to its first saved item and leaves an empty picker without a reference", () => {
    const populated: OverlayData = {
      ...data,
      polls: [{ id: "poll", title: "Poll", mash: false }],
      topics: [
        { id: "topic", title: "Topic", category: "", author: "Viewer", avatar: null, avatarPreset: null, likes: 0 },
      ],
      cards: [{ id: "card", icon: null, title: "Card", body: "", label: null, target: null }],
    };
    for (const type of ["poll", "topic", "card"] as const) {
      expect(defaultRef(type, populated)).toBe(type);
      expect(defaultRef(type, data)).toBeNull();
    }
    expect(defaultRef("support", populated)).toBeNull();
  });

  it("keeps draft fields when newer public state arrives and ignores stale updates", () => {
    const loaded: OverlayState = {
      ...state,
      revision: 2,
      message: "Unsaved banner",
      preview: { type: "card", ref: "card" },
    };
    const live: OverlayState = {
      ...state,
      revision: 3,
      air: { type: "hidden", ref: null },
      message: "",
      position: "corner",
      size: "s",
      showResults: false,
    };
    expect(controlState(state, loaded, live)).toMatchObject({
      air: live.air,
      preview: loaded.preview,
      message: loaded.message,
      position: "corner",
      size: "s",
      showResults: false,
      revision: 3,
    });
    expect(controlState(loaded, state, state)).toBe(loaded);
    expect(controlState(state, loaded, null)).toBe(loaded);
    expect(
      controlState(state, loaded, { ...live, air: { type: "message", ref: null }, message: "On air" }).message,
    ).toBe("On air");
  });

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

  it.each([
    ["poll", "Create a poll or Mash Battle on your page first."],
    ["topic", "No topics yet."],
    ["card", "Add Community cards from Edit your page first."],
  ] as const)("explains an empty %s picker", (type, message) => {
    const html: string = renderToStaticMarkup(
      createElement(OverlayControl, {
        initial: { ...state, preview: { type, ref: null } },
        scene,
        hasOverlayKey: false,
      }),
    );
    expect(html).toContain(message);
    expect(html).not.toContain('role="combobox"');
  });

  it("renders deleted references transparently instead of silently selecting another item", () => {
    for (const type of ["topic", "card", "next", "hidden"] as const) {
      expect(stage({ type, ref: "deleted" })).not.toContain("<article");
    }
    expect(stage({ type: "poll", ref: "deleted" })).toContain("Waiting for the next poll");
    expect(upNextStart({ type: "next", ref: null }, data)).toBeNull();
    expect(upNextStart({ type: "next", ref: null }, { next: { title: "Soon", startsAt: 2000 } })).toBe(2000);
    expect(upNextStart({ type: "topic", ref: null }, { next: { title: "Soon", startsAt: 2000 } })).toBeNull();
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

  it("knows which sources leave the stage empty, and fills a sample topic for the editor", () => {
    const card: OverlayData["cards"][number] = { id: "card", icon: null, title: "C", body: "", label: null, target: null };
    expect(showsContent({ type: "hidden", ref: null }, data)).toBe(false);
    expect(showsContent({ type: "topic", ref: "deleted" }, data)).toBe(false);
    expect(showsContent({ type: "next", ref: null }, data)).toBe(false);
    expect(showsContent({ type: "next", ref: null }, { ...data, next: { title: "Soon", startsAt: 2000 } })).toBe(true);
    expect(showsContent({ type: "card", ref: null }, data)).toBe(false);
    expect(showsContent({ type: "card", ref: null }, { ...data, cards: [card] })).toBe(true);
    expect(showsContent({ type: "card", ref: "deleted" }, { ...data, cards: [card] })).toBe(false);
    expect(showsContent({ type: "auto", ref: null }, data)).toBe(true);
    expect(showsContent({ type: "message", ref: null }, data)).toBe(true);
    const sample: OverlayScene = sampleScene(scene);
    expect(showsContent(SAMPLE_SOURCE, sample.data)).toBe(true);
    expect(stage(SAMPLE_SOURCE, sample)).toContain("Sample topic");
    // The scene of the page keeps its own topics.
    expect(scene.data.topics).toEqual([]);
  });

  it("gives the editor a still sample frame of characters without a socket", () => {
    const frame = sampleCharactersFrame(16, 2);
    expect(frame.full).toBe(true);
    expect(frame.terrain.w).toBe(640);
    expect(frame.roster.map((entry) => entry.name)).toEqual(["RustBucket", "Ngozi Okafor", "Zoë_Ünter", "scav_kid"]);
    for (const [, x10, y10] of frame.chars) {
      expect(x10 / 10).toBeGreaterThan(frame.terrain.xmin);
      expect(x10 / 10).toBeLessThan(frame.terrain.xmax);
      expect(y10 / 10).toBe(frame.terrain.gy);
    }
    const seen: unknown[] = [];
    const feed = sampleCharactersFeed(6, 2);
    feed?.subscribe((message) => seen.push(message))();
    expect(seen).toEqual([sampleCharactersFrame(6, 2)]);
    expect(feed?.status).toBe("off");
    // A cell below the playground size limits gets no sample.
    expect(sampleCharactersFeed(2, 1)).toBeNull();
  });

  it("shows support and message setup hints until content has been saved", () => {
    expect(stage({ type: "support", ref: null })).toContain("<span>add a link</span>");
    expect(stage({ type: "message", ref: null }, { overlay: { ...state, message: "" } })).toContain("Your message");
    expect(
      stage({ type: "message", ref: null }, { overlay: { ...state, message: "Back soon", messageStyle: "hype" } }),
    ).toContain("style-hype");
  });

  it("uses the default community card while a disconnected control still offers its card picker", () => {
    const populated: OverlayData = {
      ...data,
      cards: [{ id: "card", icon: null, title: "Card", body: "", label: null, target: null }],
    };
    const html: string = renderToStaticMarkup(createElement(OverlayControl, {
      initial: { ...state, preview: { type: "card", ref: null } },
      scene: { ...scene, data: populated },
      hasOverlayKey: false,
      connected: false,
    }));
    expect(html).toContain('role="combobox"');
    expect(html).toContain('data-overlay-source="card"');
    expect(html).toContain("Overlay disconnected, retrying");
    expect(html).not.toContain(">Reconnect</button>");
  });

  it("renders a transparent characters canvas at the cell's design dimensions before a feed is available", () => {
    const html: string = renderToStaticMarkup(createElement(CharactersSlot, {
      feed: null,
      rect: { x: 0, y: 0, w: 720, h: 240 },
    }));
    expect(html).toMatch(/^<div aria-hidden="true"[^>]*><canvas class="characters-layer" width="720" height="240"/);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<button");
  });

  it("keeps long chat names intact at grapheme boundaries and renders unsafe emotes as text", () => {
    const family: string = "👨‍👩‍👧‍👦";
    expect(shortName(family.repeat(21))).toBe(`${family.repeat(19)}…`);
    const row: ChatRow = {
      id: "chat-1", seq: 1, platform: "twitch", userId: "viewer", name: family.repeat(21), badges: [],
      fragments: [{ type: "emote", id: "unsafe", name: "Unsafe emote", url: "https://untrusted.example.test/emote.png" }],
      truncated: false, receivedAt: 1000, shownAt: 1000, phase: "shown", phaseAt: 1000, animate: false, command: false,
    };
    const html: string = renderToStaticMarkup(createElement(ChatLayer, {
      chat: { rows: [row], epoch: 0, at: 1000 },
      className: "editor-chat",
    }));
    expect(html).toContain('class="wl-chat editor-chat"');
    expect(html).toContain(`${family.repeat(19)}…`);
    expect(html).toContain("Unsafe emote");
    expect(html).not.toContain("<img");
  });
});

describe("chat overlap measurements", () => {
  function rect(left: number, top: number, width: number, height: number): DOMRect {
    return {
      x: left, y: top, left, top, width, height, right: left + width, bottom: top + height,
      toJSON: (): object => ({ left, top, width, height }),
    };
  }

  function composition(chat: DOMRect | null, content: readonly DOMRect[] | null): HTMLElement {
    const element = (bounds: DOMRect): Element => ({ getBoundingClientRect: (): DOMRect => bounds }) as Element;
    const stage = content === null ? null : { children: content.map(element) } as unknown as Element;
    return {
      querySelector: (selector: string): Element | null => {
        if (selector === CONTENT_SELECTOR) return stage;
        expect(selector).toBe(layerSelector("chat"));
        return chat === null ? null : element(chat);
      },
    } as unknown as HTMLElement;
  }

  it("ignores missing and zero-sized content rather than reporting an invisible overlap", () => {
    const chat: DOMRect = rect(0, 0, 100, 100);
    expect(chatCoversContent(composition(chat, null))).toBe(false);
    expect(chatCoversContent(composition(chat, [rect(0, 0, 0, 20), rect(0, 0, 20, 0)]))).toBe(false);
    expect(chatCoversContent(composition(null, [chat]))).toBe(false);
  });

  it("measures the union of visible content and treats shared edges or subpixel contact as clear", () => {
    const content: DOMRect[] = [rect(0, 0, 100, 100), rect(150, 150, 100, 100), rect(300, 300, 0, 0)];
    expect(chatCoversContent(composition(rect(200, 200, 100, 100), content))).toBe(true);
    expect(chatCoversContent(composition(rect(250, 0, 100, 100), content))).toBe(false);
    expect(chatCoversContent(composition(rect(249, 0, 100, 100), content))).toBe(false);
    expect(chatCoversContent(composition(rect(248, 0, 100, 100), content))).toBe(true);
    expect(chatCoversContent(composition(rect(0, 249, 100, 100), content))).toBe(false);
  });
});
