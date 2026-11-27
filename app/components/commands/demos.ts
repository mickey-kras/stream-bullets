import type { ActivityChat } from "../../lib/activity";
import { TILE } from "../../lib/playground/constants";
import type { Command, Participant } from "../../lib/playground/crowd";
import { mulberry32, PlaygroundSim, setState } from "../../lib/playground/sim";
import type { BlockKind } from "../../lib/playground/protocol";
import { cellX, floorY, placeBlock } from "../../lib/playground/terrain";
import { mergeFrame, toView } from "../overlay/characters/adapter";
import type { PlaygroundView } from "../overlay/characters/view";

/**
 * The demos of the commands page: each one is a small playground that runs the real rules. A demo sends its chat
 * lines at fixed ticks, then starts again. The page shows a part of the world, away from the doors.
 */

/** The demo world in layout cells: 35 columns of blocks, so the shown part is far from the doors and their signs. A high demo has room for 8 rows of blocks, the others for 4. */
const CELLS_W = 28;
const CELLS_H = 6;
const CELLS_H_HIGH = 9;
/** The page shows this many columns of the world. */
export const VIEW_COLS = 10;
/** The first shown column. Columns 14 to 18 and 22 to 23 are dirt, columns 19 to 21 are girder. */
const VIEW_FROM = 14;

export interface Demo {
  /** The column and the side where the character starts, on the ground. */
  col: number;
  dir: 1 | -1;
  /** Chat lines: the tick and the text. Lines of one demo are 90 ticks or more apart (the command cooldown). */
  lines: readonly (readonly [number, string])[];
  /** The demo starts again after this many ticks. */
  ticks: number;
  high?: boolean;
  /** Blocks that stand before the first line: column, row, kind. */
  blocks?: readonly (readonly [number, number, BlockKind])[];
  /** The column of a second character. */
  other?: number;
  /** The first shown column, when not VIEW_FROM. */
  from?: number;
}

export const DEMOS: Readonly<Record<Command, Demo>> = {
  left: {
    col: 21,
    dir: 1,
    lines: [
      [15, "!left"],
      [110, "!left 3"],
    ],
    ticks: 220,
  },
  right: {
    col: 15,
    dir: -1,
    lines: [
      [15, "!right"],
      [110, "!right 3"],
    ],
    ticks: 220,
  },
  look: {
    col: 18,
    dir: 1,
    lines: [
      [15, "!look left"],
      [110, "!look right"],
    ],
    ticks: 180,
  },
  stop: {
    col: 14,
    dir: 1,
    lines: [
      [15, "!right 8"],
      [110, "!stop"],
    ],
    ticks: 200,
  },
  jump: { col: 17, dir: 1, lines: [[15, "!jump"]], ticks: 110 },
  block: {
    col: 16,
    dir: 1,
    lines: [
      [15, "!block"],
      [110, "!right"],
    ],
    ticks: 190,
  },
  up: {
    col: 18,
    dir: 1,
    lines: [
      [15, "!up"],
      [110, "!up"],
    ],
    ticks: 190,
  },
  stairs: { col: 15, dir: 1, high: true, lines: [[15, "!stairs 4"]], ticks: 240 },
  bridge: {
    col: 15,
    dir: 1,
    high: true,
    lines: [
      [15, "!up"],
      [110, "!up"],
      [205, "!bridge 5"],
    ],
    ticks: 420,
  },
  grapple: {
    col: 16,
    dir: 1,
    high: true,
    blocks: [
      [21, 0, "dirt"],
      [21, 1, "dirt"],
      [21, 2, "dirt"],
      [19, 3, "plank"],
      [20, 3, "plank"],
      [21, 3, "plank"],
    ],
    lines: [[15, "!grapple"]],
    ticks: 140,
  },
  jetpack: {
    col: 18,
    dir: 1,
    high: true,
    blocks: [
      [20, 0, "dirt"],
      [20, 1, "dirt"],
      [17, 2, "plank"],
      [18, 2, "plank"],
      [19, 2, "plank"],
    ],
    lines: [[15, "!jetpack"]],
    ticks: 150,
  },
  dig: {
    col: 17,
    dir: 1,
    blocks: [
      [18, 0, "dirt"],
      [19, 0, "dirt"],
    ],
    lines: [
      [15, "!dig right 2"],
      [200, "!dig"],
    ],
    ticks: 330,
  },
  boom: {
    col: 16,
    dir: 1,
    from: 9,
    blocks: [
      [15, 0, "dirt"],
      [17, 0, "dirt"],
      [17, 1, "dirt"],
      [18, 0, "stair"],
    ],
    other: 14,
    lines: [[15, "!boom"]],
    ticks: 260,
  },
  dance: { col: 18, dir: 1, lines: [[15, "!dance"]], ticks: 150 },
  wave: { col: 18, dir: 1, lines: [[15, "!wave"]], ticks: 110 },
  cheer: { col: 18, dir: 1, lines: [[15, "!cheer"]], ticks: 100 },
  push: { col: 16, dir: 1, other: 17, lines: [[15, "!push"]], ticks: 130 },
  flag: {
    col: 18,
    dir: 1,
    lines: [
      [15, "!flag"],
      [110, "!left 2"],
    ],
    ticks: 210,
  },
};

/** The shown part of a demo world, in world px. */
export interface DemoFrame {
  cellsW: number;
  cellsH: number;
  width: number;
  height: number;
  left: number;
  shown: number;
}

export function demoFrame(demo: Demo): DemoFrame {
  const cellsH: number = demo.high ? CELLS_H_HIGH : CELLS_H;
  const { w, h } = new PlaygroundSim({ cellsW: CELLS_W, cellsH, rng: mulberry32(1) }).world;
  return {
    cellsW: CELLS_W,
    cellsH,
    width: w,
    height: h,
    left: (demo.from ?? VIEW_FROM) * TILE,
    shown: VIEW_COLS * TILE,
  };
}

function chat(userId: string, name: string, text: string, tick: number): ActivityChat {
  return {
    kind: "chat",
    id: `twitch:${userId}-${tick}`,
    platform: userId === "you" ? "twitch" : "youtube",
    channelId: "demo",
    messageId: `${userId}-${tick}`,
    user: { id: userId, displayName: name },
    text,
    fragments: [{ type: "text", text }],
    badges: [],
    sentAt: null,
    receivedAt: 0,
    live: true,
  };
}

/** A demo that runs: `tick()` moves it by one rules tick, `view()` is the picture after that tick. */
export interface DemoRun {
  tick: () => void;
  view: () => PlaygroundView;
  /** The character that the chat lines steer. */
  you: () => Participant;
}

/** Starts `demo`. `names` are the names over the steered character and over the second character. */
export function runDemo(demo: Demo, names: readonly [string, string]): DemoRun {
  const { cellsW, cellsH } = demoFrame(demo);
  let sim: PlaygroundSim;
  let you: Participant;
  let at = 0;
  const stand = (userId: string, name: string, col: number, dir: 1 | -1): Participant => {
    sim.receive(chat(userId, name, ".", 0));
    const p: Participant | undefined = sim.list().at(-1);
    if (!p) throw new Error("The demo playground admitted no character.");
    p.pendingText = null;
    setState(p, "hold", { x: cellX(col), y: floorY(sim.world, 0), dir, piloted: true, free: false });
    return p;
  };
  const start = (): void => {
    sim = new PlaygroundSim({ cellsW, cellsH, rng: mulberry32(7), walkSpread: 0 });
    sim.resumeAfter(0);
    for (const [c, r, kind] of demo.blocks ?? []) placeBlock(sim.world, sim.terrain, c, r, kind, 1);
    you = stand("you", names[0], demo.col, demo.dir);
    if (demo.other !== undefined) stand("other", names[1], demo.other, -1);
    at = 0;
  };
  start();
  return {
    tick: (): void => {
      if (at >= demo.ticks) start();
      at += 1;
      for (const [tick, text] of demo.lines) if (tick === at) sim.receive(chat("you", names[0], text, at));
      sim.tick();
    },
    view: (): PlaygroundView => {
      const frame = sim.fullFrame();
      const state = mergeFrame(null, frame);
      if (!state) throw new Error("A full frame gave no playground state.");
      return toView(state, frame.chars);
    },
    you: (): Participant => you,
  };
}
