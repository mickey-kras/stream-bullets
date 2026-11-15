import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUFFER_SIZE,
  MAX_AHEAD_MS,
  RENDER_DELAY_MS,
  pushFrame,
  sampleView,
  type TimedView,
} from "../app/components/overlay/characters/interpolate";
import {
  BUBBLE_GAP,
  type BubbleItem,
  type BubbleSlot,
  bubbleCap,
  bubbleLines,
  createMemory,
  draw,
  frameAt,
  LEADER_MIN,
  layoutBubbles,
  showsLabel,
  tailGeometry,
  textDirection,
  type DrawOptions,
  type RenderMemory,
} from "../app/components/overlay/characters/renderer";
import { SheetCache, helmetColor, type Atlas } from "../app/components/overlay/characters/sprites";
import type {
  CharacterState,
  CharacterView,
  PlaygroundView,
  TileView,
} from "../app/components/overlay/characters/view";
import { CHAR_STATES } from "../app/lib/playground/protocol";
import { GENERIC_GLYPH, glyphOf, PLATFORM_GLYPHS } from "../app/components/overlay/wasteland/glyphs";
import { WASTELAND_PLAYGROUND as theme, type Sequence } from "../app/components/overlay/wasteland/playground-theme";

function character(over: Partial<CharacterView> = {}): CharacterView {
  return {
    id: 1,
    x: 100,
    y: 62,
    state: "walk",
    t: 10,
    dir: 1,
    platform: "twitch",
    name: "Misha",
    bubble: null,
    recent: false,
    ...over,
  };
}

function view(characters: CharacterView[], paused: boolean = false): PlaygroundView {
  return {
    world: { width: 640, height: 80, ground: 62 },
    tiles: [],
    stairs: [],
    marks: [],
    doors: { entrance: 40, exit: 600 },
    pad: 206,
    characters,
    speakers: [],
    mode: { test: false, paused },
  };
}

/** Two frames 100 ms apart, sampled half-way between them. */
function halfway(a: CharacterView, b: CharacterView, paused: boolean = false): CharacterView {
  let buffer: TimedView[] = pushFrame([], view([a], paused), 1000);
  buffer = pushFrame(buffer, view([b], paused), 1100);
  const sampled: PlaygroundView | null = sampleView(buffer, 1050 + RENDER_DELAY_MS, false);
  expect(sampled).not.toBeNull();
  return sampled?.characters[0] ?? a;
}

describe("playground interpolation", () => {
  it("slides between two frames of the same state and advances animation time", () => {
    const c: CharacterView = halfway(character(), character({ x: 110, y: 60, t: 13 }));
    expect(c.x).toBeCloseTo(105);
    expect(c.y).toBeCloseTo(61);
    expect(c.t).toBeCloseTo(11.5);
  });

  it("does not slide across a state change or a teleport", () => {
    expect(halfway(character(), character({ x: 110, state: "jump" })).x).toBe(100);
    expect(halfway(character(), character({ x: 125 })).x).toBe(100);
    expect(halfway(character(), character({ y: 30 })).y).toBe(62);
    expect(halfway(character(), character({ x: 124 })).x).toBeCloseTo(112);
  });

  it("freezes animation time and position while paused", () => {
    const c: CharacterView = halfway(character(), character({ x: 110, t: 13 }), true);
    expect([c.x, c.t]).toEqual([100, 10]);
  });

  it("keeps a character until the frame that removes it, and limits time past the newest frame", () => {
    let buffer: TimedView[] = pushFrame([], view([character()]), 1000);
    buffer = pushFrame(buffer, view([]), 1100);
    expect(sampleView(buffer, 1150, false)?.characters).toHaveLength(1);
    expect(sampleView(buffer, 1250, false)?.characters).toHaveLength(0);
    const late: PlaygroundView | null = sampleView([{ at: 1000, view: view([character()]) }], 9000, false);
    expect(late?.characters[0].t).toBeCloseTo(10 + (MAX_AHEAD_MS * 30) / 1000);
  });

  it("shows the newest frame unchanged with reduced motion, and nothing without frames", () => {
    const newest: PlaygroundView = view([character({ x: 300 })]);
    const buffer: TimedView[] = pushFrame(pushFrame([], view([character()]), 1000), newest, 1100);
    expect(sampleView(buffer, 1150, true)).toBe(newest);
    expect(sampleView([], 1000, false)).toBeNull();
  });

  it("keeps a bounded buffer and restarts it when time goes back", () => {
    let buffer: TimedView[] = [];
    for (let i = 0; i < BUFFER_SIZE + 5; i++) buffer = pushFrame(buffer, view([]), i * 100);
    expect(buffer).toHaveLength(BUFFER_SIZE);
    expect(pushFrame(buffer, view([]), 50)).toHaveLength(1);
  });
});

describe("playground labels", () => {
  it("put the chat card glyph of the platform on the name tag, and a generic one for another platform", () => {
    expect(glyphOf("twitch")).toBe(PLATFORM_GLYPHS.twitch);
    expect(glyphOf("youtube")).toBe(PLATFORM_GLYPHS.youtube);
    expect(glyphOf("kick")).toBe(PLATFORM_GLYPHS.kick);
    for (const platform of ["instagram", "tiktok", "toString", ""]) expect(glyphOf(platform)).toBe(GENERIC_GLYPH);
    const shapes = [...Object.values(PLATFORM_GLYPHS), GENERIC_GLYPH].map((glyph) => glyph.map((shape) => shape.d));
    expect(new Set(shapes.map((d) => d.join("|"))).size).toBe(shapes.length);
  });

  it("give a bubble 3 lines over a standing speaker in a 240 px cell, fewer near the top edge, never fewer than one", () => {
    // In a 2-row cell the tail of a standing speaker's bubble ends 110 design px below the top: (62 - 30 + 5) x 3 - 1.
    const room: number = (62 - theme.courier.anchor.y + 5) * 3 - 1;
    expect(bubbleLines(theme, room)).toBe(3);
    expect(bubbleLines(theme, room - 1)).toBe(2);
    expect(bubbleLines(theme, 62)).toBe(1);
    expect(bubbleLines(theme, 0)).toBe(1);
    expect(bubbleLines(theme, 400)).toBe(theme.label.bubble.maxLines);
  });

  it("take the direction of the first strong character: Hebrew and Arabic right to left", () => {
    expect(textDirection("שלום, עולם!")).toBe("rtl");
    expect(textDirection("«مرحبا» يا صديقي")).toBe("rtl");
    expect(textDirection("123 שלום")).toBe("rtl");
    expect(textDirection("hello שלום")).toBe("ltr");
    expect(textDirection("!!! gg")).toBe("ltr");
    expect(textDirection("")).toBe("ltr");
  });

  it("cap the bubble width: the theme maximum, a third of a narrow layer", () => {
    expect(bubbleCap(theme, 1920)).toBe(theme.label.bubble.maxWidth);
    expect(bubbleCap(theme, 720)).toBe(240);
  });

  it("show only for speaking, acting or just admitted characters", () => {
    expect(showsLabel(character())).toBe(false);
    expect(showsLabel(character({ state: "goto" }))).toBe(false);
    expect(showsLabel(character({ bubble: "hi" }))).toBe(true);
    expect(showsLabel(character({ recent: true }))).toBe(true);
    for (const state of ["jump", "dig", "build", "bwalk", "wave", "boom", "fall"] as const) {
      expect(showsLabel(character({ state }))).toBe(true);
    }
  });
});

describe("playground bubble layout", () => {
  const right = (slot: BubbleSlot): number => slot.left + slot.width;
  /** Slots in x order never overlap, keep the gap, stay on the layer, and keep the tail inside the bubble. */
  function expectTidy(slots: BubbleSlot[], width: number): void {
    const inOrder: BubbleSlot[] = [...slots].sort((a: BubbleSlot, b: BubbleSlot) => a.left - b.left);
    inOrder.forEach((slot: BubbleSlot, i: number): void => {
      expect(slot.left).toBeGreaterThanOrEqual(0);
      expect(right(slot)).toBeLessThanOrEqual(width);
      expect(slot.tail).toBeGreaterThan(slot.left);
      expect(slot.tail).toBeLessThan(right(slot));
      if (i > 0) expect(slot.left).toBeGreaterThanOrEqual(right(inOrder[i - 1]) + BUBBLE_GAP);
    });
  }

  it("puts 4 bubbles of a crowd side by side on a 1920 px layer, near their speakers", () => {
    const items: BubbleItem[] = [
      { x: 582, width: 272 },
      { x: 408, width: 350 },
      { x: 675, width: 100 },
      { x: 273, width: 108 },
    ];
    const slots: BubbleSlot[] = layoutBubbles(items, 1920, 360);
    expect(slots.map((slot: BubbleSlot) => slot.index)).toEqual([0, 1, 2, 3]);
    expectTidy(slots, 1920);
    // The row centres on its speakers: no bubble is further than half the row from its speaker.
    for (const slot of slots) expect(Math.abs(slot.tail - items[slot.index].x)).toBeLessThan(430);
  });

  it("leaves a lone bubble centred on its speaker, and keeps it on the layer at an edge", () => {
    expect(layoutBubbles([{ x: 900, width: 200 }], 1920, 360)).toEqual([
      { index: 0, left: 800, width: 200, tail: 900 },
    ]);
    const [edge] = layoutBubbles([{ x: 1910, width: 200 }], 1920, 360);
    expect(edge).toEqual({ index: 0, left: 1720, width: 200, tail: 1904 });
    expect(layoutBubbles([{ x: 5, width: 500 }], 1920, 360)[0]).toMatchObject({ left: 0, width: 360, tail: 16 });
  });

  it("fits 4 short bubbles on a 720 px layer and drops the oldest when they cannot fit", () => {
    const short: BubbleItem[] = [400, 410, 420, 430].map((x: number) => ({ x, width: 150 }));
    const all: BubbleSlot[] = layoutBubbles(short, 720, 240);
    expect(all).toHaveLength(4);
    expectTidy(all, 720);
    const wide: BubbleItem[] = [400, 410, 420, 430].map((x: number) => ({ x, width: 240 }));
    const kept: BubbleSlot[] = layoutBubbles(wide, 720, 240);
    // 4 x 240 + gaps is wider than 720, and so is 3 x 240 + 2 gaps: the two oldest go.
    expect(kept.map((slot: BubbleSlot) => slot.index)).toEqual([2, 3]);
    expectTidy(kept, 720);
  });

  it("points the tail at a near speaker, and adds a leader line to the head of a speaker far to the side", () => {
    // Near: the tail tip turns towards the head, at most 10 px, and needs no leader.
    expect(tailGeometry(500, 100, { x: 520, y: 106 })).toEqual({ tip: 510, leader: null });
    expect(tailGeometry(500, 100, { x: 500 + LEADER_MIN, y: 106 })).toEqual({ tip: 510, leader: null });
    // Far: a leader from the tail tip, under the bottom border, to just above the helmet. A bubble stands with its
    // bottom one tail above the head's label point.
    const far = tailGeometry(500, 100, { x: 800, y: 106 });
    expect(far.tip).toBe(510);
    expect(far.leader).toEqual([
      { x: 510, y: 104.5 },
      { x: 800, y: 108 },
    ]);
    expect(tailGeometry(500, 100, { x: 200, y: 106 }).leader?.[1]).toEqual({ x: 200, y: 108 });
    // A head above the tail tip (a bubble pushed down at the top edge) gets no leader.
    expect(tailGeometry(500, 100, { x: 800, y: 100 }).leader).toBeNull();
  });

  it("returns nothing for no bubbles", () => {
    expect(layoutBubbles([], 1920, 360)).toEqual([]);
  });
});

describe("playground animation frames", () => {
  const sequence = (state: CharacterState): Sequence => {
    const s: Sequence | null = theme.sequences[state];
    if (!s) throw new Error(`no sequence for ${state}`);
    return s;
  };

  it("loops, holds and follows the jump and explosion timing", () => {
    expect([0, 4, 8, 12, 16].map((t: number) => frameAt(sequence("walk"), t))).toEqual([0, 1, 2, 3, 0]);
    expect([0, 3, 4, 19, 20, 90].map((t: number) => frameAt(sequence("jump"), t))).toEqual([0, 0, 1, 1, 2, 2]);
    expect([0, 23, 24, 30, 36, 99].map((t: number) => frameAt(sequence("boom"), t))).toEqual([0, 0, 1, 2, 3, 3]);
    expect([0, 6, 8, 16, 24].map((t: number) => frameAt(sequence("fall"), t))).toEqual([0, 1, 2, 1, 2]);
    expect(frameAt(sequence("turn"), 99)).toBe(3);
  });

  it("covers every simulation state, and only gone draws nothing", () => {
    for (const state of CHAR_STATES) {
      const s: Sequence | null = theme.sequences[state];
      if (state === "gone") expect(s).toBeNull();
      else expect(s && theme.courier.rows.includes(s.row) && s.frames.every((f: number) => f >= 0 && f < 4)).toBe(true);
    }
  });
});

describe("playground helmet sheets", () => {
  it("use the platform colour, grey for other platforms, and one sheet per colour", () => {
    expect(helmetColor(theme, "youtube")).toBe("#e5322d");
    expect(helmetColor(theme, "twitch")).toBe("#9146ff");
    expect(helmetColor(theme, "kick")).toBe("#53fc18");
    expect(helmetColor(theme, "instagram")).toBe("#b8794a");
    expect(helmetColor(theme, "velora")).toBe("#9e9e9e");
    expect(helmetColor(theme, "constructor")).toBe("#9e9e9e");
    const built: string[] = [];
    const cache = new SheetCache<string>(theme, (color: string): string => {
      built.push(color);
      return `sheet ${color}`;
    });
    expect(cache.get("twitch")).toBe("sheet #9146ff");
    cache.get("twitch");
    cache.get("velora");
    cache.get("vpzone");
    expect(built).toEqual(["#9146ff", "#9e9e9e"]);
    expect(cache.size).toBe(2);
  });
});

interface CanvasCall {
  method: string;
  args: unknown[];
}

/** A command recorder with deterministic text metrics; the renderer and atlas cache remain real. */
class RenderCanvas {
  width = 1920;
  height = 240;
  readonly calls: CanvasCall[] = [];
  readonly context: CanvasRenderingContext2D;

  constructor() {
    const values: Record<string, unknown> = {
      canvas: this,
      measureText: (text: string): Pick<TextMetrics, "width"> => ({ width: [...text].length * 8 }),
    };
    this.context = new Proxy(values, {
      get: (target: Record<string, unknown>, method: string): unknown =>
        method in target
          ? target[method]
          : (...args: unknown[]): void => {
              this.calls.push({ method, args });
            },
    }) as unknown as CanvasRenderingContext2D;
  }

  getContext(): CanvasRenderingContext2D {
    return this.context;
  }
}

describe("playground canvas rendering", () => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  function renderer(): {
    canvas: RenderCanvas;
    memory: RenderMemory;
    atlas: Atlas;
    labels: RenderCanvas[];
    render: (moment: PlaygroundView, now: number, reduced?: boolean) => void;
  } {
    const canvas = new RenderCanvas();
    const labels: RenderCanvas[] = [];
    vi.stubGlobal("document", {
      createElement: (tag: string): RenderCanvas => {
        expect(tag).toBe("canvas");
        const label = new RenderCanvas();
        labels.push(label);
        return label;
      },
    });
    vi.stubGlobal(
      "Path2D",
      class {
        constructor(readonly path: string) {}
      },
    );
    const memory: RenderMemory = createMemory();
    const atlas: Atlas = {
      terrain: { width: 256, height: 256 } as HTMLImageElement,
      sheets: new SheetCache(theme, (): HTMLCanvasElement => new RenderCanvas() as unknown as HTMLCanvasElement),
    };
    return {
      canvas,
      memory,
      atlas,
      labels,
      render: (moment: PlaygroundView, now: number, reduced: boolean = false): void => {
        const options: DrawOptions = { reduced, badges: { test: "Test mode", paused: "Paused" } };
        draw(canvas.context, moment, theme, atlas, now, memory, options);
      },
    };
  }

  const dirt = (): TileView[] => Array.from({ length: 40 }, (): TileView => ({ kind: "dirt", stage: 0 }));

  it("spawns digging debris only on a dirt strike, advances it and removes expired particles", () => {
    const { render, memory, canvas } = renderer();
    const moment: PlaygroundView = { ...view([character({ state: "dig", x: 32, t: 14 })]), tiles: dirt() };
    render(moment, 1000);
    expect(memory.particles).toHaveLength(0);
    render({ ...moment, characters: [character({ state: "dig", x: 32, t: 15 })] }, 1000 + 1000 / 30);
    expect(memory.particles).toHaveLength(7);
    expect(memory.particles.filter((particle) => particle.picture !== null)).toHaveLength(4);
    expect(memory.particles.filter((particle) => particle.color !== null)).toHaveLength(3);
    expect(memory.particles.every((particle) => particle.x === 40 && particle.y === 60)).toBe(true);
    const x: number = memory.particles[0].x;
    render({ ...moment, characters: [character({ state: "dig", x: 32, t: 16 })] }, 1000 + 2000 / 30);
    expect(memory.particles).toHaveLength(7);
    expect(memory.particles[0].life).toBeCloseTo(25);
    expect(memory.particles[0].x).not.toBe(x);
    expect(canvas.calls.some((call) => call.method === "fillRect" && call.args[2] === 1 && call.args[3] === 1)).toBe(
      true,
    );
    for (const now of [2000, 3000, 4000]) render(view([]), now);
    expect(memory.particles).toHaveLength(0);
    expect(memory.seen.size).toBe(0);

    const girder: PlaygroundView = { ...moment, tiles: dirt().map(() => ({ kind: "girder", stage: 0 })) };
    render(girder, 5000);
    render({ ...girder, characters: [character({ state: "dig", x: 32, t: 15 })] }, 5034);
    expect(memory.particles).toHaveLength(0);
  });

  it("emits rocks once when a tile breaks and body pieces once at the explosion frame", () => {
    const { render, memory, atlas } = renderer();
    const intact: PlaygroundView = { ...view([character({ state: "boom", t: 29 })]), tiles: dirt() };
    render(intact, 1000);
    const broken: TileView[] = dirt();
    broken[5] = { kind: "dirt", stage: 3 };
    const blast: PlaygroundView = { ...intact, tiles: broken, characters: [character({ state: "boom", t: 30 })] };
    render(blast, 1034);
    expect(memory.particles).toHaveLength(27);
    expect(memory.particles.filter((particle) => particle.picture?.image === atlas.terrain)).toHaveLength(10);
    expect(memory.particles.filter((particle) => particle.picture?.image === atlas.sheets.get("twitch"))).toHaveLength(
      3,
    );
    expect(memory.particles.filter((particle) => particle.color !== null)).toHaveLength(14);
    expect(
      memory.particles.filter((particle) => particle.life === 48).map((particle) => particle.picture?.rect),
    ).toEqual([theme.courier.boot, theme.courier.boot, theme.courier.helmet]);
    render(blast, 1068);
    expect(memory.particles).toHaveLength(27);
    render({ ...blast, mode: { test: true, paused: true } }, 1102, true);
    expect(memory.particles).toHaveLength(0);
  });

  it("bounds debris during a large terrain collapse instead of growing it with every broken tile", () => {
    const { render, memory } = renderer();
    render({ ...view([]), tiles: dirt() }, 1000);
    render({ ...view([]), tiles: dirt().map(() => ({ kind: "dirt", stage: 3 })) }, 1034);
    expect(memory.particles).toHaveLength(160);
    expect(memory.particles.every((particle) => particle.picture !== null)).toBe(true);
  });

  it("draws cracked tiles, girder ends, stairs, active doors, respawn pads and unavailable marks", () => {
    const { render, canvas } = renderer();
    const moment: PlaygroundView = {
      ...view([
        character({ state: "enter" }),
        character({ id: 2, state: "exit", dir: -1 }),
        character({ id: 3, state: "respawn" }),
        character({ id: 4, state: "gone" }),
      ]),
      tiles: [
        { kind: "girder", stage: 0 },
        { kind: "girder", stage: 0 },
        { kind: "girder", stage: 0 },
        { kind: "dirt", stage: 1 },
        { kind: "dirt", stage: 2 },
        { kind: "dirt", stage: 3 },
        { kind: "girder", stage: 0 },
      ],
      stairs: [
        { x: 80, top: 45, dir: -1 },
        { x: 90, top: 59, dir: 1 },
      ],
      marks: [{ x: 90.4, y: 20.7 }],
    };
    render(moment, theme.blinkMs * 2);
    const pictures: unknown[][] = canvas.calls
      .filter((call) => call.method === "drawImage")
      .map((call) => call.args.slice(1, 5));
    for (const name of ["girderL", "girderM", "girderR", "crack1", "crack2", "hole", "padActive"] as const) {
      expect(pictures).toContainEqual([...theme.terrain.rects[name]]);
    }
    expect(canvas.calls).toContainEqual({ method: "scale", args: [-1, 1] });
    expect(canvas.calls.some((call) => call.method === "fillRect" && call.args[2] === 3 && call.args[3] === 3)).toBe(
      true,
    );
    expect(
      canvas.calls.filter((call) => call.method === "drawImage" && call.args.length === 9 && call.args[8] === 14),
    ).toHaveLength(1);
    canvas.calls.length = 0;
    render({ ...moment, world: { ...moment.world, ground: 10 } }, theme.blinkMs * 3, true);
    expect(
      canvas.calls.some(
        (call) =>
          call.method === "drawImage" &&
          JSON.stringify(call.args.slice(1, 5)) === JSON.stringify(theme.terrain.rects.flag0),
      ),
    ).toBe(false);
  });

  it("caches labels, wraps long speech, respects RTL names and keeps badges above low bubbles", () => {
    const { render, canvas, labels, memory } = renderer();
    const speaker: CharacterView = character({
      x: 220,
      y: 35,
      name: "שלום עולם",
      bubble: "One verylongwordwithoutspaces and another sentence that must wrap and be cut.",
    });
    const moment: PlaygroundView = {
      ...view([speaker, character({ id: 2, x: 20, recent: true, platform: "unknown", name: "שלום".repeat(30) })]),
      speakers: [999, 1],
      mode: { test: true, paused: true },
    };
    canvas.width = 720;
    render(moment, 1000);
    expect(memory.labels.size).toBeGreaterThanOrEqual(2);
    const rendered: string[] = labels.flatMap((label) =>
      label.calls.filter((call) => call.method === "fillText").map((call) => String(call.args[0])),
    );
    expect(rendered).toContain("שלום עולם");
    expect(rendered.some((text) => text.endsWith("…"))).toBe(true);
    expect(labels.some((label) => label.context.direction === "rtl")).toBe(true);
    expect(canvas.calls.filter((call) => call.method === "fillText").map((call) => call.args[0])).toEqual([
      "Test mode",
      "Paused",
    ]);
    const count: number = labels.length;
    render(moment, 1034);
    expect(labels).toHaveLength(count);
    expect(memory.labels.size).toBeGreaterThanOrEqual(2);
    for (let id: number = 3; id <= 205; id += 1)
      render(view([character({ id, recent: true, name: `Viewer ${id}` })]), 1000 + id * 34, true);
    expect(memory.labels.size).toBeLessThan(200);
    expect([...memory.labels.keys()].some((key) => key.includes("Viewer 205"))).toBe(true);
  });
});
