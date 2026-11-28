import { describe, expect, it } from "vitest";
import { bannerAlert } from "../app/components/overlay/alerts-layer";
import type { CharacterView, PlaygroundView } from "../app/components/overlay/characters/view";
import { viewForPlatform } from "../app/components/overlay/characters/view";
import { messageForPlatform, type ActivityEvent, type ActivityMessage } from "../app/lib/activity";
import { chatMark } from "../app/lib/alert-feed";
import type { AlertView } from "../app/lib/alerts";
import { SAMPLE_CHAT } from "../app/lib/chat-feed";

// An output that shows Twitch only: the events of the feed, the characters and the alerts of the other platforms do
// not show.

const twitch: ActivityEvent[] = SAMPLE_CHAT.filter((row): boolean => row.platform === "twitch");
const others: ActivityEvent[] = SAMPLE_CHAT.filter((row): boolean => row.platform !== "twitch");

describe("the events of one platform", (): void => {
  it("has sample chat of Twitch and of the other platforms", (): void => {
    expect(twitch.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
  });

  it("keeps an event of the platform and drops each other event", (): void => {
    const mine: ActivityMessage = { type: "event", event: twitch[0] };
    expect(messageForPlatform(mine, "twitch")).toBe(mine);
    expect(messageForPlatform({ type: "event", event: others[0] }, "twitch")).toBeNull();
    // Each kind of event has a platform: a deletion, a clear, and a status of another platform do not pass.
    const foreign: ActivityEvent[] = [
      { kind: "delete", platform: "youtube", messageId: "m1", receivedAt: 1 },
      { kind: "clear", platform: "kick", receivedAt: 1 },
      { kind: "clear_user", platform: "youtube", userId: "u1", receivedAt: 1 },
      { kind: "status", platform: "kick", status: "active" },
    ];
    for (const event of foreign) expect(messageForPlatform({ type: "event", event }, "twitch")).toBeNull();
    const clear: ActivityMessage = { type: "event", event: { kind: "clear", platform: "twitch", receivedAt: 1 } };
    expect(messageForPlatform(clear, "twitch")).toBe(clear);
  });

  it("keeps a snapshot with the events of the platform only, in their sequence", (): void => {
    const snapshot: ActivityMessage = { type: "snapshot", events: [...SAMPLE_CHAT], replay: true };
    expect(messageForPlatform(snapshot, "twitch")).toEqual({ type: "snapshot", events: twitch, replay: true });
    // The boundary of the server stays: the snapshot still tells nothing about an older message.
    expect(messageForPlatform({ ...snapshot, since: 5 }, "twitch")).toEqual({
      type: "snapshot",
      events: twitch,
      replay: true,
      since: 5,
    });
    // A snapshot without an event of the platform is an empty snapshot, not nothing: it replaces the old rows.
    const none: ActivityMessage = { type: "snapshot", events: others, replay: true };
    expect(messageForPlatform(none, "twitch")).toEqual({ type: "snapshot", events: [], replay: true });
    const all: ActivityMessage = { type: "snapshot", events: twitch, replay: true };
    expect(messageForPlatform(all, "twitch")).toBe(all);
  });

  it("passes the messages that are not events of a platform", (): void => {
    const gone: ActivityMessage = { type: "unavailable" };
    expect(messageForPlatform(gone, "twitch")).toBe(gone);
  });
});

describe("the characters of one platform", (): void => {
  const character = (id: number, platform: string): CharacterView => ({
    id,
    x: id * 10,
    y: 60,
    state: "walk",
    t: 0,
    dir: 1,
    platform,
    name: `Viewer ${id}`,
    bubble: null,
    recent: false,
  });
  const view: PlaygroundView = {
    world: { width: 640, height: 80, ground: 60 },
    tiles: [],
    blocks: [{ c: 3, r: 0, kind: "dirt", dir: 1, stage: 0 }],
    ropes: [
      { id: 1, x: 40, y: 20, hit: true },
      { id: 2, x: 50, y: 20, hit: false },
    ],
    flags: [
      { x: 100, y: 60, platform: "twitch" },
      { x: 200, y: 60, platform: "kick" },
    ],
    crown: 2,
    marks: [],
    doors: { entrance: 10, exit: 630 },
    pad: 320,
    characters: [character(1, "twitch"), character(2, "youtube"), character(3, "kick"), character(4, "twitch")],
    speakers: [2, 4, 1],
    mode: { test: false, paused: false },
  };

  it("keeps the characters of the platform and their bubbles, and the playground itself", (): void => {
    const shown: PlaygroundView = viewForPlatform(view, "twitch");
    expect(shown.characters.map((item: CharacterView): number => item.id)).toEqual([1, 4]);
    expect(shown.speakers).toEqual([4, 1]);
    expect(shown.world).toBe(view.world);
    expect(shown.doors).toBe(view.doors);
    expect(shown.mode).toBe(view.mode);
  });

  it("keeps the builds, and only the ropes, the flags and the crown of the platform", (): void => {
    const shown: PlaygroundView = viewForPlatform(view, "twitch");
    expect(shown.blocks).toBe(view.blocks);
    expect(shown.ropes).toEqual([{ id: 1, x: 40, y: 20, hit: true }]);
    expect(shown.flags).toEqual([{ x: 100, y: 60, platform: "twitch" }]);
    expect(shown.crown).toBeNull();
    expect(viewForPlatform(view, "youtube").crown).toBe(2);
  });

  it("crowns the highest standing viewer of the filtered platform and retains all blocks", (): void => {
    const raised: PlaygroundView = {
      ...view,
      characters: view.characters.map((c: CharacterView): CharacterView => ({ ...c, y: c.id === 1 ? 20 : c.id === 4 ? 12 : 0 })),
    };
    expect(viewForPlatform(raised, "twitch").crown).toBe(4);
    expect(viewForPlatform(raised, "twitch").blocks).toBe(view.blocks);
    const airborne: PlaygroundView = { ...raised, characters: raised.characters.map((c: CharacterView): CharacterView => c.id === 4 ? { ...c, state: "jump" } : c) };
    expect(viewForPlatform(airborne, "twitch").crown).toBe(1);
  });

  it("returns the same view when each character is of the platform", (): void => {
    const mine: PlaygroundView = { ...view, characters: [character(1, "twitch")], speakers: [1] };
    expect(viewForPlatform(mine, "twitch")).toBe(mine);
  });
});

describe("the alerts of one platform", (): void => {
  const T0 = 1_800_000_000_000;
  const alert = (override: Partial<AlertView> = {}): AlertView => ({
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
    ...override,
  });
  const gift: AlertView = alert();
  const superChat: AlertView = alert({
    id: "youtube:s1",
    kind: "super_chat",
    platform: "youtube",
    amount: 5_000_000,
    currency: "USD",
  });
  const kicks: AlertView = alert({ id: "kick:k1", kind: "kicks", platform: "kick", amount: 100 });
  const topic: AlertView = alert({ id: "direct:t1", kind: "topic", platform: "direct", amount: null });
  const state = (current: AlertView): ActivityMessage => ({
    type: "alerts",
    at: T0,
    muted: false,
    current,
    waiting: 0,
    goal: null,
  });

  it("passes each alert message to the page: the page selects the alerts that it shows", (): void => {
    const message: ActivityMessage = state(superChat);
    expect(messageForPlatform(message, "twitch")).toBe(message);
  });

  it("shows the banner of a Twitch alert and of a topic credit, and no banner of the other platforms", (): void => {
    expect(bannerAlert(gift, "twitch")?.id).toBe("twitch:d1");
    expect(bannerAlert(topic, "twitch")?.id).toBe("direct:t1");
    expect(bannerAlert(superChat, "twitch")).toBeNull();
    expect(bannerAlert(kicks, "twitch")).toBeNull();
    // An output for all platforms shows each alert.
    for (const each of [gift, superChat, kicks, topic]) expect(bannerAlert(each, null)?.id).toBe(each.id);
  });

  it("marks the same alerts in chat as the banner shows", (): void => {
    expect(chatMark(state(gift), "twitch", T0)).toBe(gift);
    expect(chatMark(state(topic), "twitch", T0)).toBe(topic);
    expect(chatMark(state(superChat), "twitch", T0)).toBeNull();
    expect(chatMark(state(kicks), "twitch", T0)).toBeNull();
    expect(chatMark(state(superChat), null, T0)).toBe(superChat);
    // An alert without a banner plays at once: the same rule.
    const follow: AlertView = alert({ id: "kick:f1", kind: "follow", platform: "kick", amount: null, banner: false });
    expect(chatMark({ type: "alert", alert: follow }, "twitch", T0)).toBeNull();
    expect(chatMark({ type: "alert", alert: follow }, null, T0)).toBe(follow);
    expect(chatMark({ type: "alert", alert: { ...follow, id: "twitch:f2", platform: "twitch" } }, "twitch", T0)).not.toBeNull();
  });
});
