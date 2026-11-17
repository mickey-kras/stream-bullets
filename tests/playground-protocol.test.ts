import { describe, expect, it } from "vitest";
import { ALM, LRM, RLO, RLM } from "./helpers/hostile-bidi";
import type { ActivityChat } from "../app/lib/activity";
import {
  BUBBLE_GRAPHEMES,
  BUBBLE_MAX_UNITS,
  boundText,
  type CharTuple,
  encodeFrame,
  MAX_FRAME_LENGTH,
  NAME_GRAPHEMES,
  NAME_MAX_UNITS,
  type PlaygroundFullFrame,
  type PlaygroundTickFrame,
  parseFrame,
} from "../app/lib/playground/protocol";
import { PlaygroundSim } from "../app/lib/playground/sim";

function full(): PlaygroundFullFrame {
  return {
    type: "playground",
    v: 1,
    full: true,
    tick: 12,
    chars: [[1, 4000, 620, 1, 3, 1, 2]],
    roster: [{ id: 1, platform: "twitch", name: "RustBucket" }],
    bubbles: [{ id: 1, text: "hello" }],
    terrain: {
      w: 640,
      h: 80,
      gy: 62,
      tile: 16,
      ground: "gggggg0123ggg",
      stairs: [[300, 58, 1]],
      padX: 200,
      entryX: 40,
      exitX: 598,
      xmin: 84,
      xmax: 556,
    },
    mode: { paused: false, test: true },
  };
}

function hostile(name: string): ActivityChat {
  return {
    kind: "chat",
    id: "kick:m1",
    platform: "kick",
    channelId: "c1",
    messageId: "m1",
    user: { id: "secret-user-id", displayName: name },
    text: `<img src=x onerror=alert(1)>\u0000${RLO}${"Ź̂̃".repeat(200)}`,
    fragments: [],
    badges: [],
    sentAt: null,
    receivedAt: 0,
    live: true,
  };
}

describe("playground protocol", () => {
  it("round-trips full and tick frames", () => {
    const frame = full();
    expect(parseFrame(encodeFrame(frame))).toEqual(frame);
    const tick: PlaygroundTickFrame = {
      type: "playground",
      v: 1,
      full: false,
      tick: 13,
      chars: [[7, -5, 0, 16, 959, -1, 0]],
    };
    expect(parseFrame(encodeFrame(tick))).toEqual(tick);
    expect(parseFrame(encodeFrame({ ...tick, roster: [], mode: { paused: true, test: false } }))).toEqual({
      ...tick,
      roster: [],
      mode: { paused: true, test: false },
    });
  });

  it("refuses frames that break the contract", () => {
    const frame = full();
    const bad = (patch: Record<string, unknown>): string => JSON.stringify({ ...frame, ...patch });
    expect(parseFrame(42)).toBeNull();
    expect(parseFrame("{")).toBeNull();
    expect(parseFrame("x".repeat(MAX_FRAME_LENGTH + 1))).toBeNull();
    expect(parseFrame(bad({ v: 2 }))).toBeNull();
    expect(parseFrame(bad({ type: "event" }))).toBeNull();
    expect(parseFrame(bad({ extra: true }))).toBeNull();
    expect(parseFrame(bad({ roster: undefined }))).toBeNull();
    expect(parseFrame(bad({ chars: [[2, 0, 0, 1, 0, 1, 0]] }))).toBeNull();
    expect(parseFrame(bad({ bubbles: [{ id: 2, text: "hi" }] }))).toBeNull();
    expect(parseFrame(bad({ roster: [frame.roster[0], frame.roster[0]] }))).toBeNull();
    expect(parseFrame(bad({ chars: [[1, 0, 0, 17, 0, 1, 0]] }))).toBeNull();
    expect(parseFrame(bad({ chars: [[1, 0, 0, 1, 960, 1, 0]] }))).toBeNull();
    expect(parseFrame(bad({ chars: [[1, 0, 0, 1, 0, 0, 0]] }))).toBeNull();
    expect(parseFrame(bad({ chars: [[1, 0.5, 0, 1, 0, 1, 0]] }))).toBeNull();
    expect(parseFrame(bad({ chars: [[1, 0, 0, 1, 0, 1, 8]] }))).toBeNull();
    expect(parseFrame(bad({ roster: [{ id: 1, platform: "instagram", name: "x" }] }))).toBeNull();
    expect(parseFrame(bad({ roster: [{ id: 1, platform: "twitch", name: `a${RLO}b` }] }))).toBeNull();
    expect(parseFrame(bad({ bubbles: [{ id: 1, text: "line\nbreak" }] }))).toBeNull();
    expect(parseFrame(bad({ bubbles: [{ id: 1, text: "x".repeat(BUBBLE_MAX_UNITS + 1) }] }))).toBeNull();
    expect(parseFrame(bad({ terrain: { ...frame.terrain, ground: "gx" } }))).toBeNull();
    const tooMany: CharTuple[] = Array.from({ length: 41 }, (_, i: number): CharTuple => [i + 1, 0, 0, 1, 0, 1, 0]);
    expect(parseFrame(JSON.stringify({ type: "playground", v: 1, full: false, tick: 1, chars: tooMany }))).toBeNull();
    const tickFrame = {
      type: "playground",
      v: 1,
      full: false,
      tick: 1,
      chars: [],
      roster: [frame.roster[0], frame.roster[0]],
    };
    expect(parseFrame(JSON.stringify(tickFrame))).toBeNull();
  });

  it("refuses to encode an invalid or oversized frame", () => {
    expect(() => encodeFrame({ ...full(), chars: [[2, 0, 0, 1, 0, 1, 0]] })).toThrow("no roster entry");
    expect(() => encodeFrame({ ...full(), tick: -1 })).toThrow("frame invalid");
    // Lone surrogates pass the schema but JSON escapes each as six characters.
    const lone = "\uD800".repeat(NAME_MAX_UNITS);
    const big: PlaygroundFullFrame = {
      ...full(),
      chars: Array.from({ length: 40 }, (_, i: number): CharTuple => [i + 1, 0, 0, 1, 0, 1, 0]),
      roster: Array.from({ length: 40 }, (_, i: number) => ({ id: i + 1, platform: "kick" as const, name: lone })),
      bubbles: Array.from({ length: 4 }, (_, i: number) => ({ id: i + 1, text: "\uD800".repeat(BUBBLE_MAX_UNITS) })),
    };
    expect(() => encodeFrame(big)).toThrow("too long");
  });

  it("bounds hostile text by graphemes and code units, never splitting one", () => {
    expect(boundText(`  a\u0000b${RLO} c\n\nd  `, 80, 320)).toBe("a b c d");
    expect(boundText("👩‍🚀👩‍🚀👩‍🚀", 2, 100)).toBe("👩‍🚀👩‍🚀");
    expect(boundText("ab👩‍🚀", 10, 4)).toBe("ab");
    expect(boundText("x\uD800y", 10, 10)).toBe("x�y");
    expect(boundText("Z".repeat(1000), NAME_GRAPHEMES, NAME_MAX_UNITS)).toHaveLength(NAME_GRAPHEMES);
    // With a cut mark, a cut text ends with it inside the limits; a text that fits gets none.
    expect(boundText("abcdef", 4, 100, "…")).toBe("abc…");
    expect(boundText("ab 👩‍🚀👩‍🚀", 10, 9, "…")).toBe("ab 👩‍🚀…");
    expect(boundText("abcd", 4, 100, "…")).toBe("abcd");
    // The Arabic letter mark and the left-to-right and right-to-left marks become spaces too.
    expect(boundText(`a${ALM}b${LRM}c${RLM}d`, 80, 320)).toBe("a b c d");
  });

  it("carries hostile chat as bounded, safe text and never the platform user id", () => {
    const sim = new PlaygroundSim({ cellsW: 16, cellsH: 2, rng: () => 0.5 });
    sim.resumeAfter(0);
    sim.receive(hostile(`${RLO}${"N".repeat(500)}\u0007`));
    const p = sim.list()[0];
    p.state = "walk";
    p.free = false;
    sim.tick();
    const frame = sim.fullFrame();
    const raw: string = encodeFrame(frame);
    expect(raw).not.toContain("secret-user-id");
    expect(frame.roster[0].name).toBe(`${"N".repeat(NAME_GRAPHEMES - 1)}…`);
    expect(frame.bubbles[0].text.length).toBeLessThanOrEqual(BUBBLE_MAX_UNITS);
    expect(frame.bubbles[0].text.startsWith("<img src=x onerror=alert(1)>")).toBe(true);
    expect(parseFrame(raw)).toEqual(frame);
    expect(BUBBLE_GRAPHEMES).toBe(80);
  });
});
