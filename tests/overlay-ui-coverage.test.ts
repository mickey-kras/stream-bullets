import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { controlState, defaultRef, OverlayControl } from "../app/components/overlay/overlay-control";
import {
  OverlayStage,
  overlayPoll,
  upNextStart,
  type OverlayPoll,
  type OverlayScene,
} from "../app/components/overlay/overlay-stage";
import { DEFAULT_LAYERS } from "../app/lib/overlay-layers";
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

  it("shows support and message setup hints until content has been saved", () => {
    expect(stage({ type: "support", ref: null })).toContain("<span>add a link</span>");
    expect(stage({ type: "message", ref: null }, { overlay: { ...state, message: "" } })).toContain("Your message");
    expect(
      stage({ type: "message", ref: null }, { overlay: { ...state, message: "Back soon", messageStyle: "hype" } }),
    ).toContain("style-hype");
  });
});
