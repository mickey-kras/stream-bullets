import { describe, expect, it } from "vitest";
import { type FrameState, MARK_LIFT, mergeFrame, toView } from "../app/components/overlay/characters/adapter";
import type { PlaygroundView } from "../app/components/overlay/characters/view";
import type { ActivityChat } from "../app/lib/activity";
import {
  CHAR_STATES,
  type CharTuple,
  FLAG_NEW,
  FLAG_UNAVAILABLE,
  type PlaygroundFullFrame,
  type PlaygroundTickFrame,
} from "../app/lib/playground/protocol";
import { mulberry32, PlaygroundSim } from "../app/lib/playground/sim";

function chat(user: number, text: string): ActivityChat {
  return {
    kind: "chat",
    id: `twitch:m${user}-${text}`,
    platform: user % 2 === 0 ? "twitch" : "youtube",
    channelId: "c1",
    messageId: `m${user}-${text}`,
    user: { id: `u${user}`, displayName: `Viewer ${user}` },
    text,
    fragments: [{ type: "text", text }],
    badges: [],
    sentAt: null,
    receivedAt: 1,
    live: true,
  };
}

/** A running 16 x 2 playground with three admitted characters. */
function playground(): PlaygroundSim {
  const sim = new PlaygroundSim({ cellsW: 16, cellsH: 2, rng: mulberry32(7) });
  sim.resumeAfter(0);
  for (let user = 1; user <= 3; user += 1) sim.receive(chat(user, "hello"));
  for (let i = 0; i < 60; i += 1) sim.tick();
  return sim;
}

function tickFrame(chars: CharTuple[], over: Partial<PlaygroundTickFrame> = {}): PlaygroundTickFrame {
  return { type: "playground", v: 2, full: false, tick: 99, chars, ...over };
}

describe("playground frame adapter", () => {
  it("turns a full frame of the real simulation into the renderer view", () => {
    const frame: PlaygroundFullFrame = playground().fullFrame();
    const state: FrameState | null = mergeFrame(null, frame);
    if (!state) throw new Error("A full frame gives a state.");
    const view: PlaygroundView = toView(state, frame.chars);
    expect(view.world).toEqual({ width: frame.terrain.w, height: frame.terrain.h, ground: frame.terrain.gy });
    expect(view.doors).toEqual({ entrance: frame.terrain.entryX, exit: frame.terrain.exitX });
    expect(view.pad).toBe(frame.terrain.padX);
    expect(view.tiles).toHaveLength(frame.terrain.ground.length);
    expect(view.tiles[0]).toEqual({ kind: "girder", stage: 0 });
    expect(view.tiles.some((tile) => tile.kind === "dirt")).toBe(true);
    expect(view.characters).toHaveLength(3);
    for (const [index, character] of view.characters.entries()) {
      const [id, x10, y10, stateIndex, t, dir] = frame.chars[index];
      const entry = frame.roster.find((item) => item.id === id);
      expect(character).toMatchObject({
        id,
        x: x10 / 10,
        y: y10 / 10,
        state: CHAR_STATES[stateIndex],
        t,
        dir,
        platform: entry?.platform,
        name: entry?.name,
      });
    }
    expect(view.mode).toEqual({ test: false, paused: false });
  });

  it("maps tiles, blocks, ropes, flags, the crown, bubbles and marks", () => {
    const frame: PlaygroundFullFrame = playground().fullFrame();
    const id: number = frame.roster[0].id;
    const state: FrameState | null = mergeFrame(null, {
      ...frame,
      // Five columns: a dirt block and a cracked plank in the first row, a stair to the left in the second.
      terrain: { ...frame.terrain, ground: "g0123", blocks: "a.e..?..p.".replace("?", ".") },
      extras: {
        ropes: [
          [id, 120, 30, 1],
          [999, 1, 1, 0],
        ],
        flags: [
          [id, 40, 62],
          [999, 8, 62],
        ],
        crown: id,
      },
      bubbles: [{ id, text: "hi" }],
      mode: { paused: true, test: true },
    });
    if (!state) throw new Error("A full frame gives a state.");
    const view: PlaygroundView = toView(state, [[id, 1005, 620, 1, 3, -1, FLAG_UNAVAILABLE | FLAG_NEW]]);
    expect(view.tiles).toEqual([
      { kind: "girder", stage: 0 },
      { kind: "dirt", stage: 0 },
      { kind: "dirt", stage: 1 },
      { kind: "dirt", stage: 2 },
      { kind: "dirt", stage: 3 },
    ]);
    expect(view.blocks).toEqual([
      { c: 0, r: 0, kind: "dirt", dir: 1, stage: 0 },
      { c: 2, r: 0, kind: "dirt", dir: -1, stage: 1 },
      { c: 3, r: 1, kind: "stair", dir: -1, stage: 0 },
    ]);
    // A rope, a flag and a crown of a character that is not in the frame do not show.
    expect(view.ropes).toEqual([{ id, x: 120, y: 30, hit: true }]);
    expect(view.flags).toEqual([{ x: 40, y: 62, platform: frame.roster[0].platform }]);
    expect(view.crown).toBe(id);
    expect(view.characters[0]).toMatchObject({ x: 100.5, y: 62, state: "walk", bubble: "hi", recent: true });
    expect(view.marks).toEqual([{ x: 100.5, y: 62 - MARK_LIFT }]);
    expect(view.mode).toEqual({ test: true, paused: true });
    // Without the flags: no mark, not recent, no bubble for another character.
    const plain: PlaygroundView = toView(state, [[frame.roster[1].id, 100, 620, 1, 0, 1, 0]]);
    expect(plain.crown).toBeNull();
    expect(plain.ropes).toEqual([]);
    expect(plain.marks).toEqual([]);
    expect(plain.characters[0]).toMatchObject({ recent: false, bubble: null });
  });

  it("merges tick frames onto the last full state and ignores them before one", () => {
    const sim: PlaygroundSim = playground();
    const full: PlaygroundFullFrame = sim.fullFrame();
    expect(mergeFrame(null, tickFrame(full.chars))).toBeNull();
    const state: FrameState | null = mergeFrame(null, full);
    if (!state) throw new Error("A full frame gives a state.");
    // A tick frame without sections keeps every section.
    expect(mergeFrame(state, tickFrame([]))).toEqual(state);
    // A tick frame with a section replaces only that section.
    const next: FrameState | null = mergeFrame(
      state,
      tickFrame([], { roster: [], mode: { paused: true, test: false } }),
    );
    expect(next).toEqual({ ...state, roster: [], mode: { paused: true, test: false } });
    // A new full frame (a reconnect) replaces everything.
    expect(mergeFrame(next, full)).toEqual(state);
  });

  it("follows the real tick frames and draws no character without a roster entry", () => {
    const sim: PlaygroundSim = playground();
    let state: FrameState | null = mergeFrame(null, sim.fullFrame());
    sim.tickFrame();
    sim.receive(chat(4, "!wave"));
    for (let i = 0; i < 3; i += 1) sim.tick();
    const tick: PlaygroundTickFrame = sim.tickFrame();
    state = mergeFrame(state, tick);
    if (!state) throw new Error("The state stays.");
    expect(toView(state, tick.chars).characters.map((character) => character.name)).toContain("Viewer 4");
    expect(toView(state, [[999, 0, 0, 0, 0, 1, 0]]).characters).toEqual([]);
  });
});
