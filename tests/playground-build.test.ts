import { describe, expect, it } from "vitest";
import type { ActivityChat, ActivityPlatform } from "../app/lib/activity";
import { MARK_TICKS, TILE } from "../app/lib/playground/constants";
import { chooseCrowd, type Participant, platformReserve } from "../app/lib/playground/crowd";
import { encodeFrame, parseFrame } from "../app/lib/playground/protocol";
import { mulberry32, PlaygroundSim, parseCommand, setState } from "../app/lib/playground/sim";
import {
  type Block,
  blockAt,
  blockOrder,
  blocksString,
  canPlace,
  cellX,
  colOf,
  floorY,
  placeBlock,
  protectedCell,
  removeBlock,
  rowOf,
} from "../app/lib/playground/terrain";

/** The build rules of the character playground (docs/characters.md): blocks, the commands that use them, and the crowd. */

let seq = 0;

function chat(platform: ActivityPlatform, userId: string, text: string): ActivityChat {
  seq += 1;
  return {
    kind: "chat",
    id: `${platform}:b${seq}`,
    platform,
    channelId: "c1",
    messageId: `b${seq}`,
    user: { id: userId, displayName: userId },
    text,
    fragments: [{ type: "text", text }],
    badges: [],
    sentAt: null,
    receivedAt: 1_800_000_000_000,
    live: true,
  };
}

/** The column where the steered character starts: dirt ground, far from the doors and the pad. */
const START = 18;

interface Stage {
  sim: PlaygroundSim;
  p: Participant;
  /** Runs a chat command at once and ticks until the character stands again. Returns the ticks. */
  run: (text: string) => number;
  tick: (n?: number) => void;
  col: () => number;
  row: () => number;
  block: (c: number, r: number) => Block | null;
  put: (c: number, r: number, kind?: Block["kind"]) => void;
}

/** A full frame world (32 x 18 cells) with one steered character that stands on the ground in column START. */
function stage(): Stage {
  const sim = new PlaygroundSim({ cellsW: 32, cellsH: 18, rng: mulberry32(7), walkSpread: 0 });
  sim.resumeAfter(0);
  sim.receive(chat("twitch", "builder", "hello"));
  const p = sim.list()[0];
  p.pendingText = null;
  setState(p, "hold", { x: cellX(START), y: sim.world.gy, dir: 1, piloted: true, free: false });
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      // Keeps the character active, so it does not walk out during a long test.
      p.lastChat = sim.clock;
      sim.tick();
    }
  };
  return {
    sim,
    p,
    tick,
    run: (text: string): number => {
      const call = parseCommand(text);
      if (!call) throw new Error(`not a command: ${text}`);
      sim.perform(p, call.name, "", call.n, call.side);
      let ticks = 0;
      while (ticks < 900 && (p.state !== "hold" || p.job !== null)) {
        tick();
        ticks += 1;
      }
      // One more tick shows a missing floor.
      tick();
      while (ticks < 900 && (p.state !== "hold" || p.job !== null)) {
        tick();
        ticks += 1;
      }
      expect(p.state, text).toBe("hold");
      return ticks;
    },
    col: (): number => colOf(p.x),
    row: (): number => rowOf(sim.world, p.y),
    block: (c: number, r: number): Block | null => blockAt(sim.world, sim.terrain, c, r),
    put: (c: number, r: number, kind: Block["kind"] = "dirt"): void =>
      placeBlock(sim.world, sim.terrain, c, r, kind, 1),
  };
}

describe("walking", () => {
  it("walks one block without a number, and the number of blocks with one", () => {
    const s = stage();
    s.run("!right");
    expect(s.p.x).toBe(cellX(START + 1));
    s.run("!right 3");
    expect(s.p.x).toBe(cellX(START + 4));
    s.run("!l 2");
    expect(s.p.x).toBe(cellX(START + 2));
    expect(s.p.dir).toBe(-1);
    expect(s.p.mark).toBe(0);
  });

  it("goes up one block alone and stops at a wall of two", () => {
    const s = stage();
    s.put(START + 1, 0);
    s.put(START + 3, 0);
    s.put(START + 3, 1);
    s.run("!right 5");
    expect([s.col(), s.row()]).toEqual([START + 2, 0]);
    expect(s.p.mark).toBeGreaterThan(0);
    expect(s.p.x).toBeLessThan((START + 3) * TILE);
  });

  it("stands on a block that it walked up", () => {
    const s = stage();
    s.put(START + 1, 0);
    s.run("!right");
    expect([s.col(), s.row()]).toEqual([START + 1, 1]);
    expect(s.p.y).toBe(floorY(s.sim.world, 1));
  });

  it("walks off an edge and falls", () => {
    const s = stage();
    s.run("!up");
    s.run("!up");
    expect(s.row()).toBe(2);
    s.run("!right");
    expect(s.row()).toBe(0);
    expect(s.col()).toBe(START + 1);
    expect(s.p.mark).toBe(0);
  });

  it("does not go on with a walk after a gap ended it in the middle of a fall", () => {
    const s = stage();
    s.run("!up");
    s.run("!up");
    s.sim.perform(s.p, "right", "", 5);
    for (let i = 0; i < 60 && s.p.state !== "fall"; i++) s.tick();
    expect([s.p.state, s.p.resume]).toEqual(["fall", true]);
    s.sim.skip(30);
    expect([s.p.state, s.p.resume, s.p.piloted]).toEqual(["walk", false, false]);
  });

  it("stops at a door zone on the ground", () => {
    const s = stage();
    setState(s.p, "hold", { x: cellX(6), y: s.sim.world.gy });
    s.run("!left 5");
    expect(s.p.x).toBeGreaterThanOrEqual(s.sim.world.xmin - 1);
    expect(s.p.mark).toBeGreaterThan(0);
  });

  it("turns with look, and stops at once with stop", () => {
    const s = stage();
    s.run("!look left");
    expect(s.p.dir).toBe(-1);
    expect(s.p.x).toBe(cellX(START));
    s.run("!look left");
    expect(s.p.dir).toBe(-1);
    s.run("!turn");
    expect(s.p.dir).toBe(1);
    s.sim.perform(s.p, "right", "", 10);
    s.tick(20);
    expect(s.p.state).toBe("step");
    s.p.lastCommand = -1000;
    s.sim.receive(chat("twitch", "builder", "!stop"));
    expect(s.p.state).toBe("hold");
    const x: number = s.p.x;
    s.tick(30);
    expect(s.p.x).toBe(x);
  });

  it("ends a dig at once with stop, so the hits that are left do not break the ground", () => {
    const s = stage();
    for (const c of [1, 2, 3]) s.put(START + c, 0);
    s.sim.perform(s.p, "dig", "", 3, 1);
    s.tick(90);
    expect(s.p.state).toBe("dig");
    s.p.lastCommand = -1000;
    s.sim.receive(chat("twitch", "builder", "!stop"));
    expect(s.p.state).toBe("hold");
    s.tick(120);
    expect(s.sim.terrain.tiles.every((tile) => tile.stage === 0)).toBe(true);
    expect(s.sim.terrain.count).toBe(2);
    expect(s.row()).toBe(0);
  });

  it("does not stop a character on its way in: it takes commands after it comes in", () => {
    const sim = new PlaygroundSim({ cellsW: 32, cellsH: 18, rng: mulberry32(2), walkSpread: 0 });
    sim.resumeAfter(0);
    sim.tick();
    sim.receive(chat("kick", "entrant", "!right"));
    const p = sim.list()[0];
    for (let i = 0; i < 40; i++) sim.tick();
    expect([p.state, p.free]).toEqual(["walk", true]);
    p.lastCommand = -1000;
    sim.receive(chat("kick", "entrant", "!stop"));
    // The stop takes the queued walk. The character still walks in, and then it takes the next command.
    expect([p.state, p.free, p.pending]).toEqual(["walk", true, null]);
    for (let i = 0; i < 120; i++) sim.tick();
    expect(p.free).toBe(false);
    p.lastCommand = -1000;
    sim.receive(chat("kick", "entrant", "!wave"));
    sim.tick();
    expect(p.state).toBe("wave");
  });

  it("ends a walk with stop in the middle of a climb: the character stays on top of the block", () => {
    const s = stage();
    s.put(START + 2, 0);
    s.sim.perform(s.p, "right", "", 10);
    for (let i = 0; i < 80 && s.p.state !== "climb"; i++) s.tick();
    expect(s.p.state).toBe("climb");
    s.p.lastCommand = -1000;
    s.sim.receive(chat("twitch", "builder", "!stop"));
    s.tick(60);
    expect(s.p.state).toBe("hold");
    expect([s.col(), s.row()]).toEqual([START + 2, 1]);
  });

  it("takes one more block when another steered character stands at the target", () => {
    const s = stage();
    s.sim.receive(chat("kick", "other", "hello"));
    const other = s.sim.list()[1];
    setState(other, "hold", { x: cellX(START + 1), y: s.sim.world.gy, piloted: true, free: false, admitted: true });
    s.run("!right");
    expect(s.p.x).toBe(cellX(START + 2));
  });
});

describe("building", () => {
  it("puts a block in front, then one on top of it", () => {
    const s = stage();
    s.run("!block");
    expect(s.block(START + 1, 0)?.kind).toBe("dirt");
    s.run("!box");
    expect(s.block(START + 1, 1)?.kind).toBe("dirt");
    s.run("!block");
    expect(s.sim.terrain.count).toBe(2);
    expect(s.p.mark).toBeGreaterThan(0);
  });

  it("builds to the side that the command names", () => {
    const s = stage();
    s.run("!block left");
    expect(s.p.dir).toBe(-1);
    expect(s.block(START - 1, 0)?.kind).toBe("dirt");
  });

  it("lifts the character with up", () => {
    const s = stage();
    for (let i = 1; i <= 3; i++) {
      s.run("!up");
      expect(s.row()).toBe(i);
    }
    expect(s.p.x).toBe(cellX(START));
    expect(s.sim.terrain.count).toBe(3);
  });

  it("builds one stair without a number, and climbs as many as the number", () => {
    const s = stage();
    s.run("!stairs");
    expect(s.block(START + 1, 0)).toMatchObject({ kind: "stair", dir: 1 });
    expect([s.col(), s.row()]).toEqual([START + 1, 1]);
    s.run("!build 3");
    expect([s.col(), s.row()]).toEqual([START + 4, 4]);
    expect(s.sim.terrain.count).toBe(4);
    for (let i = 0; i < 4; i++) expect(s.block(START + 1 + i, i)?.kind).toBe("stair");
  });

  it("builds at most five stairs for one command", () => {
    const s = stage();
    s.run("!stairs 9");
    expect(s.sim.terrain.count).toBe(5);
  });

  it("lays planks from a build, one without a number", () => {
    const s = stage();
    s.run("!bridge");
    expect(s.p.mark).toBeGreaterThan(0);
    s.p.mark = 0;
    s.run("!up");
    s.run("!up");
    s.run("!bridge");
    expect(s.block(START + 1, 1)?.kind).toBe("plank");
    expect([s.col(), s.row()]).toEqual([START + 1, 2]);
    s.run("!bridge 3");
    expect([s.col(), s.row()]).toEqual([START + 4, 2]);
    for (let c = START + 1; c <= START + 4; c++) expect(s.block(c, 1)?.kind).toBe("plank");
    expect(s.p.mark).toBe(0);
  });

  it("lays a plank over a hole in the ground from a build beside it, and the plank holds", () => {
    const s = stage();
    s.run("!up");
    s.sim.terrain.tiles[START + 1].stage = 3;
    // Without a build beside it, nothing goes over the hole.
    s.sim.terrain.tiles[START + 5].stage = 3;
    expect(canPlace(s.sim.world, s.sim.terrain, START + 5, 0)).toBe(false);
    s.run("!bridge");
    expect(s.block(START + 1, 0)?.kind).toBe("plank");
    expect([s.col(), s.row()]).toEqual([START + 1, 1]);
    s.tick(30);
    expect(s.block(START + 1, 0)?.kind).toBe("plank");
    expect(s.row()).toBe(1);
  });

  it("keeps the doors and the respawn pad free", () => {
    const s = stage();
    const { world, terrain } = s.sim;
    expect(protectedCell(world, 2, 0)).toBe(true);
    expect(protectedCell(world, world.cols - 1, 4)).toBe(true);
    expect(protectedCell(world, 2, 5)).toBe(false);
    expect(protectedCell(world, colOf(world.padX), 2)).toBe(true);
    expect(canPlace(world, terrain, 2, 0)).toBe(false);
    expect(canPlace(world, terrain, START, 0)).toBe(true);
    // A block must touch the ground or another block.
    expect(canPlace(world, terrain, START, 2)).toBe(false);
    expect(canPlace(world, terrain, START, world.rows)).toBe(false);
  });

  it("removes the oldest block at the limit of the world", () => {
    const s = stage();
    const { world, terrain } = s.sim;
    let placed = 0;
    for (let r = 0; r < world.rows && placed < world.cap; r++) {
      for (let c = 8; c < 32 && placed < world.cap; c++) {
        s.put(c, r);
        placed += 1;
      }
    }
    expect(terrain.count).toBe(world.cap);
    expect(s.block(8, 0)).not.toBeNull();
    s.put(33, 0);
    expect(terrain.count).toBe(world.cap);
    expect(s.block(8, 0)).toBeNull();
    expect(s.block(33, 0)).not.toBeNull();
  });

  it("plants one flag for a character, and moves it with the next one", () => {
    const s = stage();
    s.run("!flag");
    expect(s.sim.fullFrame().extras.flags).toEqual([[s.p.id, cellX(START), s.sim.world.gy]]);
    s.run("!up");
    s.run("!flag");
    expect(s.sim.fullFrame().extras.flags).toEqual([[s.p.id, cellX(START), floorY(s.sim.world, 1)]]);
    s.sim.remove(s.p.id);
    expect(s.sim.terrain.flags).toHaveLength(0);
  });
});

describe("breaking", () => {
  it("digs the block under the feet in three hits, as deep as the number", () => {
    const s = stage();
    for (let i = 0; i < 4; i++) s.run("!up");
    s.sim.perform(s.p, "dig");
    s.tick(16);
    expect(s.block(START, 3)?.stage).toBe(1);
    s.tick(20);
    expect(s.block(START, 3)?.stage).toBe(2);
    s.tick(20);
    expect(s.block(START, 3)).toBeNull();
    s.tick(30);
    expect(s.row()).toBe(3);
    s.run("!dig 2");
    expect(s.row()).toBe(1);
    expect(s.sim.terrain.count).toBe(1);
  });

  it("digs to the side and walks into the gap", () => {
    const s = stage();
    for (const c of [1, 2, 3]) {
      s.put(START + c, 0);
      s.put(START + c, 1);
    }
    s.run("!dig right");
    expect(s.block(START + 1, 0)).toBeNull();
    expect(s.block(START + 1, 1)).not.toBeNull();
    expect(s.col()).toBe(START);
    s.run("!dig r 2");
    expect(s.block(START + 1, 1)).toBeNull();
    expect(s.block(START + 2, 0)).toBeNull();
    expect(s.col()).toBe(START + 1);
    s.run("!dig left");
    expect(s.p.mark).toBeGreaterThan(0);
  });

  it("goes on with a dig of more blocks after a block that had damage breaks early", () => {
    const s = stage();
    for (const c of [1, 2, 3]) s.put(START + c, 0);
    (s.block(START + 1, 0) as Block).stage = 2;
    s.run("!dig right 3");
    for (const c of [1, 2, 3]) expect(s.block(START + c, 0)).toBeNull();
    expect(s.col()).toBe(START + 2);
    expect(s.p.mark).toBe(0);
  });

  it("still digs a hole in the ground dirt, and not in a girder", () => {
    const s = stage();
    s.sim.perform(s.p, "dig");
    s.tick(60);
    expect(s.sim.terrain.tiles[START].stage).toBe(3);
    s.tick(120);
    expect(["gone", "respawn", "walk"]).toContain(s.p.state);
    const t = stage();
    setState(t.p, "hold", { x: cellX(12), y: t.sim.world.gy });
    t.run("!dig");
    expect(t.sim.terrain.tiles[12].kind).toBe("g");
    expect(t.p.mark).toBeGreaterThan(0);
  });

  it("breaks the builds near a boom and throws the characters there", () => {
    const s = stage();
    s.sim.receive(chat("kick", "other", "hello"));
    const other = s.sim.list()[1];
    setState(other, "hold", { x: cellX(START + 2), y: s.sim.world.gy, piloted: true, free: false, admitted: true });
    s.put(START + 1, 0);
    s.put(START + 1, 1);
    s.put(START - 2, 0);
    s.put(START + 6, 0);
    s.sim.perform(s.p, "boom");
    s.tick(24);
    expect(s.block(START + 1, 0)).toBeNull();
    expect(s.block(START + 1, 1)).toBeNull();
    expect(s.block(START - 2, 0)).toBeNull();
    expect(s.block(START + 6, 0)).not.toBeNull();
    expect(other.state).toBe("fall");
    expect(other.vx).toBeGreaterThan(0);
    s.tick(24);
    expect(s.p.state).toBe("gone");
    expect(s.p.piloted).toBe(false);
  });

  it("drops a build that lost its hold, and breaks a block that lands on a character", () => {
    const s = stage();
    const { world, terrain } = s.sim;
    s.put(START + 3, 0);
    s.put(START + 3, 1);
    s.put(START + 3, 2);
    s.put(START + 2, 3, "plank");
    s.put(START + 1, 3, "plank");
    s.put(START, 3, "plank");
    // A plank holds while it touches a block, also at a corner.
    removeBlock(world, terrain, START + 3, 2);
    s.tick(40);
    expect(s.block(START + 2, 2)?.kind).toBe("plank");
    for (const r of [0, 1]) removeBlock(world, terrain, START + 3, r);
    s.tick(60);
    // The planks fell: two lie on the ground, and the one over the character broke.
    expect(s.block(START + 2, 0)?.kind).toBe("plank");
    expect(s.block(START + 1, 0)?.kind).toBe("plank");
    for (let r = 0; r < 4; r++) expect(s.block(START, r)).toBeNull();
    expect(terrain.count).toBe(2);
    expect(terrain.loose).toBe(false);
    expect(["flat", "hold"]).toContain(s.p.state);
  });

  it("ends a dig when the owner clears the builds, so the ground stays whole", () => {
    const s = stage();
    for (const c of [1, 2]) s.put(START + c, 0);
    s.sim.perform(s.p, "dig", "", 2, 1);
    s.tick(10);
    expect(s.p.state).toBe("dig");
    s.sim.clearBuilds();
    expect(s.p.state).toBe("hold");
    s.tick(120);
    expect(s.sim.terrain.tiles.every((tile) => tile.stage === 0)).toBe(true);
    expect(s.row()).toBe(0);
  });

  it("drops the flag of a participant that a ban, a test end or an expiry forgets", () => {
    const s = stage();
    for (let i = 0; i < 45; i++) {
      s.sim.receive(chat("kick", `flagger${i}`, "hello"));
      const owner = s.sim.list().at(-1) as Participant;
      s.sim.terrain.flags.push({ id: owner.id, c: 8 + (i % 20), r: 0 });
      s.sim.receive({ kind: "ban", platform: "kick", userId: `flagger${i}`, until: null, receivedAt: 0 });
    }
    s.run("!flag");
    expect(s.sim.terrain.flags).toHaveLength(46);
    // The checkpoint keeps only the flag of the character that is there, so a restore accepts it.
    const restored = PlaygroundSim.restore(s.sim.checkpoint(), { rng: mulberry32(1) });
    expect(restored.terrain.flags).toEqual([{ id: s.p.id, c: START, r: 0 }]);
    s.sim.terrain.flags.push({ id: 9999, c: 9, r: 0 });
    s.tick(31);
    expect(s.sim.terrain.flags).toEqual([{ id: s.p.id, c: START, r: 0 }]);
  });

  it("keeps the building order in the checkpoint, so the same oldest block goes after a restore", () => {
    const s = stage();
    // Built from right to left: the oldest block has the highest cell number.
    for (const c of [30, 20, 10]) s.put(c, 0);
    const restored = PlaygroundSim.restore(s.sim.checkpoint(), { rng: mulberry32(1) });
    const order = (sim: PlaygroundSim): number[] => blockOrder(sim.terrain);
    expect(order(restored)).toEqual([30, 20, 10]);
    expect(order(restored)).toEqual(order(s.sim));
    // A checkpoint from before the order, and an order with a wrong cell, give the rows from the ground up.
    const old = JSON.parse(s.sim.checkpoint()) as Record<string, unknown>;
    delete old.order;
    expect(order(PlaygroundSim.restore(JSON.stringify(old), { rng: mulberry32(1) }))).toEqual([10, 20, 30]);
    old.order = [20, 999, 20];
    expect(order(PlaygroundSim.restore(JSON.stringify(old), { rng: mulberry32(1) }))).toEqual([20, 10, 30]);
  });

  it("lets a character that fell on its way out take commands after a new message", () => {
    const s = stage();
    s.run("!up");
    s.run("!up");
    // The time of the character is up: it walks to the exit, off its build.
    Object.assign(s.p, { lastChat: s.sim.clock - 2000, admittedAt: -1000 });
    for (let i = 0; i < 400 && s.p.state !== "fall"; i++) s.sim.tick();
    expect([s.p.state, s.p.free, s.p.exitReason]).toEqual(["fall", true, "timeout"]);
    s.p.lastCommand = -1000;
    s.sim.receive(chat("twitch", "builder", "!wave"));
    for (let i = 0; i < 80 && s.p.state !== "wave"; i++) s.sim.tick();
    expect([s.p.state, s.p.free, s.p.exitReason]).toEqual(["wave", false, null]);
  });

  it("clears all builds and lets the characters fall", () => {
    const s = stage();
    for (let i = 0; i < 3; i++) s.run("!up");
    s.run("!flag");
    s.sim.clearBuilds();
    expect(s.sim.terrain.count).toBe(0);
    expect(s.sim.terrain.flags).toHaveLength(0);
    expect(blocksString(s.sim.world, s.sim.terrain)).toBe("");
    s.tick(60);
    expect(s.row()).toBe(0);
    expect(s.sim.participants.size).toBe(1);
  });
});

describe("climbing", () => {
  it("pulls the character on top of a block that the hook catches", () => {
    const s = stage();
    for (let r = 0; r < 4; r++) s.put(START + 1, r);
    s.sim.perform(s.p, "grapple");
    expect(s.sim.fullFrame().extras.ropes).toHaveLength(1);
    s.tick(60);
    expect([s.col(), s.row()]).toEqual([START + 1, 4]);
    expect(s.sim.fullFrame().extras.ropes).toHaveLength(0);
    expect(s.p.mark).toBe(0);
  });

  it("shows the red cross when the hook catches nothing", () => {
    const s = stage();
    s.run("!hook");
    expect(s.p.mark).toBeGreaterThan(0);
    expect(s.p.mark).toBeLessThanOrEqual(MARK_TICKS);
    expect(s.row()).toBe(0);
  });

  it("flies up through blocks with the jetpack, and falls back with no floor", () => {
    const s = stage();
    s.run("!jetpack");
    expect(s.row()).toBe(0);
    s.put(START + 1, 0);
    s.put(START + 1, 1);
    s.put(START + 1, 2);
    s.put(START + 1, 3);
    s.put(START, 4, "plank");
    s.run("!jet");
    // Five blocks up is over the plank: the character stands on it.
    expect(s.row()).toBe(5);
    expect(s.p.y).toBe(floorY(s.sim.world, 5));
  });

  it("rises past a solid place to the first free one", () => {
    const s = stage();
    s.put(START + 1, 0);
    for (let r = 1; r <= 4; r++) s.put(START + 1, r);
    s.put(START, 3, "plank");
    s.put(START, 4, "plank");
    s.run("!jetpack 3");
    expect(s.row()).toBe(5);
  });

  it("jumps on a wall of two blocks", () => {
    const s = stage();
    s.put(START + 1, 0);
    s.put(START + 1, 1);
    s.run("!jump");
    expect(s.row()).toBe(2);
  });
});

describe("the crowd on the builds", () => {
  it("gives the crown to the highest character and keeps it until another is higher", () => {
    const s = stage();
    expect(s.sim.fullFrame().extras.crown).toBeNull();
    s.run("!up");
    expect(s.sim.fullFrame().extras.crown).toBeNull();
    s.run("!up");
    expect(s.sim.fullFrame().extras.crown).toBe(s.p.id);
    s.run("!dig 2");
    expect(s.sim.fullFrame().extras.crown).toBeNull();
  });

  it("pushes the character in front", () => {
    const s = stage();
    s.run("!push");
    expect(s.p.mark).toBeGreaterThan(0);
    s.sim.receive(chat("kick", "other", "hello"));
    const other = s.sim.list()[1];
    setState(other, "hold", { x: cellX(START + 1), y: s.sim.world.gy, piloted: true, free: false, admitted: true });
    s.sim.perform(s.p, "push");
    s.tick(8);
    expect(other.state).toBe("fall");
    expect(other.vx).toBeGreaterThan(0);
  });

  it("lifts a character that walks around when a block goes into its place", () => {
    const s = stage();
    s.sim.receive(chat("kick", "walker", "hello"));
    const walker = s.sim.list()[1];
    setState(walker, "idle", { x: cellX(START + 1), y: s.sim.world.gy, free: false, admitted: true });
    s.run("!block");
    expect(s.block(START + 1, 0)).not.toBeNull();
    expect(walker.y).toBeLessThanOrEqual(floorY(s.sim.world, 1));
  });

  it("does not let another steered character be built in", () => {
    const s = stage();
    s.sim.receive(chat("kick", "other", "hello"));
    const other = s.sim.list()[1];
    setState(other, "hold", { x: cellX(START + 1), y: s.sim.world.gy, piloted: true, free: false, admitted: true });
    s.run("!block");
    expect(s.sim.terrain.count).toBe(0);
    expect(s.p.mark).toBeGreaterThan(0);
  });

  it("sends the builds and the extras in frames that the overlay accepts", () => {
    const s = stage();
    s.run("!stairs 2");
    s.run("!flag");
    const full = s.sim.fullFrame();
    expect(full.terrain.blocks).toHaveLength(2 * s.sim.world.cols);
    expect(parseFrame(encodeFrame(full))).toEqual(full);
    s.sim.resendSections();
    s.sim.tickFrame();
    s.sim.perform(s.p, "block");
    s.tick(6);
    expect(s.sim.tickFrame().terrain).toBeUndefined();
    s.tick(2);
    const frame = s.sim.tickFrame();
    expect(frame.terrain?.blocks).not.toBe(full.terrain.blocks);
    expect(parseFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("gives each character that comes in its own place on the ground", () => {
    const sim = new PlaygroundSim({ cellsW: 32, cellsH: 18, rng: mulberry32(3), walkSpread: 0 });
    sim.resumeAfter(0);
    sim.tick();
    for (let i = 0; i < 8; i++) {
      sim.receive(chat("youtube", `e${i}`, "hello"));
      for (const p of sim.list()) p.pendingText = null;
      for (let t = 0; t < 25; t++) sim.tick();
      const [entrant, ...others] = sim.list().reverse();
      expect(entrant.state).toBe("goto");
      // The place is in the walking limits, and no other character is there or goes there.
      expect(entrant.target).toBeGreaterThan(sim.world.xmin);
      expect(entrant.target).toBeLessThan(sim.world.xmax);
      for (const o of others) {
        expect(Math.abs((o.state === "goto" ? o.target : o.x) - entrant.target)).toBeGreaterThanOrEqual(TILE);
      }
    }
  });
});

describe("platform places", () => {
  function people(counts: Partial<Record<ActivityPlatform, number>>): Participant[] {
    const sim = new PlaygroundSim({ cellsW: 32, cellsH: 4, rng: () => 0.5 });
    for (const [platform, count] of Object.entries(counts) as [ActivityPlatform, number][]) {
      for (let i = 0; i < count; i++) sim.receive(chat(platform, `${platform}${i}`, "hello"));
    }
    return sim.list();
  }

  it("keeps a fifth of the slots for each platform, and two at the least", () => {
    expect(platformReserve(40)).toBe(8);
    expect(platformReserve(20)).toBe(4);
    expect(platformReserve(5)).toBe(2);
  });

  it("keeps one viewer on Twitch and one on Kick on screen beside 100 on YouTube", () => {
    const all: Participant[] = people({ youtube: 100, twitch: 1, kick: 1 });
    // The small platforms have the lowest scores, and the rotation is far from them.
    for (const p of all) Object.assign(p, { score: p.platform === "youtube" ? 50 : 1, scoreAt: 0 });
    for (const rotation of [0, 10, 37, 500]) {
      const chosen: Participant[] = chooseCrowd(all, 0, 1800, rotation, 40);
      expect(chosen).toHaveLength(40);
      const platforms: ActivityPlatform[] = chosen.map((p: Participant): ActivityPlatform => p.platform);
      expect(platforms.filter((x) => x === "twitch")).toHaveLength(1);
      expect(platforms.filter((x) => x === "kick")).toHaveLength(1);
      expect(all.filter((p) => p.eligible && p.slot === "ranked")).toHaveLength(30);
    }
  });

  it("keeps at most the reserve for a platform, and gives each platform a place before a second one", () => {
    const all: Participant[] = people({ youtube: 30, twitch: 30, kick: 30 });
    for (const p of all) Object.assign(p, { score: p.platform === "youtube" ? 50 : 1, scoreAt: 0 });
    const ranked = (max: number): ActivityPlatform[] => {
      chooseCrowd(all, 0, 1800, 0, max);
      return all.filter((p) => p.eligible && p.slot === "ranked").map((p) => p.platform);
    };
    const forty: ActivityPlatform[] = ranked(40);
    expect(forty.filter((x) => x === "twitch")).toHaveLength(8);
    expect(forty.filter((x) => x === "kick")).toHaveLength(8);
    expect(forty.filter((x) => x === "youtube")).toHaveLength(14);
    const five: ActivityPlatform[] = ranked(5);
    expect(five).toHaveLength(4);
    expect(new Set(five).size).toBe(3);
  });
});
