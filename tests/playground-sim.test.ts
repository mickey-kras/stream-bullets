import { describe, expect, it } from "vitest";
import type { ActivityChat, ActivityEvent, ActivityPlatform } from "../app/lib/activity";
import {
  BUBBLE_LENGTH,
  BUBBLE_MAX,
  CHARACTERS_TEST_MS,
  CHARACTERS_TEST_TICKS,
  CHECKPOINT_MAX_LENGTH,
  REGISTRY_IDLE_TICKS,
  REGISTRY_MAX,
  RESTRICTED_MAX,
  STAIRS_MAX,
  TEST_USER_PREFIX,
  VISIBLE_MAX,
} from "../app/lib/playground/constants";
import { COMMANDS, type Command, chooseCrowd, type Participant } from "../app/lib/playground/crowd";
import { BUBBLE_MAX_UNITS, CUT_MARK, encodeFrame, FLAG_NEW, FLAG_UNAVAILABLE } from "../app/lib/playground/protocol";
import { mulberry32, PlaygroundSim, parseCommand, setState } from "../app/lib/playground/sim";
import { createWorld, solidAt, tileAt } from "../app/lib/playground/terrain";
import { TEST_CROWD_SIZE, type TestCrowdEvent, testCrowdScript } from "../app/lib/playground/test-crowd";

const T0 = 1_800_000_000_000;
const PLATFORMS: readonly ActivityPlatform[] = ["youtube", "twitch", "kick"];

interface Viewer {
  platform: ActivityPlatform;
  userId: string;
  name: string;
}

let seq = 0;

function chat(viewer: Viewer, text: string, live = true): ActivityChat {
  seq += 1;
  const messageId = `m${seq}`;
  return {
    kind: "chat",
    id: `${viewer.platform}:${messageId}`,
    platform: viewer.platform,
    channelId: "c1",
    messageId,
    user: { id: viewer.userId, displayName: viewer.name },
    text,
    fragments: [{ type: "text", text }],
    badges: [],
    sentAt: null,
    receivedAt: T0,
    live,
  };
}

function viewer(i: number): Viewer {
  return {
    platform: PLATFORMS[i % 3],
    userId: `u${i}`,
    name: i === 0 ? "Misha" : `viewer${String(i + 1).padStart(2, "0")}`,
  };
}

/**
 * The approved #664 prototype harness in a 640 x 120 world: 70 participants
 * that last spoke at tick 0, the first 40 with scores 40 down to 1, every character at WALK_SPEED.
 */
interface Proto {
  sim: PlaygroundSim;
  chars: Participant[];
  message: (c: Participant, text: string) => void;
  tick: (n?: number) => void;
}

function proto(rng: () => number = () => 0.9): Proto {
  const sim = new PlaygroundSim({ cellsW: 16, cellsH: 3, rng, walkSpread: 0 });
  for (let i = 0; i < 70; i++) sim.receive(chat(viewer(i), "registered"));
  const chars: Participant[] = sim.list();
  for (const [i, c] of chars.entries()) Object.assign(c, { score: i < 40 ? 40 - i : 0, scoreAt: 0, lastScored: -90 });
  sim.resumeAfter(0);
  return {
    sim,
    chars,
    message: (c: Participant, text: string): void =>
      sim.receive(chat({ platform: c.platform, userId: c.userId, name: c.name }, text)),
    tick: (n = 1): void => {
      for (let i = 0; i < n; i++) sim.tick();
    },
  };
}

const admitted = (sim: PlaygroundSim): Participant[] => sim.list().filter((p: Participant): boolean => p.admitted);

describe("prototype scenarios (640 x 120 world)", () => {
  it("caps at 40 with 30 ranked and 10 rotating", () => {
    const { sim, chars, message, tick } = proto();
    sim.select();
    for (const c of chars) message(c, "hi");
    expect(admitted(sim)).toHaveLength(40);
    expect(chars.filter((c) => c.eligible && c.slot === "ranked")).toHaveLength(30);
    expect(chars.filter((c) => c.eligible && c.slot === "rotating")).toHaveLength(10);
    for (let i = 0; i < 2000; i++) {
      if (i % 60 === 0) for (const c of chars) message(c, "hi");
      tick();
      expect(admitted(sim).length).toBeLessThanOrEqual(40);
    }
  });

  it("applies the 90-tick score and command cooldowns", () => {
    const { sim, chars, message } = proto();
    sim.select();
    message(chars[0], "!wave");
    for (let i = 0; i < 100; i++) message(chars[0], "!jump");
    expect(chars[0].score).toBe(41);
    expect(chars[0].pending?.name).toBe("wave");
    sim.clock = 90;
    message(chars[0], "!jump");
    expect(chars[0].pending?.name).toBe("jump");
    expect(Math.abs(chars[0].score - (41 * Math.exp(-90 / 1800) + 1))).toBeLessThan(1e-9);
  });

  it("reverses a timeout exit on a message", () => {
    const { sim, chars, message, tick } = proto();
    sim.select();
    sim.clock = 1800;
    sim.select();
    tick();
    expect(chars[0].exitReason).toBe("timeout");
    message(chars[0], "hello");
    expect(chars[0].state).toBe("walk");
    expect(chars[0].exitReason).toBeNull();
  });

  it("admits an offscreen sender, then runs its queued command", () => {
    const { sim, chars, message, tick } = proto();
    for (const c of chars) c.score = 0;
    sim.clock = 1;
    message(chars[60], "!wave");
    expect(chars[60].state).toBe("enter");
    tick(24);
    expect(chars[60].state).toBe("walk");
    tick();
    expect(chars[60].state).toBe("walk");
    expect(chars[60].pending?.name).toBe("wave");
    for (let i = 0; i < 100 && chars[60].state !== "wave"; i++) tick();
    expect(chars[60].state).toBe("wave");
    expect(chars[60].x).toBeGreaterThan(88);
  });

  it("completes each command in bounded time", () => {
    for (const command of COMMANDS) {
      const { sim, chars, tick } = proto();
      sim.select();
      setState(chars[0], "walk", { x: 240, y: sim.world.gy, dir: 1 });
      sim.perform(chars[0], command);
      let duration = 0;
      while (duration < 600 && !["walk", "gone", "away"].includes(chars[0].state)) {
        tick();
        duration += 1;
      }
      expect(duration, command).toBeLessThan(600);
    }
  });

  it("respawns exactly 75 ticks after gone while eligible", () => {
    const { sim, chars, tick } = proto();
    sim.select();
    sim.perform(chars[0], "boom");
    tick(48);
    expect(chars[0].state).toBe("gone");
    tick(74);
    expect(chars[0].state).toBe("gone");
    tick();
    expect(chars[0].state).toBe("respawn");
  });

  it("does not respawn an ineligible gone participant", () => {
    const { sim, chars, tick } = proto();
    sim.select();
    sim.perform(chars[0], "boom");
    tick(48);
    chars[0].lastChat = -2000;
    tick(75);
    expect(chars[0].state).toBe("away");
    expect(chars[0].admitted).toBe(false);
  });

  it("protects metal and repairs dirt 900 ticks after the hit", () => {
    const a = proto();
    a.sim.select();
    setState(a.chars[0], "dig", { x: 240, dir: 1 });
    a.tick(15);
    expect(a.sim.terrain.tiles[15].kind).toBe("d");
    expect(a.sim.terrain.tiles[15].stage).toBe(1);
    const repair: number = a.sim.terrain.tiles[15].repairAt;
    setState(a.chars[0], "walk");
    a.sim.clock = repair - 2;
    a.tick();
    expect(a.sim.terrain.tiles[15].stage).toBe(1);
    a.tick();
    expect(a.sim.terrain.tiles[15].stage).toBe(0);
    const b = proto();
    b.sim.select();
    setState(b.chars[0], "dig", { x: 88, dir: -1 });
    b.tick(15);
    expect(b.chars[0].state).toBe("walk");
    expect(b.chars[0].mark).toBeGreaterThan(0);
    expect((b.sim.fullFrame().chars.find((c) => c[0] === b.chars[0].id)?.[6] ?? 0) & FLAG_UNAVAILABLE).toBe(
      FLAG_UNAVAILABLE,
    );
    b.tick(45);
    expect(b.sim.terrain.tiles[5].stage).toBe(0);
  });

  it("keeps an offscreen build until the playable area, then builds", () => {
    const { sim, chars, message, tick } = proto();
    for (const c of chars) c.score = 0;
    sim.clock = 1;
    message(chars[60], "!build");
    tick(32);
    expect(chars[60].pending?.name).toBe("build");
    expect(sim.terrain.stairs).toHaveLength(0);
    for (let i = 0; i < 100 && sim.terrain.stairs.length === 0; i++) tick();
    expect(sim.terrain.stairs).toHaveLength(1);
    expect(chars[60].x).toBeGreaterThanOrEqual(88);
  });

  it("lets an ineligible participant finish its build, then exit, despite repeated commands", () => {
    const { sim, chars, message, tick } = proto();
    sim.select();
    sim.clock = 300;
    for (const c of chars) message(c, "hi");
    for (const c of chars.slice(0, 30)) Object.assign(c, { score: 100, scoreAt: sim.clock });
    sim.rotation = 10;
    sim.select();
    setState(chars[30], "walk", { x: 240, y: sim.world.gy, dir: 1 });
    sim.perform(chars[30], "build");
    expect(chars[30].eligible).toBe(false);
    let firstExit: number | null = null;
    for (let i = 0; i < 200; i++) {
      if (i % 90 === 0) message(chars[30], "!build");
      tick();
      if (chars[30].exitReason === "capacity") {
        firstExit = i + 1;
        break;
      }
    }
    expect(firstExit).toBe(173);
  });

  it("clamps the timeout setting without removing the crowd", () => {
    const { sim, tick } = proto();
    sim.select();
    sim.clock = 300;
    tick();
    expect(sim.timeoutTicks).toBe(1800);
    expect(sim.list().filter((c) => c.eligible)).toHaveLength(40);
    sim.setTimeoutSeconds(15);
    expect(sim.timeoutTicks).toBe(450);
    sim.setTimeoutSeconds(0);
    expect(sim.timeoutTicks).toBe(300);
    sim.setTimeoutSeconds(9999);
    expect(sim.timeoutTicks).toBe(18_000);
    expect(() => sim.setTimeoutSeconds(Number.NaN)).toThrow(RangeError);
  });

  it("removes temporary stairs after 30 seconds", () => {
    const { sim, chars, tick } = proto();
    sim.select();
    setState(chars[0], "walk", { x: 240, y: sim.world.gy, dir: 1 });
    sim.perform(chars[0], "build");
    tick(172);
    expect(sim.terrain.stairs).toHaveLength(5);
    const finalExpiry: number = Math.max(...sim.terrain.stairs.map((s) => s.until));
    setState(chars[0], "walk");
    sim.clock = finalExpiry;
    tick();
    expect(sim.terrain.stairs).toHaveLength(0);
  });

  it("restores fully broken dirt exactly 900 ticks after the final dig", () => {
    const { sim, chars, tick } = proto();
    sim.select();
    setState(chars[0], "dig", { x: 240, dir: 1 });
    tick(55);
    expect(sim.terrain.tiles[15].stage).toBe(3);
    const repair: number = sim.terrain.tiles[15].repairAt;
    expect(repair).toBe(955);
    expect(solidAt(sim.terrain, 248)).toBe(false);
    setState(chars[0], "walk");
    sim.clock = repair - 2;
    tick();
    expect(sim.terrain.tiles[15].stage).toBe(3);
    tick();
    expect(sim.terrain.tiles[15].stage).toBe(0);
  });

  it("reverses the exit animation before the slot is released", () => {
    const { sim, chars, message } = proto();
    sim.select();
    sim.clock = 1800;
    setState(chars[0], "exit", { x: sim.world.exitX, exitReason: "timeout", free: true });
    message(chars[0], "back");
    expect(chars[0].state).toBe("walk");
    expect(chars[0].dir).toBe(-1);
    expect(chars[0].free).toBe(false);
    expect(chars[0].admitted).toBe(true);
  });

  it("never lets a forced random turn divert an entrant or expire its queued command", () => {
    let randomCalls = 0;
    const { sim, chars, message, tick } = proto(() => {
      randomCalls += 1;
      return 0;
    });
    for (const c of chars) c.score = 0;
    sim.clock = 1;
    message(chars[60], "!wave");
    tick(104);
    expect(chars[60].state).toBe("walk");
    expect(chars[60].free).toBe(true);
    expect(chars[60].dir).toBe(1);
    expect(chars[60].pending?.name).toBe("wave");
    expect(randomCalls).toBe(0);
    for (let i = 0; i < 100 && chars[60].state !== "wave"; i++) tick();
    expect(chars[60].state).toBe("wave");
    expect(chars[60].x).toBeGreaterThan(88);
    expect(sim.clock).toBeLessThan(301);
  });
});

/** A running playground with `count` viewers who each said hello at tick 0. The greetings are not queued. */
function crowd(count: number, cellsW = 16, cellsH = 2, seed = 1): { sim: PlaygroundSim; viewers: Viewer[] } {
  const sim = new PlaygroundSim({ cellsW, cellsH, rng: mulberry32(seed) });
  sim.resumeAfter(0);
  const viewers: Viewer[] = Array.from({ length: count }, (_, i: number) => viewer(i));
  for (const v of viewers) sim.receive(chat(v, "hello"));
  for (const p of sim.list()) p.pendingText = null;
  return { sim, viewers };
}

function find(sim: PlaygroundSim, v: Viewer): Participant | undefined {
  return sim.participants.get(`${v.platform}:${v.userId}`);
}

function walking(sim: PlaygroundSim, p: Participant): void {
  setState(p, "walk", { x: 300, y: sim.world.gy, dir: 1, free: false });
}

describe("commands and bubbles", () => {
  it("parses only the five commands", () => {
    expect(parseCommand("!JUMP")).toBe("jump");
    expect(parseCommand("​！dig now")).toBe("dig");
    expect(parseCommand("!discord")).toBeNull();
    expect(parseCommand("jump")).toBeNull();
  });

  it("never runs a command from a message that is not live", () => {
    const { sim, viewers } = crowd(1);
    sim.receive(chat(viewers[0], "!jump", false));
    const p = find(sim, viewers[0]) as Participant;
    expect(p.pending).toBeNull();
    expect(p.pendingText).toBeNull();
    expect(p.admitted).toBe(true);
    expect(p.lastChat).toBe(0);
  });

  it("cuts a long bubble text to BUBBLE_LENGTH with the cut mark, within BUBBLE_MAX_UNITS", () => {
    const { sim, viewers } = crowd(1);
    sim.receive(chat(viewers[0], "word ".repeat(40)));
    // A family emoji is one character of 11 code units: here the unit limit cuts first.
    sim.receive(chat(viewer(1), "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}".repeat(BUBBLE_LENGTH)));
    const texts: string[] = [viewers[0], viewer(1)].map(
      (v: Viewer) => (find(sim, v) as Participant).pendingText?.text ?? "",
    );
    expect(texts.map((text: string) => [...new Intl.Segmenter().segment(text)].length)).toEqual([BUBBLE_LENGTH, 30]);
    expect(texts[1]).toHaveLength(BUBBLE_MAX_UNITS);
    for (const text of texts) {
      expect(text.endsWith(CUT_MARK)).toBe(true);
      expect(text.length).toBeLessThanOrEqual(BUBBLE_MAX_UNITS);
    }
  });

  it("drops commands in registry mode", () => {
    const { sim, viewers } = crowd(1);
    sim.stop();
    expect(sim.running).toBe(false);
    sim.receive(chat(viewers[0], "!jump"));
    sim.receive(chat(viewers[0], "hi"));
    expect(find(sim, viewers[0])?.pending).toBeNull();
    expect(find(sim, viewers[0])?.pendingText).toBeNull();
    expect(() => sim.tick()).toThrow("not running");
  });

  it("shows queued text once walking and keeps at most four bubbles", () => {
    const { sim, viewers } = crowd(8);
    for (const v of viewers) walking(sim, find(sim, v) as Participant);
    for (const v of viewers) sim.receive(chat(v, `line ‮from ${v.userId}\n`));
    sim.tick();
    const frame = sim.fullFrame();
    expect(frame.bubbles).toHaveLength(BUBBLE_MAX);
    for (const bubble of frame.bubbles) expect(bubble.text).toMatch(/^line from u\d$/);
    expect(encodeFrame(frame).length).toBeGreaterThan(0);
  });

  it("expires queued commands and text that never got to run", () => {
    const { sim, viewers } = crowd(1);
    const p = find(sim, viewers[0]) as Participant;
    setState(p, "dig", { x: 300, y: sim.world.gy, dir: 1 });
    sim.clock = 200;
    sim.receive(chat(viewers[0], "!wave"));
    sim.receive(chat(viewers[0], "words"));
    setState(p, "idle", { t: -1000 });
    for (let i = 0; i < 301; i++) sim.tick();
    expect(p.pending).toBeNull();
    expect(p.pendingText).toBeNull();
  });

  it("marks a build with no room as unavailable", () => {
    const { sim, viewers } = crowd(1);
    const p = find(sim, viewers[0]) as Participant;
    setState(p, "walk", { x: sim.world.xmin + 2, y: sim.world.gy, dir: 1 });
    sim.perform(p, "build");
    Object.assign(p, { dir: -1, bx: sim.world.xmin });
    for (let i = 0; i < 7; i++) sim.tick();
    expect(p.state).toBe("walk");
    expect(p.mark).toBeGreaterThan(0);
  });

  it("bounds the stair steps, dropping the oldest", () => {
    const { sim, viewers } = crowd(1);
    for (let i = 0; i < STAIRS_MAX; i++) sim.terrain.stairs.push({ x: 300, top: 50, dir: 1, until: 1e9 + i });
    const p = find(sim, viewers[0]) as Participant;
    setState(p, "walk", { x: 300, y: sim.world.gy, dir: 1 });
    sim.perform(p, "build");
    for (let i = 0; i < 7; i++) sim.tick();
    expect(sim.terrain.stairs).toHaveLength(STAIRS_MAX);
    expect(sim.terrain.stairs[0].until).toBe(1e9 + 1);
  });

  it("flags newly admitted characters for their label", () => {
    const { sim } = crowd(1);
    expect(sim.fullFrame().chars[0][6] & FLAG_NEW).toBe(FLAG_NEW);
    for (let i = 0; i < 90; i++) sim.tick();
    expect(sim.fullFrame().chars[0][6] & FLAG_NEW).toBe(0);
  });
});

describe("moderation", () => {
  it("drops a deleted message's bubble, queued text and queued command", () => {
    const { sim, viewers } = crowd(2);
    const p = find(sim, viewers[0]) as Participant;
    walking(sim, p);
    const said = chat(viewers[0], "rude words");
    sim.receive(said);
    sim.tick();
    expect(p.bubble?.text).toBe("rude words");
    sim.receive({ kind: "delete", platform: said.platform, messageId: said.messageId, receivedAt: T0 });
    expect(p.bubble).toBeNull();
    setState(p, "dig");
    const queued = chat(viewers[0], "more");
    sim.receive(queued);
    sim.clock += 100;
    const command = chat(viewers[0], "!jump");
    sim.receive(command);
    sim.receive({ kind: "delete", platform: queued.platform, messageId: queued.messageId, receivedAt: T0 });
    sim.receive({ kind: "delete", platform: command.platform, messageId: command.messageId, receivedAt: T0 });
    expect(p.pendingText).toBeNull();
    expect(p.pending).toBeNull();
  });

  it("vanishes a banned participant and ignores its chat until the timeout ends", () => {
    const { sim, viewers } = crowd(3);
    const target = viewers[1];
    sim.receive({ kind: "ban", platform: target.platform, userId: target.userId, until: T0 + 10_000, receivedAt: T0 });
    expect(find(sim, target)).toBeUndefined();
    expect(admitted(sim)).toHaveLength(2);
    sim.receive(chat(target, "!boom"));
    expect(find(sim, target)).toBeUndefined();
    for (let i = 0; i < 300; i++) sim.tick();
    sim.receive(chat(target, "back"));
    expect(find(sim, target)?.admitted).toBe(true);
  });

  it("keeps a permanent ban for the registry lifetime and ignores a ban that already ended", () => {
    const { sim, viewers } = crowd(2);
    sim.receive({ kind: "ban", platform: viewers[0].platform, userId: viewers[0].userId, until: null, receivedAt: T0 });
    expect(sim.restrictions.get(`${viewers[0].platform}:${viewers[0].userId}`)).toBe(REGISTRY_IDLE_TICKS);
    sim.receive({ kind: "ban", platform: viewers[1].platform, userId: viewers[1].userId, until: T0, receivedAt: T0 });
    expect(find(sim, viewers[1])?.admitted).toBe(true);
    sim.receive({ kind: "status", platform: "twitch", status: "active" });
    expect(sim.restrictions.size).toBe(1);
  });

  it("bounds restrictions, dropping the one that ends first", () => {
    const { sim } = crowd(0);
    for (let i = 0; i <= RESTRICTED_MAX; i++) {
      sim.receive({ kind: "ban", platform: "kick", userId: `b${i}`, until: T0 + 60_000 + i * 1000, receivedAt: T0 });
    }
    expect(sim.restrictions.size).toBe(RESTRICTED_MAX);
    expect(sim.restrictions.has("kick:b0")).toBe(false);
    sim.receive({ kind: "ban", platform: "kick", userId: "b5", until: T0 + 1000, receivedAt: T0 });
    expect(sim.restrictions.get("kick:b5")).toBe(65 * 30);
  });

  it("clears one user's bubbles or a whole platform's", () => {
    const { sim, viewers } = crowd(6);
    for (const v of viewers) walking(sim, find(sim, v) as Participant);
    for (const v of viewers.slice(0, 4)) sim.receive(chat(v, "hi there"));
    sim.tick();
    sim.receive({ kind: "clear_user", platform: viewers[0].platform, userId: viewers[0].userId, receivedAt: T0 });
    expect(find(sim, viewers[0])?.bubble).toBeNull();
    expect(find(sim, viewers[1])?.bubble).not.toBeNull();
    sim.receive({ kind: "clear", platform: viewers[1].platform, receivedAt: T0 });
    expect(find(sim, viewers[1])?.bubble).toBeNull();
    expect(find(sim, viewers[2])?.bubble).not.toBeNull();
  });
});

describe("controls", () => {
  it("removes a participant until a reset", () => {
    const { sim, viewers } = crowd(2);
    const p = find(sim, viewers[0]) as Participant;
    expect(sim.remove(9999)).toBe(false);
    expect(sim.remove(p.id)).toBe(true);
    expect(p.admitted).toBe(false);
    sim.receive(chat(viewers[0], "let me back"));
    sim.tick();
    expect(p.admitted).toBe(false);
    sim.reset();
    expect(sim.participants.size).toBe(0);
    sim.receive(chat(viewers[0], "hello again"));
    expect(find(sim, viewers[0])?.admitted).toBe(true);
  });

  it("resets terrain and participants but keeps restrictions", () => {
    const { sim, viewers } = crowd(2);
    sim.terrain.tiles[8].stage = 3;
    sim.terrain.stairs.push({ x: 300, top: 50, dir: 1, until: 1e9 });
    sim.receive({ kind: "ban", platform: viewers[0].platform, userId: viewers[0].userId, until: null, receivedAt: T0 });
    sim.rotation = 30;
    sim.reset();
    expect(sim.terrain.tiles[8].stage).toBe(0);
    expect(sim.terrain.stairs).toHaveLength(0);
    expect(sim.rotation).toBe(0);
    expect(sim.restrictions.size).toBe(1);
  });

  it("pauses: no ticks, no commands, and the frame says so", () => {
    const { sim, viewers } = crowd(1);
    sim.pause();
    expect(() => sim.tick()).toThrow("not running");
    sim.receive(chat(viewers[0], "!wave"));
    expect(find(sim, viewers[0])?.pending).toBeNull();
    expect(sim.fullFrame().mode).toEqual({ paused: true, test: false });
    sim.resume();
    sim.resumeAfter(30);
    sim.tick();
    expect(sim.clock).toBe(31);
  });

  it("resumes after a gap: repairs, expiry, rotation and walking characters", () => {
    const { sim, viewers } = crowd(3);
    const p = find(sim, viewers[0]) as Participant;
    setState(p, "dig", { x: 240, dir: 1 });
    for (let i = 0; i < 55; i++) sim.tick();
    expect(sim.terrain.tiles[15].stage).toBe(3);
    setState(p, "boom", { x: 248 });
    sim.receive(chat(viewers[1], "!jump"));
    sim.stop();
    sim.receive(chat(viewers[2], "still here"));
    sim.skip(500);
    sim.receive(chat(viewers[2], "and now"));
    expect(find(sim, viewers[2])?.lastChat).toBe(555);
    sim.resumeAfter(1000);
    expect(sim.clock).toBe(1555);
    expect(sim.terrain.tiles[15].stage).toBe(0);
    expect(sim.rotation).toBe(30);
    for (const q of admitted(sim)) {
      expect(q.state).toBe("walk");
      expect(q.pending).toBeNull();
      expect(q.bubble).toBeNull();
      expect(q.y).toBe(sim.world.gy);
    }
    expect(() => sim.skip(-1)).toThrow(RangeError);
    expect(() => sim.skip(1.5)).toThrow(RangeError);
    for (let i = 0; i < 2000; i++) sim.tick();
    expect(find(sim, viewers[0])?.admitted).toBe(false);
  });

  it("puts a character over an unrepaired hole on the respawn pad after a gap", () => {
    const { sim, viewers } = crowd(1);
    const p = find(sim, viewers[0]) as Participant;
    sim.terrain.tiles[15].stage = 3;
    sim.terrain.tiles[15].repairAt = 1e9;
    setState(p, "fall", { x: 248 });
    sim.resumeAfter(0);
    expect(p.x).toBe(sim.world.padX);
  });

  it("resizes the world and keeps relative places", () => {
    const { sim, viewers } = crowd(2);
    const p = find(sim, viewers[0]) as Participant;
    setState(p, "jump", { x: sim.world.xmax });
    sim.resize(16, 2);
    expect(p.state).toBe("jump");
    sim.resize(9, 3);
    expect(sim.world.w).toBe(360);
    expect(p.x).toBe(sim.world.xmax);
    expect(p.state).toBe("walk");
    expect(sim.terrain.tiles).toHaveLength(23);
  });

  it("runs a characters test, then forgets its synthetic participants", () => {
    const { sim, viewers } = crowd(1);
    sim.startTest();
    expect(sim.fullFrame().mode.test).toBe(true);
    for (const item of testCrowdScript(7, T0).slice(0, 40)) sim.receive(item.event);
    expect(sim.list().some((p) => p.userId.startsWith(TEST_USER_PREFIX))).toBe(true);
    sim.stopTest();
    expect(sim.list().map((p) => p.userId)).toEqual([viewers[0].userId]);
    sim.startTest();
    sim.receive(testCrowdScript(7, T0)[0].event);
    sim.skip(CHARACTERS_TEST_TICKS);
    expect(sim.testEndsAt).toBeNull();
    expect(sim.participants.size).toBe(1);
  });
});

describe("registry and admission", () => {
  it("bounds the registry and forgets idle participants", () => {
    const { sim } = crowd(REGISTRY_MAX + 100);
    expect(sim.participants.size).toBe(REGISTRY_MAX);
    expect(admitted(sim)).toHaveLength(VISIBLE_MAX);
    expect(sim.participants.has("youtube:u0")).toBe(true);
    sim.skip(REGISTRY_IDLE_TICKS);
    expect(sim.participants.size).toBe(VISIBLE_MAX);
  });

  it("does not let repeated messages jump the queue", () => {
    const sim = new PlaygroundSim({ cellsW: 16, cellsH: 2, rng: () => 0.9 });
    sim.resumeAfter(0);
    const viewers: Viewer[] = Array.from({ length: 60 }, (_, i: number) => viewer(i));
    for (const v of viewers) sim.receive(chat(v, "hello"));
    for (let i = 0; i < 20; i++) sim.tick();
    const spammer = find(sim, viewers[59]) as Participant;
    const before: number = spammer.score;
    for (let i = 0; i < 200; i++) sim.receive(chat(viewers[59], `spam ${i}`));
    expect(spammer.score).toBe(before);
    const rotating: string[] = sim
      .list()
      .filter((p) => p.eligible && p.slot === "rotating")
      .map((p) => p.key);
    expect(rotating).not.toContain(spammer.key);
    expect(spammer.slot).toBe("rotating");
    expect(spammer.eligible).toBe(false);
  });

  it("forgets an idle visible participant in registry mode, and gives the next expiry", () => {
    const { sim, viewers } = crowd(3);
    expect(sim.expiresAt()).toBe(REGISTRY_IDLE_TICKS);
    sim.receive({
      kind: "ban",
      platform: viewers[2].platform,
      userId: viewers[2].userId,
      until: T0 + 10_000,
      receivedAt: T0,
    });
    sim.skip(60);
    sim.receive(chat(viewers[1], "still here"));
    expect(admitted(sim)).toHaveLength(2);
    sim.stop();
    // The restriction ends first, then the first viewer, then the second one.
    expect(sim.expiresAt()).toBe(300);
    sim.skip(300);
    expect(sim.restrictions.size).toBe(0);
    expect(sim.expiresAt()).toBe(REGISTRY_IDLE_TICKS);
    sim.skip(REGISTRY_IDLE_TICKS - 360);
    expect(sim.list().map((p) => p.userId)).toEqual(["u1"]);
    expect(sim.expiresAt()).toBe(60 + REGISTRY_IDLE_TICKS);
    sim.skip(60);
    expect(sim.participants.size).toBe(0);
    expect(sim.expiresAt()).toBeNull();
    sim.startTest();
    expect(sim.expiresAt()).toBe(sim.testEndsAt);
  });

  it("cuts a long name with an ellipsis", () => {
    const sim = new PlaygroundSim({ cellsW: 16, cellsH: 2, rng: mulberry32(1) });
    sim.resumeAfter(0);
    sim.receive(chat({ platform: "twitch", userId: "long", name: "A".repeat(30) }, "hi"));
    sim.receive(chat({ platform: "twitch", userId: "fits", name: "B".repeat(24) }, "hi"));
    const names: string[] = sim.list().map((p) => p.name);
    expect(names).toEqual([`${"A".repeat(23)}…`, "B".repeat(24)]);
  });

  it("evicts only participants without a slot", () => {
    const { sim } = crowd(REGISTRY_MAX);
    for (const p of sim.list()) p.admitted = true;
    expect(() => sim.receive(chat(viewer(9999), "one more"))).toThrow("registry full");
  });
});

/** Runs `ticks` ticks with seeded bursts and checks the cap and that every action ends. */
function fuzz(sim: PlaygroundSim, ticks: number, seed: number): void {
  const rng = mulberry32(seed);
  const viewers: Viewer[] = Array.from({ length: 120 }, (_, i: number) => viewer(i));
  const actionStart = new Map<Participant, number>();
  const ACTIONS = new Set<string>(["jump", "dig", "build", "bwalk", "wave", "boom", "fall", "land", "flat", "respawn"]);
  for (let i = 0; i < ticks; i++) {
    if (rng() < 0.02) {
      for (let k = 0; k < 40 + Math.floor(rng() * 60); k++) {
        const v = viewers[Math.floor(rng() * viewers.length)];
        const command: Command = COMMANDS[Math.floor(rng() * COMMANDS.length)];
        sim.receive(chat(v, rng() < 0.5 ? `!${command}` : "busy chat", rng() < 0.9));
      }
    }
    if (rng() < 0.002) {
      const v = viewers[Math.floor(rng() * viewers.length)];
      sim.receive({ kind: "ban", platform: v.platform, userId: v.userId, until: T0 + 5000, receivedAt: T0 });
    }
    if (rng() < 0.001) sim.remove(1 + Math.floor(rng() * 120));
    sim.tick();
    const visible = admitted(sim);
    expect(visible.length).toBeLessThanOrEqual(VISIBLE_MAX);
    for (const p of sim.list()) {
      if (!ACTIONS.has(p.state)) actionStart.delete(p);
      else if (!actionStart.has(p)) actionStart.set(p, sim.clock);
      else expect(sim.clock - (actionStart.get(p) as number), p.state).toBeLessThan(600);
    }
    if (i % 100 === 0) {
      expect(encodeFrame(sim.tickFrame()).length).toBeLessThan(16_384);
      expect(encodeFrame(sim.fullFrame()).length).toBeLessThan(16_384);
    }
  }
}

describe("seeded fuzz", () => {
  it("keeps at most 40 visible and ends every action over 10k ticks with bursts", () => {
    const sim = new PlaygroundSim({ cellsW: 16, cellsH: 2, rng: mulberry32(42) });
    sim.resumeAfter(0);
    fuzz(sim, 10_000, 42);
  });

  for (const [cellsW, cellsH] of [
    [6, 2],
    [9, 3],
    [16, 2],
  ] as const) {
    it(`runs in a ${cellsW} x ${cellsH} cell world`, () => {
      const world = createWorld(cellsW, cellsH);
      expect(world.w).toBe(cellsW * 40);
      expect(world.gy).toBe(cellsH * 40 - 18);
      expect(world.xmin).toBeLessThan(world.xmax);
      const sim = new PlaygroundSim({ cellsW, cellsH, rng: mulberry32(cellsW) });
      expect(tileAt(sim.terrain, world.padX)?.kind).toBe("g");
      expect(tileAt(sim.terrain, world.entryX)?.kind).toBe("g");
      expect(tileAt(sim.terrain, world.exitX)?.kind).toBe("g");
      expect(tileAt(sim.terrain, -1)).toBeUndefined();
      sim.resumeAfter(0);
      fuzz(sim, 3000, cellsW * 10 + cellsH);
    });
  }

  it("refuses cell sizes outside the limits", () => {
    expect(() => createWorld(5, 2)).toThrow(RangeError);
    expect(() => createWorld(17, 2)).toThrow(RangeError);
    expect(() => createWorld(6, 1)).toThrow(RangeError);
    expect(() => createWorld(6.5, 2)).toThrow(RangeError);
  });
});

describe("frames", () => {
  it("sends roster, bubbles, terrain and mode only when they change", () => {
    const { sim, viewers } = crowd(2);
    const first = sim.tickFrame();
    expect(first.roster).toHaveLength(2);
    expect(first.terrain).toBeDefined();
    expect(first.mode).toBeDefined();
    sim.tick();
    const second = sim.tickFrame();
    expect(second.roster).toBeUndefined();
    expect(second.terrain).toBeUndefined();
    expect(second.chars).toHaveLength(2);
    sim.receive(chat(viewer(5), "joining"));
    expect(sim.tickFrame().roster).toHaveLength(3);
    sim.pause();
    const paused = sim.tickFrame();
    expect(paused.roster).toBeUndefined();
    expect(paused.mode).toEqual({ paused: true, test: false });
    sim.resume();
    walking(sim, find(sim, viewers[0]) as Participant);
    sim.receive(chat(viewers[0], "new words"));
    sim.tick();
    expect(sim.tickFrame().bubbles).toEqual([{ id: 1, text: "new words" }]);
    // Bubbles come oldest first, so the overlay draws the newest on top.
    walking(sim, find(sim, viewers[1]) as Participant);
    sim.receive(chat(viewers[1], "later words"));
    sim.tick();
    walking(sim, find(sim, viewers[0]) as Participant);
    sim.receive(chat(viewers[0], "newest words"));
    sim.tick();
    expect(sim.tickFrame().bubbles).toEqual([
      { id: 2, text: "later words" },
      { id: 1, text: "newest words" },
    ]);
    // After a full frame, the next tick frame repeats every section.
    sim.fullFrame();
    sim.resendSections();
    expect(sim.tickFrame()).toMatchObject({ roster: expect.any(Array), mode: { paused: false, test: false } });
  });

  it("never puts a platform user id in a frame", () => {
    const { sim } = crowd(5);
    const raw: string = encodeFrame(sim.fullFrame());
    expect(raw).not.toMatch(/"u\d"/);
    expect(raw).toContain('"name":"Misha"');
  });
});

describe("checkpoint", () => {
  it("round-trips the registry, terrain and restrictions without actions", () => {
    const { sim, viewers } = crowd(50, 16, 2, 3);
    for (let i = 0; i < 400; i++) sim.tick();
    const p = find(sim, viewers[0]) as Participant;
    setState(p, "dig", { x: 240, dir: 1 });
    for (let i = 0; i < 20; i++) sim.tick();
    setState(p, "wave");
    sim.terrain.stairs.push({ x: 300, top: 40, dir: -1, until: 2000 });
    sim.receive({ kind: "ban", platform: viewers[3].platform, userId: viewers[3].userId, until: null, receivedAt: T0 });
    sim.remove((find(sim, viewers[4]) as Participant).id);
    sim.startTest();
    const raw: string = sim.checkpoint();
    const back = PlaygroundSim.restore(raw, { rng: mulberry32(3) });
    expect(back.running).toBe(false);
    expect(back.clock).toBe(sim.clock);
    expect(back.testEndsAt).toBe(sim.testEndsAt);
    expect(back.terrain.tiles.map((t) => [t.stage, t.repairAt])).toEqual(
      sim.terrain.tiles.map((t) => [t.stage, t.repairAt]),
    );
    expect(back.terrain.stairs).toEqual(sim.terrain.stairs);
    expect([...back.restrictions]).toEqual([...sim.restrictions]);
    expect(
      back
        .list()
        .map((q) => [q.id, q.key, q.score, q.admitted, q.removed])
        .sort(),
    ).toEqual(
      sim
        .list()
        .map((q) => [q.id, q.key, q.score, q.admitted, q.removed])
        .sort(),
    );
    for (const q of admitted(back)) expect(q.state).toBe("walk");
    back.resumeAfter(30);
    back.tick();
    expect(back.checkpoint().length).toBeLessThanOrEqual(CHECKPOINT_MAX_LENGTH);
    back.receive(chat(viewer(70), "new after restore"));
    expect((find(back, viewer(70)) as Participant).id).toBeGreaterThan(Math.max(...sim.list().map((q) => q.id)));
  });

  it("keeps the registration order, so the crowd choice after a restore is the same", () => {
    const { sim } = crowd(60, 16, 2, 3);
    for (let i = 0; i < 400; i++) sim.tick();
    // Late messages from the last registered viewers would move them ahead in a recency order.
    const late: Participant[] = sim.list().slice(-5);
    for (const p of late) sim.receive(chat({ platform: p.platform, userId: p.userId, name: p.name }, "late"));
    const back = PlaygroundSim.restore(sim.checkpoint(), { rng: mulberry32(3) });
    expect(back.list().map((p) => p.id)).toEqual(sim.list().map((p) => p.id));
    const ids = (chosen: Participant[]): number[] => chosen.map((p) => p.id);
    expect(ids(chooseCrowd(back.list(), back.clock, back.timeoutTicks, 7))).toEqual(
      ids(chooseCrowd(sim.list(), sim.clock, sim.timeoutTicks, 7)),
    );
  });

  it("stays within its bound with hostile ids and names, keeping slots and restrictions first", () => {
    const sim = new PlaygroundSim({ cellsW: 16, cellsH: 2, rng: () => 0.5 });
    sim.resumeAfter(0);
    const long = (i: number): Viewer => ({
      platform: "youtube",
      userId: `${"x".repeat(120)}${i}`,
      name: "W".repeat(200),
    });
    for (let i = 0; i < REGISTRY_MAX; i++) sim.receive(chat(long(i), "hello"));
    for (let i = 0; i < RESTRICTED_MAX; i++) {
      sim.receive({ kind: "ban", platform: "kick", userId: `${"y".repeat(120)}${i}`, until: null, receivedAt: T0 });
    }
    const raw: string = sim.checkpoint();
    expect(raw.length).toBeLessThanOrEqual(CHECKPOINT_MAX_LENGTH);
    const back = PlaygroundSim.restore(raw, { rng: () => 0.5 });
    expect(admitted(back)).toHaveLength(VISIBLE_MAX);
    expect(back.restrictions.size).toBeLessThanOrEqual(RESTRICTED_MAX);
  });

  it("refuses a malformed checkpoint", () => {
    const { sim } = crowd(3);
    const good = JSON.parse(sim.checkpoint()) as Record<string, unknown>;
    const rng = { rng: () => 0.5 };
    const bad = (patch: Record<string, unknown>): string => JSON.stringify({ ...good, ...patch });
    expect(() => PlaygroundSim.restore("{", rng)).toThrow("not JSON");
    expect(() => PlaygroundSim.restore(bad({ v: 2 }), rng)).toThrow("invalid");
    expect(() => PlaygroundSim.restore(bad({ ground: "g" }), rng)).toThrow("does not match");
    expect(() => PlaygroundSim.restore(bad({ repairs: [[63, 5]] }), rng)).toThrow("outside the ground");
    const registry = good.registry as unknown[][];
    expect(() => PlaygroundSim.restore(bad({ registry: [registry[0], registry[0]] }), rng)).toThrow("duplicate");
    const many = Array.from({ length: 41 }, (_, i: number) => {
      const record = [...registry[0]];
      record[0] = i + 1;
      record[2] = `v${i}`;
      return record;
    });
    expect(() => PlaygroundSim.restore(bad({ registry: many, nextId: 100 }), rng)).toThrow("too many visible");
  });
});

describe("characters test script", () => {
  it("is seeded, sorted and covers each minute", () => {
    const script: TestCrowdEvent[] = testCrowdScript(11, T0);
    expect(testCrowdScript(11, T0)).toEqual(script);
    expect(testCrowdScript(12, T0)).not.toEqual(script);
    for (let i = 1; i < script.length; i++) expect(script[i].atMs).toBeGreaterThanOrEqual(script[i - 1].atMs);
    expect(script[script.length - 1].atMs).toBeLessThan(CHARACTERS_TEST_MS);
    const users = new Set<string>();
    for (let minute = 0; minute < 5; minute++) {
      const events = script.filter((e) => Math.floor(e.atMs / 60_000) === minute).map((e) => e.event);
      const texts = events.flatMap((e: ActivityEvent) => (e.kind === "chat" ? [e.text] : []));
      for (const command of COMMANDS) expect(texts).toContain(`!${command}`);
      expect(events.some((e) => e.kind === "delete")).toBe(true);
      expect(events.some((e) => e.kind === "ban")).toBe(true);
      if (minute > 0) expect(texts).toContain("wait, I am back!");
      for (const e of events) if (e.kind === "chat") users.add(e.user.id);
    }
    expect(users.size).toBeLessThanOrEqual(TEST_CROWD_SIZE);
    expect([...users].every((id) => id.startsWith(TEST_USER_PREFIX))).toBe(true);
  });

  it("plays through the simulation within the cap and ends by itself", () => {
    const sim = new PlaygroundSim({ cellsW: 16, cellsH: 2, rng: mulberry32(5) });
    sim.resumeAfter(0);
    sim.startTest();
    const script = testCrowdScript(5, T0);
    let next = 0;
    let reversed = false;
    for (let i = 0; i <= CHARACTERS_TEST_TICKS + 30; i++) {
      while (next < script.length && script[next].atMs * 30 <= i * 1000) {
        const event = script[next].event;
        if (event.kind === "chat" && event.text === "wait, I am back!") {
          const p = sim.participants.get(`${event.platform}:${event.user.id}`);
          if (p && (p.state === "goto" || p.state === "exit")) reversed = true;
        }
        sim.receive(event);
        next += 1;
      }
      sim.tick();
      expect(admitted(sim).length).toBeLessThanOrEqual(VISIBLE_MAX);
    }
    expect(reversed).toBe(true);
    expect(sim.testEndsAt).toBeNull();
    expect(sim.participants.size).toBe(0);
  });
});
