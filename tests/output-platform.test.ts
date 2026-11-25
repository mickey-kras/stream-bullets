import { describe, expect, it } from "vitest";
import type { CharacterView, PlaygroundView } from "../app/components/overlay/characters/view";
import { viewForPlatform } from "../app/components/overlay/characters/view";
import { messageForPlatform, type ActivityEvent, type ActivityMessage } from "../app/lib/activity";
import { SAMPLE_CHAT } from "../app/lib/chat-feed";

// An output that shows Twitch only: the events of the feed and the characters of the other platforms do not show.

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
    stairs: [],
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

  it("returns the same view when each character is of the platform", (): void => {
    const mine: PlaygroundView = { ...view, characters: [character(1, "twitch")], speakers: [1] };
    expect(viewForPlatform(mine, "twitch")).toBe(mine);
  });
});
