import { z } from "zod";
import { CHANNEL_PLATFORMS } from "../../../db/enums";
import type { ActivityChat, ActivityEvent, ActivityPlatform } from "../activity";
import { isChatCommand } from "../chat-feed";
import { CHARACTERS_MAX, CHARACTERS_TIMEOUT } from "../overlay-layers";
import {
  BUBBLE_LENGTH,
  BUBBLE_MAX,
  BLOCK_FALL_TICKS,
  BODY_HEIGHT,
  BODY_REACH,
  BOOM_REACH_SQUARED,
  BOOM_THROW_PX,
  BUBBLE_TICKS,
  CHARACTERS_TEST_TICKS,
  CHECKPOINT_MAX_LENGTH,
  COMMAND_BUBBLE_TICKS,
  COMMAND_COOLDOWN_TICKS,
  COMMAND_EXPIRY_TICKS,
  CROWN_BLOCKS,
  DURATION,
  FALL_VX,
  FLAT_HEIGHT,
  GOTO_SPEED_MAX,
  GRAPPLE_REACH,
  GRAVITY,
  IDLE_CHANCE,
  JETPACK_BLOCKS,
  JUMP_VX,
  JUMP_VY,
  MARK_TICKS,
  MIN_STAY_TICKS,
  NEW_TICKS,
  PUSH_VX,
  PUSH_VY,
  REGISTRY_IDLE_TICKS,
  REGISTRY_MAX,
  REPEAT_MAX,
  RESPAWN_TICKS,
  RESTRICTED_MAX,
  ROTATION_TICKS,
  STEP_SPEED,
  STEP_UP,
  SWEEP_TICKS,
  TEST_USER_PREFIX,
  THROW_VX,
  THROW_VY,
  TICK_HZ,
  TILE,
  TURN_CHANCE,
  VISIBLE_MAX,
  WALK_BLOCKS_MAX,
  WALK_SPEED,
  WALK_SPEED_SPREAD,
} from "./constants";
import {
  addScore,
  COMMAND_ALIASES,
  COMMANDS,
  type Command,
  type CommandCall,
  chooseCrowd,
  crowdSlots,
  type Job,
  newParticipant,
  type Participant,
} from "./crowd";
import {
  BUBBLE_MAX_UNITS,
  type BubbleView,
  boundText,
  CHAR_STATES,
  type CharState,
  type CharTuple,
  type ExtrasView,
  type FlagTuple,
  FLAG_NEW,
  FLAG_UNAVAILABLE,
  FRAME_BLOCKS_MAX,
  FRAME_T_WRAP,
  FRAME_TILES_MAX,
  type ModeView,
  CUT_MARK,
  NAME_GRAPHEMES,
  NAME_MAX_UNITS,
  PLAYGROUND_VERSION,
  type PlaygroundFullFrame,
  type PlaygroundTickFrame,
  type RopeTuple,
  type RosterEntry,
  type TerrainView,
} from "./protocol";
import {
  type Block,
  blockAt,
  blocksString,
  canPlace,
  cellX,
  clearBuilds,
  colOf,
  createTerrain,
  createWorld,
  dropLoose,
  expire,
  type Flag,
  fits,
  floorY,
  groundString,
  hit,
  hitBlock,
  placeBlock,
  removeBlock,
  restoreBlocks,
  rowOf,
  solidAt,
  surface,
  type Terrain,
  terrainView,
  tileAt,
  tops,
  wallAt,
  type World,
} from "./terrain";

/**
 * The character playground simulation (issue #664, docs/characters.md). It is pure: no clock, no DOM, no art. The
 * caller injects the random source and calls `tick()` TICK_HZ times per second while the playground runs.
 *
 * Two modes:
 * - Running (`resumeAfter` called, not paused): chat admits characters, shows bubbles and queues commands.
 * - Registry (after `stop()`, or while paused): chat updates only scores and activity. Commands are dropped, never
 *   kept for later. `skip(gap)` moves the clock over a gap without simulating it.
 *
 * Moderation applies in both modes. Commands run only from live chat (`live: true`).
 */

interface SimOptions {
  cellsW: number;
  cellsH: number;
  /** Random source in [0, 1). Use mulberry32 for a seeded run. */
  rng: () => number;
  timeoutSeconds?: number;
  /** The most characters on screen (CHARACTERS_MAX). */
  visibleMax?: number;
  /** Speed spread over characters (WALK_SPEED_SPREAD). A test sets 0 to give every character WALK_SPEED. */
  walkSpread?: number;
}

/** The mulberry32 generator: a small, seeded random source in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state: number = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value: number = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sets the state and restarts its tick counter. */
export function setState(participant: Participant, state: CharState | "away", extra: Partial<Participant> = {}): void {
  Object.assign(participant, { state, t: 0 }, extra);
}

const SIDES: Readonly<Record<string, 1 | -1>> = { left: -1, l: -1, right: 1, r: 1 };
/** The emotes: they do not steer the character. */
const EMOTES: ReadonlySet<Command> = new Set<Command>(["dance", "wave", "cheer"]);
/** A boom or a push does not throw a character in these states. */
const FIXED_STATES: ReadonlySet<CharState | "away"> = new Set<CharState | "away">([
  "away",
  "gone",
  "enter",
  "exit",
  "respawn",
  "boom",
]);
/** The states in which a character stands on a floor: it can wear the crown and stop a walk beside it. */
const STANDING_STATES: ReadonlySet<CharState | "away"> = new Set<CharState | "away">([
  "hold",
  "walk",
  "idle",
  "turn",
  "step",
  "build",
  "dig",
  "wave",
  "dance",
  "cheer",
]);

/**
 * The command of a chat text, or null: the word after `!` (a command or an alias, in any letter case), then at most
 * two more words in any order: a number of 1 or 2 digits and a side (`left`, `right`, `l`, `r`). So `!dig`,
 * `！DIG 3`, `!dig left` and `!dig r 3` are commands.
 */
export function parseCommand(text: string): CommandCall | null {
  if (!isChatCommand(text)) return null;
  const [word = "", ...rest] = text
    .replace(/^[\s\p{Cf}]*[!！]/u, "")
    .toLowerCase()
    .split(/\s+/u);
  const name: Command | undefined =
    COMMANDS.find((command: Command): boolean => command === word) ??
    (Object.hasOwn(COMMAND_ALIASES, word) ? COMMAND_ALIASES[word] : undefined);
  if (!name) return null;
  const call: CommandCall = { name, n: 0, side: 0 };
  for (const token of rest.slice(0, 2)) {
    if (/^\d{1,2}$/.test(token)) call.n = Number(token);
    else if (Object.hasOwn(SIDES, token)) call.side = SIDES[token];
  }
  return call;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function siteKey(platform: ActivityPlatform, id: string): string {
  return `${platform}:${id}`;
}

export class PlaygroundSim {
  world: World;
  terrain: Terrain;
  /** Rules ticks since the playground started. */
  clock = 0;
  /** The rotating slots start at this index of the other active participants. */
  rotation = 0;
  paused = false;
  /** The tick at which the characters test ends, or null. */
  testEndsAt: number | null = null;
  /** The frame id of the character that wears the crown, or null. */
  crown: number | null = null;
  /** Participants by `platform:userId`, in registration order. */
  readonly participants = new Map<string, Participant>();
  /** Restricted participants by `platform:userId`: the tick at which the restriction ends. */
  readonly restrictions = new Map<string, number>();
  private active = false;
  private nextId = 1;
  private timeoutSeconds: number = CHARACTERS_TIMEOUT.default;
  private maxVisible: number = CHARACTERS_MAX.default;
  private readonly rng: () => number;
  private readonly walkSpread: number;
  private readonly sent = { roster: "", bubbles: "", terrain: "", extras: "", mode: "" };

  constructor(options: SimOptions) {
    this.world = createWorld(options.cellsW, options.cellsH);
    this.terrain = createTerrain(this.world);
    this.rng = options.rng;
    this.walkSpread = options.walkSpread ?? WALK_SPEED_SPREAD;
    if (options.timeoutSeconds !== undefined) this.setTimeoutSeconds(options.timeoutSeconds);
    if (options.visibleMax !== undefined) this.setVisibleMax(options.visibleMax);
  }

  /** True while commands run and `tick()` may be called. */
  get running(): boolean {
    return this.active && !this.paused;
  }

  get timeoutTicks(): number {
    return this.timeoutSeconds * TICK_HZ;
  }

  /** Sets the inactivity timeout, rounded and clamped to the CHARACTERS_TIMEOUT limits. Throws on NaN or infinity. */
  setTimeoutSeconds(seconds: number): void {
    if (!Number.isFinite(seconds)) throw new RangeError(`playground timeout must be a number: ${seconds}`);
    this.timeoutSeconds = Math.min(CHARACTERS_TIMEOUT.max, Math.max(CHARACTERS_TIMEOUT.min, Math.round(seconds)));
  }

  get visibleMax(): number {
    return this.maxVisible;
  }

  /**
   * Sets the most characters on screen, rounded and clamped to the CHARACTERS_MAX limits. Throws on NaN or infinity.
   * With more characters on screen, the next choice leaves the extra ones without a slot: they walk to the exit.
   */
  setVisibleMax(count: number): void {
    if (!Number.isFinite(count)) throw new RangeError(`playground maximum must be a number: ${count}`);
    this.maxVisible = Math.min(CHARACTERS_MAX.max, Math.max(CHARACTERS_MAX.min, Math.round(count)));
  }

  /** The participants in registration order. */
  list(): Participant[] {
    return [...this.participants.values()];
  }

  /** Applies one activity event. Status events change nothing. */
  receive(event: ActivityEvent): void {
    switch (event.kind) {
      case "chat":
        this.chat(event);
        return;
      case "delete":
        this.forget((key: string): boolean => key === siteKey(event.platform, event.messageId));
        return;
      case "ban":
        this.restrict(siteKey(event.platform, event.userId), event.until, event.receivedAt);
        return;
      case "clear":
        this.dropBubbles((p: Participant): boolean => p.platform === event.platform);
        return;
      case "clear_user":
        this.dropBubbles((p: Participant): boolean => p.key === siteKey(event.platform, event.userId));
        return;
      case "status":
        return;
    }
  }

  private chat(event: ActivityChat): void {
    const key: string = siteKey(event.platform, event.user.id);
    if (this.restricted(key)) return;
    const name: string = boundText(
      event.user.displayName || event.user.login || "",
      NAME_GRAPHEMES,
      NAME_MAX_UNITS,
      CUT_MARK,
    );
    const p: Participant = this.participants.get(key) ?? this.register(key, event.platform, event.user.id);
    p.name = name;
    p.lastChat = this.clock;
    addScore(p, this.clock);
    if (!this.running) return;
    if (p.exitReason === "timeout" && (p.state === "goto" || p.state === "exit")) {
      setState(p, "walk", { dir: p.x > this.world.w / 2 ? -1 : 1, free: false, exitReason: null });
    }
    if (event.live) this.queue(p, event);
    this.select();
  }

  private queue(p: Participant, event: ActivityChat): void {
    const call: CommandCall | null = parseCommand(event.text);
    if (call) {
      if (this.clock - p.lastCommand < COMMAND_COOLDOWN_TICKS) return;
      p.lastCommand = this.clock;
      // A stop works at once, also in the middle of a walk or of work of more than one step.
      if (call.name === "stop") this.halt(p);
      else p.pending = { ...call, expires: this.clock + COMMAND_EXPIRY_TICKS, key: event.id };
      return;
    }
    const text: string = boundText(event.text, BUBBLE_LENGTH, BUBBLE_MAX_UNITS, CUT_MARK);
    if (text) p.pendingText = { text, expires: this.clock + COMMAND_EXPIRY_TICKS, key: event.id };
  }

  private register(key: string, platform: ActivityPlatform, userId: string): Participant {
    if (this.participants.size >= REGISTRY_MAX) this.evict();
    const id: number = this.nextId++;
    const speed: number = WALK_SPEED + this.walkSpread * (mulberry32(id)() - 0.5);
    const p: Participant = newParticipant(key, id, platform, userId, "", this.clock, speed);
    this.participants.set(key, p);
    return p;
  }

  /** Forgets the participant with the oldest message that holds no slot. */
  private evict(): void {
    let oldest: Participant | null = null;
    for (const p of this.participants.values()) {
      if (!p.admitted && (oldest === null || p.lastChat < oldest.lastChat)) oldest = p;
    }
    // REGISTRY_MAX is far above VISIBLE_MAX, so some participant always holds no slot.
    if (oldest === null) throw new Error("playground registry full of admitted participants");
    this.participants.delete(oldest.key);
  }

  private restricted(key: string): boolean {
    const until: number | undefined = this.restrictions.get(key);
    return until !== undefined && until > this.clock;
  }

  /**
   * A ban or timeout. The character vanishes at once (frees its slot, drops its command and bubble) and the
   * participant is forgotten. Its chat is ignored until `until` (server time), or for REGISTRY_IDLE_TICKS when null.
   */
  private restrict(key: string, until: number | null, receivedAt: number): void {
    const end: number =
      until === null
        ? this.clock + REGISTRY_IDLE_TICKS
        : this.clock + Math.ceil(((until - receivedAt) * TICK_HZ) / 1000);
    if (end <= this.clock) return;
    if (this.restrictions.size >= RESTRICTED_MAX && !this.restrictions.has(key)) {
      let first: [string, number] = ["", Infinity];
      for (const entry of this.restrictions) if (entry[1] < first[1]) first = entry;
      this.restrictions.delete(first[0]);
    }
    this.restrictions.set(key, Math.max(end, this.restrictions.get(key) ?? 0));
    this.participants.delete(key);
  }

  /** Drops bubbles, queued text and queued commands that came from a deleted message. */
  private forget(match: (key: string) => boolean): void {
    for (const p of this.participants.values()) {
      if (p.bubble && match(p.bubble.key)) p.bubble = null;
      if (p.pendingText && match(p.pendingText.key)) p.pendingText = null;
      if (p.pending && match(p.pending.key)) p.pending = null;
    }
  }

  private dropBubbles(match: (p: Participant) => boolean): void {
    for (const p of this.participants.values()) {
      if (!match(p)) continue;
      p.bubble = null;
      p.pendingText = null;
    }
  }

  pause(): void {
    this.paused = true;
  }

  /** Ends the pause. The caller then calls `resumeAfter` with the paused time. */
  resume(): void {
    this.paused = false;
  }

  /** Forgets all participants and restores the terrain. Restrictions stay: a reset does not undo moderation. */
  reset(): void {
    this.participants.clear();
    this.terrain = createTerrain(this.world);
    this.rotation = 0;
    this.crown = null;
  }

  /** Removes all builds (blocks, stairs, planks and flags). The characters stay and fall to the ground. */
  clearBuilds(): void {
    clearBuilds(this.terrain);
    for (const p of this.participants.values()) p.job = null;
  }

  /**
   * Removes a character by its frame id. It vanishes and is not admitted again until a reset or until the registry
   * forgets it. Returns false when no participant has that id.
   */
  remove(id: number): boolean {
    const p: Participant | undefined = this.list().find((candidate: Participant): boolean => candidate.id === id);
    if (!p) return false;
    this.release(p);
    p.removed = true;
    return true;
  }

  startTest(): void {
    this.testEndsAt = this.clock + CHARACTERS_TEST_TICKS;
  }

  /** Ends the characters test and forgets its synthetic participants. */
  stopTest(): void {
    this.testEndsAt = null;
    for (const p of this.list()) if (p.userId.startsWith(TEST_USER_PREFIX)) this.participants.delete(p.key);
  }

  /** Changes the world to a new characters cell. Characters keep their relative place; actions end. */
  resize(cellsW: number, cellsH: number): void {
    if (cellsW === this.world.cellsW && cellsH === this.world.cellsH) return;
    const before: World = this.world;
    const after: World = createWorld(cellsW, cellsH);
    for (const p of this.participants.values()) {
      const share: number =
        (Math.min(before.xmax, Math.max(before.xmin, p.x)) - before.xmin) / (before.xmax - before.xmin);
      p.x = after.xmin + share * (after.xmax - after.xmin);
    }
    this.world = after;
    this.terrain = createTerrain(after);
    for (const p of this.participants.values()) this.settle(p);
  }

  /** Enters registry mode: the caller stops calling `tick()`. */
  stop(): void {
    this.active = false;
  }

  /**
   * Moves the clock over `gap` ticks without simulating them: due repairs and expiries apply, the rotation advances,
   * and every visible character stands walking. Actions, bubbles and queued commands are dropped.
   */
  skip(gap: number): void {
    if (!Number.isInteger(gap) || gap < 0)
      throw new RangeError(`playground gap must be a non-negative integer: ${gap}`);
    const from: number = this.clock;
    this.clock += gap;
    const rotations: number = Math.floor(this.clock / ROTATION_TICKS) - Math.floor(from / ROTATION_TICKS);
    this.rotation += crowdSlots(this.maxVisible).rotating * rotations;
    expire(this.terrain, this.clock);
    this.sweep();
    for (const p of this.participants.values()) this.settle(p);
  }

  /** Leaves registry mode after `gap` ticks. The caller then calls `tick()` TICK_HZ times per second. */
  resumeAfter(gap: number): void {
    this.skip(gap);
    this.active = true;
  }

  /** One rules tick. Throws when the playground is not running: the caller must not tick then. */
  tick(): void {
    if (!this.running) throw new Error("playground tick while not running");
    this.clock += 1;
    if (this.clock % ROTATION_TICKS === 0) this.rotation += crowdSlots(this.maxVisible).rotating;
    if (this.clock % SWEEP_TICKS === 0) this.sweep();
    this.select();
    expire(this.terrain, this.clock);
    if (this.terrain.loose && this.clock % BLOCK_FALL_TICKS === 0) {
      dropLoose(this.world, this.terrain, (c: number, r: number): boolean => this.crush(c, r));
    }
    for (const p of this.participants.values()) this.step(p);
    this.crownHolder();
  }

  /**
   * The tick at which the next participant, restriction or characters test expires, or null when there is none. A
   * participant expires REGISTRY_IDLE_TICKS after its last message.
   */
  expiresAt(): number | null {
    let next: number = this.testEndsAt ?? Infinity;
    for (const p of this.participants.values()) next = Math.min(next, p.lastChat + REGISTRY_IDLE_TICKS);
    for (const until of this.restrictions.values()) next = Math.min(next, until);
    return Number.isFinite(next) ? next : null;
  }

  /** Makes the next tick frame carry every section again, for example after a full frame or a restart. */
  resendSections(): void {
    Object.assign(this.sent, { roster: "", bubbles: "", terrain: "", extras: "", mode: "" });
  }

  /** Chooses the crowd and admits chosen participants while slots are free. */
  select(): void {
    const chosen: Participant[] = chooseCrowd(
      this.list(),
      this.clock,
      this.timeoutTicks,
      this.rotation,
      this.maxVisible,
    );
    let occupied: number = this.list().filter((p: Participant): boolean => p.admitted).length;
    for (const [index, p] of chosen.entries()) {
      if (p.admitted || occupied >= this.maxVisible) continue;
      p.admitted = true;
      p.admittedAt = this.clock;
      occupied += 1;
      // At tick 0 the first crowd stands spread over the ground; later arrivals walk in from the entrance.
      if (this.clock === 0) {
        const span: number = this.world.xmax - this.world.xmin - 24;
        setState(p, "walk", {
          x: this.world.xmin + 12 + ((index * 13) % span),
          y: this.world.gy,
          dir: index % 2 ? -1 : 1,
          free: false,
          exitReason: null,
        });
      } else {
        setState(p, "enter", { x: this.world.entryX, y: this.world.gy, dir: 1, free: true, exitReason: null });
      }
    }
  }

  /**
   * Expires restrictions, idle participants and the characters test. While it runs, a visible character walks out
   * after the inactivity timeout first; in registry mode an idle visible character is forgotten too.
   */
  private sweep(): void {
    for (const [key, until] of this.restrictions) if (until <= this.clock) this.restrictions.delete(key);
    for (const p of this.list()) {
      if ((!p.admitted || !this.running) && this.clock - p.lastChat >= REGISTRY_IDLE_TICKS)
        this.participants.delete(p.key);
    }
    if (this.testEndsAt !== null && this.clock >= this.testEndsAt) this.stopTest();
  }

  /** Frees the slot at once. */
  private release(p: Participant): void {
    setState(p, "away", { admitted: false, free: false, exitReason: null, mark: 0, piloted: false });
    this.clearQueue(p);
    this.terrain.flags = this.terrain.flags.filter((flag: Flag): boolean => flag.id !== p.id);
  }

  private clearQueue(p: Participant): void {
    p.bubble = null;
    p.pending = null;
    p.pendingText = null;
    p.job = null;
    p.rope = null;
  }

  /** After a gap or a change of world: a visible character stands walking on solid ground, or on the blocks there. */
  private settle(p: Participant): void {
    this.clearQueue(p);
    if (!p.admitted) return;
    let x: number = clamp(p.x, this.world.xmin, this.world.xmax);
    if (!solidAt(this.terrain, x)) x = this.world.padX;
    let r = 0;
    while (!fits(this.world, this.terrain, colOf(x), r)) r += 1;
    const y: number = floorY(this.world, r);
    setState(p, "walk", { x, y, vx: 0, vy: 0, free: false, exitReason: null, mark: 0, piloted: false });
  }

  /** Shows a bubble. With BUBBLE_MAX bubbles already shown by others, the one closest to its end goes. */
  private say(p: Participant, text: string, ticks: number, key: string): void {
    const shown: { owner: Participant; ticks: number }[] = this.list().flatMap((o: Participant) =>
      o !== p && o.bubble ? [{ owner: o, ticks: o.bubble.ticks }] : [],
    );
    if (shown.length >= BUBBLE_MAX) shown.reduce((a, b) => (b.ticks < a.ticks ? b : a), shown[0]).owner.bubble = null;
    p.bubble = { text, ticks, key, at: this.clock };
  }

  /** The column and the feet row of a character in the block grid. */
  private col(p: Participant): number {
    return colOf(p.x);
  }

  private row(p: Participant): number {
    return rowOf(this.world, p.y);
  }

  /**
   * Another steered character has its body in cell (c, r). A character that only walks around does not keep a cell:
   * a block that goes there lifts it (see unbury).
   */
  private taken(c: number, r: number, me: Participant | null): boolean {
    for (const o of this.participants.values()) {
      if (o === me || !o.admitted || !o.piloted || o.state === "gone" || colOf(o.x) !== c) continue;
      const feet: number = this.row(o);
      if (feet === r || feet + 1 === r) return true;
    }
    return false;
  }

  /** A block can go in cell (c, r), and no other character is there. */
  private canBuild(c: number, r: number, me: Participant): boolean {
    return canPlace(this.world, this.terrain, c, r) && !this.taken(c, r, me);
  }

  /** A loose block falls on cell (c, r): a character there breaks it and lies flat. */
  private crush(c: number, r: number): boolean {
    let hit = false;
    for (const p of this.participants.values()) {
      if (!p.admitted || FIXED_STATES.has(p.state) || colOf(p.x) !== c) continue;
      const feet: number = this.row(p);
      if (feet !== r && feet + 1 !== r) continue;
      hit = true;
      p.job = null;
      p.rope = null;
      if (STANDING_STATES.has(p.state)) setState(p, "flat");
    }
    return hit;
  }

  /** The crown stays with its wearer until another standing character is higher, or the wearer comes down. */
  private crownHolder(): void {
    const height = (p: Participant): number => this.world.gy - p.y;
    const high: Participant[] = this.visible().filter(
      (p: Participant): boolean => STANDING_STATES.has(p.state) && height(p) >= CROWN_BLOCKS * TILE,
    );
    let holder: Participant | null = high.find((p: Participant): boolean => p.id === this.crown) ?? null;
    for (const p of high) if (!holder || height(p) > height(holder)) holder = p;
    this.crown = holder?.id ?? null;
  }

  /** After an action: a steered character stands still, and another character walks on. */
  private rest(p: Participant, extra: Partial<Participant> = {}): void {
    setState(p, p.piloted ? "hold" : "walk", { vx: 0, vy: 0, resume: false, ...extra });
  }

  /** After a landing: a walk of some blocks that went off an edge goes on. */
  private landed(p: Participant): void {
    if (p.resume) setState(p, "step", { vx: 0, vy: 0, resume: false });
    else this.rest(p);
  }

  /** The command cannot run, or cannot go on: the work ends. A red cross shows unless a step was done. */
  private giveUp(p: Participant, quiet: boolean = false): void {
    if (!quiet) p.mark = MARK_TICKS;
    p.job = null;
    p.rope = null;
    this.rest(p);
  }

  /** A stop: the queued command and the work go, and a walk of some blocks ends where the character is. */
  private halt(p: Participant): void {
    Object.assign(p, { pending: null, job: null, resume: false });
    if (!p.admitted || p.state === "away") return;
    p.piloted = true;
    if (p.state === "step" || p.state === "walk" || p.state === "idle") setState(p, "hold");
  }

  /** Throws a character: it flies to `dir` and falls. Its work ends. */
  private fling(o: Participant, dir: 1 | -1, vx: number, vy: number): void {
    o.job = null;
    o.rope = null;
    setState(o, "fall", { vx: dir * vx, vy, fromY: o.y, resume: false });
  }

  /** Starts a command action. The caller makes sure the character is walking or standing inside the walking limits. */
  perform(p: Participant, command: Command, key = "", n = 0, side: 1 | -1 | 0 = 0): void {
    const words: string[] = [`!${command}`];
    if (side !== 0) words.push(side < 0 ? "left" : "right");
    if (n > 0) words.push(String(n));
    this.say(p, words.join(" "), COMMAND_BUBBLE_TICKS, key);
    Object.assign(p, { job: null, rope: null, resume: false });
    if (!EMOTES.has(command)) p.piloted = true;
    // A side turns the character first. `look` shows the turn, and a walk has its own side.
    if (side !== 0 && command !== "look" && command !== "left" && command !== "right") p.dir = side;
    this.starts[command](p, n, side);
  }

  /** How each command starts. `n` is 0 without a number, and `side` is 0 without a side. */
  private readonly starts: Record<Command, (p: Participant, n: number, side: 1 | -1 | 0) => void> = {
    left: (p: Participant, n: number): void => this.walkTo(p, -1, n),
    right: (p: Participant, n: number): void => this.walkTo(p, 1, n),
    look: (p: Participant, _n: number, side: 1 | -1 | 0): void => {
      if (side === p.dir) this.rest(p);
      else setState(p, "turn");
    },
    stop: (p: Participant): void => this.rest(p),
    jump: (p: Participant): void => setState(p, "jump"),
    block: (p: Participant): void => this.job(p, "block", 1, 0),
    up: (p: Participant): void => this.job(p, "up", 1, 0),
    stairs: (p: Participant, n: number): void => this.job(p, "stairs", n, 0),
    bridge: (p: Participant, n: number): void => this.job(p, "bridge", n, 0),
    dig: (p: Participant, n: number, side: 1 | -1 | 0): void => this.job(p, "dig", n, side),
    flag: (p: Participant): void => this.job(p, "flag", 1, 0),
    grapple: (p: Participant): void => this.grapple(p),
    jetpack: (p: Participant, n: number): void => this.jetpack(p, n),
    boom: (p: Participant): void => setState(p, "boom"),
    dance: (p: Participant): void => setState(p, "dance"),
    wave: (p: Participant): void => setState(p, "wave"),
    cheer: (p: Participant): void => setState(p, "cheer"),
    push: (p: Participant): void => this.push(p),
  };

  /** A walk of `n` blocks (1 without a number) to the centre of a column. */
  private walkTo(p: Participant, dir: 1 | -1, n: number): void {
    const blocks: number = clamp(n || 1, 1, WALK_BLOCKS_MAX);
    const target: number = clamp(cellX(this.col(p) + dir * blocks), TILE / 2, this.world.w - TILE / 2);
    setState(p, "step", { dir, target, extra: false });
  }

  /** A walk to the next column for work that goes on there. It does not take one more block. */
  private walkOn(p: Participant, c: number): void {
    setState(p, "step", { target: cellX(c), extra: true });
  }

  /** Starts work of `n` steps (1 without a number, REPEAT_MAX at most). */
  private job(p: Participant, kind: Job["kind"], n: number, side: 1 | -1 | 0): void {
    p.job = { kind, left: clamp(n || 1, 1, REPEAT_MAX), side, c: 0, r: 0, done: false };
    this.work(p);
  }

  /** The next step of the work of a character, or its end. */
  private work(p: Participant): void {
    const job: Job | null = p.job;
    if (!job) return;
    if (job.left <= 0) {
      p.job = null;
      this.rest(p);
      return;
    }
    if (!this.jobs[job.kind](p, job)) this.giveUp(p, job.done);
  }

  /** Each kind of work chooses its cell and starts its action. False when the step cannot be done. */
  private readonly jobs: Record<Job["kind"], (p: Participant, job: Job) => boolean> = {
    block: (p: Participant, job: Job): boolean => {
      const c: number = this.col(p) + p.dir;
      const feet: number = this.row(p);
      const r: number | undefined = [feet, feet + 1].find((y: number): boolean => this.canBuild(c, y, p));
      if (r === undefined) return false;
      return this.buildAt(p, job, c, r);
    },
    up: (p: Participant, job: Job): boolean => {
      const c: number = this.col(p);
      const r: number = this.row(p);
      if (!this.canBuild(c, r, p) || wallAt(this.world, this.terrain, c, r + 2)) return false;
      return this.buildAt(p, job, c, r);
    },
    flag: (p: Participant, job: Job): boolean => this.buildAt(p, job, this.col(p), this.row(p)),
    stairs: (p: Participant, job: Job): boolean => {
      const c: number = this.col(p) + p.dir;
      const r: number = this.row(p);
      // Room to stand on the stair, and room over the head on the way up.
      if (!fits(this.world, this.terrain, c, r + 1) || wallAt(this.world, this.terrain, this.col(p), r + 2))
        return false;
      const there: Block | null = blockAt(this.world, this.terrain, c, r);
      if (there) return there.kind === "stair" && there.dir === p.dir && this.stepOn(p, job, c);
      return this.canBuild(c, r, p) && this.buildAt(p, job, c, r);
    },
    bridge: (p: Participant, job: Job): boolean => {
      const c: number = this.col(p) + p.dir;
      const r: number = this.row(p);
      if (r === 0 || !fits(this.world, this.terrain, c, r)) return false;
      if (blockAt(this.world, this.terrain, c, r - 1)) return this.stepOn(p, job, c);
      return this.canBuild(c, r - 1, p) && this.buildAt(p, job, c, r - 1);
    },
    dig: (p: Participant, job: Job): boolean => {
      const feet: number = this.row(p);
      if (job.side !== 0) {
        const c: number = this.col(p) + p.dir;
        const r: number | undefined = [feet, feet + 1].find(
          (y: number): boolean => !!blockAt(this.world, this.terrain, c, y),
        );
        if (r === undefined) return false;
        Object.assign(job, { c, r });
      } else if (feet > 0) {
        if (!blockAt(this.world, this.terrain, this.col(p), feet - 1)) return false;
        Object.assign(job, { c: this.col(p), r: feet - 1 });
      } else {
        // The ground: the dig action finds the tile and shows the red cross on protected ground.
        job.r = -1;
      }
      setState(p, "dig");
      return true;
    },
  };

  private buildAt(p: Participant, job: Job, c: number, r: number): boolean {
    Object.assign(job, { c, r });
    setState(p, "build");
    return true;
  }

  /** The step is there already (a stair or a floor): the character walks on, and the step counts. */
  private stepOn(p: Participant, job: Job, c: number): boolean {
    job.left -= 1;
    job.done = true;
    this.walkOn(p, c);
    return true;
  }

  /** The first block that a hook catches, and the row where the character then stands on that column. */
  private hook(p: Participant): { c: number; r: number; land: number } | null {
    const c: number = this.col(p);
    const r: number = this.row(p);
    const rays: ((i: number) => [number, number])[] = [
      (i: number): [number, number] => [c + p.dir * i, r + i],
      (i: number): [number, number] => [c + p.dir, r + 1 + i],
      (i: number): [number, number] => [c, r + 1 + i],
    ];
    for (const ray of rays) {
      for (let i = 1; i <= GRAPPLE_REACH; i++) {
        const [hc, hr] = ray(i);
        if (!blockAt(this.world, this.terrain, hc, hr)) continue;
        let land: number = hr + 1;
        while (wallAt(this.world, this.terrain, hc, land)) land += 1;
        if (fits(this.world, this.terrain, hc, land) && land > r && !this.taken(hc, land, p))
          return { c: hc, r: hr, land };
        break;
      }
    }
    return null;
  }

  private grapple(p: Participant): void {
    const hit = this.hook(p);
    if (!hit) {
      const reach: number = GRAPPLE_REACH * TILE * 0.7;
      setState(p, "shoot", { rope: { x: p.x + p.dir * reach, y: p.y - BODY_HEIGHT - reach, hit: false } });
      return;
    }
    setState(p, "shoot", {
      rope: { x: cellX(hit.c), y: floorY(this.world, hit.r) - TILE / 2, hit: true },
      tx: cellX(hit.c),
      ty: floorY(this.world, hit.land),
    });
  }

  /** Flies `n` blocks up (JETPACK_BLOCKS without a number), through blocks, then on to the first free place. */
  private jetpack(p: Participant, n: number): void {
    const c: number = this.col(p);
    let r: number = Math.min(this.world.rows, this.row(p) + clamp(n || JETPACK_BLOCKS, 1, REPEAT_MAX));
    while (!fits(this.world, this.terrain, c, r)) r += 1;
    this.tween(p, "jet", p.x, floorY(this.world, r), "hold");
  }

  private push(p: Participant): void {
    const victim: Participant | undefined = this.visible().find((o: Participant): boolean => {
      const ahead: number = (o.x - p.x) * p.dir;
      return (
        o !== p && STANDING_STATES.has(o.state) && ahead > 0 && ahead <= TILE + BODY_REACH && Math.abs(o.y - p.y) < 8
      );
    });
    if (!victim) {
      this.giveUp(p);
      return;
    }
    setState(p, "push", { victim: victim.id });
  }

  /** Moves a character in a straight line to (tx, ty) in a time that grows with the height, then to state `after`. */
  private tween(p: Participant, state: "climb" | "zip" | "jet", tx: number, ty: number, after: CharState): void {
    const blocks: number = Math.abs(ty - p.y) / TILE;
    const span: number =
      state === "climb" ? DURATION.climb : DURATION.tweenBase + Math.round(blocks * DURATION.tweenPerBlock);
    setState(p, state, { sx: p.x, sy: p.y, tx, ty, span, after, vx: 0, vy: 0 });
  }

  private tweenStep(p: Participant): void {
    const share: number = Math.min(1, p.t / p.span);
    p.x = p.sx + (p.tx - p.sx) * share;
    p.y = p.sy + (p.ty - p.sy) * share;
    if (share < 1) return;
    p.rope = null;
    setState(p, p.after, { fromY: p.y });
  }

  /** A wall is in front of a walker: a dirt block or a plank at its body in the next column. */
  private walled(p: Participant, nx: number): number | null {
    const c: number = colOf(nx + p.dir * BODY_REACH);
    if (c === this.col(p) || fits(this.world, this.terrain, c, this.row(p))) return null;
    return c;
  }

  private walkStep(p: Participant, speed: number, bounded: boolean = !p.free): void {
    const nx: number = p.x + p.dir * speed;
    if (bounded && ((nx < this.world.xmin && p.dir < 0) || (nx > this.world.xmax && p.dir > 0))) {
      setState(p, "turn");
      return;
    }
    const top: number = surface(this.world, this.terrain, nx, p.y, STEP_UP);
    p.x = nx;
    if (top === Infinity || top > p.y + 0.5) this.drop(p, p.dir * FALL_VX);
    else p.y = top;
  }

  /** The floor is gone: the character falls. Only a dig goes on after the fall. */
  private drop(p: Participant, vx: number): void {
    if (p.job?.kind !== "dig") p.job = null;
    setState(p, "fall", { vy: 0, vx, fromY: p.y });
  }

  /** A character in a block comes out on top of it. */
  private unbury(p: Participant): void {
    const c: number = this.col(p);
    let r: number = this.row(p);
    if (!wallAt(this.world, this.terrain, c, r)) return;
    while (wallAt(this.world, this.terrain, c, r)) r += 1;
    p.y = floorY(this.world, r);
  }

  /** A walk of some blocks: over one block alone, off an edge, and to a stop at a higher wall or a door zone. */
  private stepWalk(p: Participant): void {
    const left: number = p.target - p.x;
    if (Math.abs(left) <= STEP_SPEED) {
      this.arrive(p);
      return;
    }
    p.dir = left > 0 ? 1 : -1;
    const nx: number = p.x + p.dir * STEP_SPEED;
    const r: number = this.row(p);
    const outside: boolean = nx < TILE / 2 || nx > this.world.w - TILE / 2;
    const doorZone: boolean = r === 0 && ((nx < this.world.xmin && p.dir < 0) || (nx > this.world.xmax && p.dir > 0));
    if (outside || doorZone) {
      this.giveUp(p);
      return;
    }
    const wall: number | null = this.walled(p, nx);
    if (wall === null) {
      this.walkStep(p, STEP_SPEED, false);
      // Off an edge: the walk goes on after the landing.
      if (p.state === "fall") p.resume = true;
      return;
    }
    const low: boolean =
      fits(this.world, this.terrain, wall, r + 1) && !wallAt(this.world, this.terrain, this.col(p), r + 2);
    if (low) this.tween(p, "climb", cellX(wall), floorY(this.world, r + 1), "step");
    else this.giveUp(p);
  }

  /** The walk is at its target. When another character stands there, the walk takes one more block, one time. */
  private arrive(p: Participant): void {
    p.x = p.target;
    const shared: boolean = this.visible().some(
      (o: Participant): boolean => o !== p && o.state === "hold" && Math.abs(o.x - p.x) < 5 && Math.abs(o.y - p.y) < 4,
    );
    if (shared && !p.extra) {
      Object.assign(p, { extra: true, target: clamp(p.target + p.dir * TILE, TILE / 2, this.world.w - TILE / 2) });
      return;
    }
    this.rest(p);
  }

  /** A dirt block or a plank is at the body of a character with its feet at (x, y). */
  private bodyHits(x: number, y: number): boolean {
    const c: number = colOf(x);
    const from: number = Math.floor((this.world.gy - y + 0.01) / TILE);
    const to: number = Math.floor((this.world.gy - y + BODY_HEIGHT) / TILE);
    for (let r = from; r <= to; r++) if (wallAt(this.world, this.terrain, c, r)) return true;
    return false;
  }

  private physics(p: Participant): void {
    p.vy += GRAVITY;
    let ny: number = p.y + p.vy;
    let nx: number = p.x + p.vx;
    if (nx < this.world.bounceMin || nx > this.world.bounceMax) {
      p.vx = 0;
      nx = p.x;
    }
    // A wall stops the move to the side, and a block over the head stops the rise.
    if (p.vx !== 0 && this.bodyHits(nx + Math.sign(p.vx) * BODY_REACH, p.y)) nx = p.x;
    if (p.vy < 0 && this.bodyHits(nx, ny)) {
      p.vy = 0;
      ny = p.y;
    }
    const landings: number[] =
      p.vy > 0
        ? tops(this.world, this.terrain, nx).filter((top: number): boolean => p.y <= top + 0.01 && ny >= top)
        : [];
    p.x = nx;
    if (landings.length > 0) {
      const land: number = Math.min(...landings);
      p.y = land;
      p.vy = 0;
      setState(p, land - p.fromY > FLAT_HEIGHT ? "flat" : "land");
      return;
    }
    p.y = ny;
    if (p.y > this.world.fallY) this.vanish(p);
  }

  /** The character is gone until its respawn. It then walks around again. */
  private vanish(p: Participant): void {
    setState(p, "gone", { wait: RESPAWN_TICKS, piloted: false, job: null, rope: null, resume: false });
  }

  private step(p: Participant): void {
    if (p.bubble && --p.bubble.ticks <= 0) p.bubble = null;
    if (p.mark > 0) p.mark -= 1;
    if (p.pending && p.pending.expires < this.clock) p.pending = null;
    if (p.pendingText && p.pendingText.expires < this.clock) p.pendingText = null;
    if (p.state === "away") return;
    p.t += 1;
    // Work of more than one step ends first: a queued command or an exit waits for it. A stop ends it at once.
    if ((p.state === "walk" || p.state === "hold") && !p.job) this.walkTurn(p);
    this.actions[p.state](p);
  }

  /**
   * A walking or standing character leaves when its time is up, or else shows its queued text and starts its queued
   * command.
   */
  private walkTurn(p: Participant): void {
    const timedOut: boolean = this.clock - p.lastChat >= this.timeoutTicks;
    if ((!p.eligible || timedOut) && this.clock - p.admittedAt >= MIN_STAY_TICKS) {
      p.job = null;
      setState(p, "goto", {
        target: this.world.exitX,
        after: "exit",
        free: true,
        exitReason: timedOut ? "timeout" : "capacity",
      });
      return;
    }
    if (p.free) return;
    if (p.pendingText) {
      this.say(p, p.pendingText.text, BUBBLE_TICKS, p.pendingText.key);
      p.pendingText = null;
    }
    if (p.pending) {
      const pending = p.pending;
      p.pending = null;
      this.perform(p, pending.name, pending.key, pending.n, pending.side);
    }
  }

  /**
   * The place on the ground for a character that comes in: the free column in the walking limits that is farthest
   * from the other characters on the ground.
   */
  private spot(me: Participant): number {
    const first: number = this.world.xmin + 12;
    const others: number[] = this.visible()
      .filter((o: Participant): boolean => o !== me && o.state !== "gone" && this.world.gy - o.y < TILE)
      .map((o: Participant): number => (o.state === "goto" && o.after === "walk" ? o.target : o.x));
    let best: number = first;
    let bestGap = -1;
    for (let c = colOf(first); cellX(c) <= this.world.xmax - 12; c++) {
      const x: number = cellX(c);
      if (x < first || !solidAt(this.terrain, x) || !fits(this.world, this.terrain, c, 0)) continue;
      const gap: number = Math.min(this.world.w, ...others.map((o: number): number => Math.abs(o - x)));
      if (gap > bestGap) [best, bestGap] = [x, gap];
    }
    return best;
  }

  private timed(ticks: number): (p: Participant) => void {
    return (p: Participant): void => {
      if (p.t >= ticks) this.rest(p);
    };
  }

  /** What a character in each state does in a tick. */
  private readonly actions: Record<CharState, (p: Participant) => void> = {
    gone: (p: Participant): void => {
      if (--p.wait > 0) return;
      if (p.eligible) setState(p, "respawn", { x: this.world.padX, y: this.world.gy - 6, dir: 1 });
      else this.release(p);
    },
    enter: (p: Participant): void => {
      if (p.t < DURATION.enter) return;
      // A character with a queued command walks in and runs it at the walking limit. The others go to a free place.
      if (p.pending) setState(p, "walk", { free: true });
      else setState(p, "goto", { target: this.spot(p), after: "walk", free: true });
    },
    respawn: (p: Participant): void => {
      if (p.t >= DURATION.respawn) setState(p, "walk", { y: this.world.gy });
    },
    walk: (p: Participant): void => {
      this.unbury(p);
      if (!p.free && this.walled(p, p.x + p.dir * p.speed) !== null) {
        setState(p, "turn");
        return;
      }
      this.walkStep(p, p.speed);
      if (p.free && p.x > this.world.xmin + 4) p.free = false;
      if (p.state !== "walk" || p.free) return;
      if (this.rng() < TURN_CHANCE) setState(p, "turn");
      else if (this.rng() < IDLE_CHANCE) setState(p, "idle");
    },
    idle: (p: Participant): void => {
      this.unbury(p);
      if (p.t >= DURATION.idle) setState(p, "walk");
    },
    hold: (p: Participant): void => {
      this.unbury(p);
      const top: number = surface(this.world, this.terrain, p.x, p.y, STEP_UP);
      if (top === Infinity || top > p.y + 0.5) {
        this.drop(p, 0);
        return;
      }
      p.y = top;
      if (p.job) this.work(p);
    },
    step: (p: Participant): void => this.stepWalk(p),
    turn: (p: Participant): void => {
      if (p.t >= DURATION.turn) this.rest(p, { dir: p.dir === 1 ? -1 : 1 });
    },
    goto: (p: Participant): void => {
      p.dir = p.target > p.x ? 1 : -1;
      this.walkStep(p, Math.min(GOTO_SPEED_MAX, Math.abs(p.target - p.x)));
      if (p.state === "goto" && Math.abs(p.x - p.target) < 0.7) setState(p, p.after, { x: p.target });
    },
    jump: (p: Participant): void => {
      if (p.t < DURATION.jumpCrouch) return;
      if (p.t === DURATION.jumpCrouch) Object.assign(p, { vy: JUMP_VY, vx: p.dir * JUMP_VX, fromY: p.y });
      this.physics(p);
    },
    fall: (p: Participant): void => this.physics(p),
    land: (p: Participant): void => {
      if (p.t > DURATION.land) this.landed(p);
    },
    flat: (p: Participant): void => {
      if (p.t > DURATION.flat) this.landed(p);
    },
    dig: (p: Participant): void => this.dig(p),
    build: (p: Participant): void => this.build(p),
    climb: (p: Participant): void => this.tweenStep(p),
    zip: (p: Participant): void => this.tweenStep(p),
    jet: (p: Participant): void => this.tweenStep(p),
    shoot: (p: Participant): void => {
      if (p.rope?.hit && p.t >= DURATION.shootHit) this.tween(p, "zip", p.tx, p.ty, "hold");
      else if (!p.rope?.hit && p.t >= DURATION.shootMiss) this.giveUp(p);
    },
    wave: this.timed(DURATION.wave),
    dance: this.timed(DURATION.dance),
    cheer: this.timed(DURATION.cheer),
    push: (p: Participant): void => {
      if (p.t < DURATION.push) return;
      const victim: Participant | undefined = this.visible().find((o: Participant): boolean => o.id === p.victim);
      if (victim && !FIXED_STATES.has(victim.state)) this.fling(victim, p.dir, PUSH_VX, PUSH_VY);
      this.rest(p);
    },
    boom: (p: Participant): void => {
      if (p.t === DURATION.boomAt) this.blast(p);
      if (p.t >= DURATION.boom) this.vanish(p);
    },
    exit: (p: Participant): void => {
      if (p.t >= DURATION.exit) this.release(p);
    },
  };

  /** A boom breaks the builds around the character and throws the characters nearby. */
  private blast(p: Participant): void {
    const c0: number = this.col(p);
    const r0: number = this.row(p);
    for (let c = c0 - 3; c <= c0 + 3; c++) {
      for (let r = r0 - 3; r <= r0 + 3; r++) {
        if ((c - c0) ** 2 + (r - r0 - 0.5) ** 2 <= BOOM_REACH_SQUARED) removeBlock(this.world, this.terrain, c, r);
      }
    }
    for (const o of this.visible()) {
      const near: boolean = Math.abs(o.x - p.x) <= BOOM_THROW_PX && Math.abs(o.y - p.y) <= BOOM_THROW_PX;
      if (o === p || !near || FIXED_STATES.has(o.state)) continue;
      const away: 1 | -1 = o.x === p.x ? p.dir : o.x > p.x ? 1 : -1;
      this.fling(o, away, THROW_VX, THROW_VY);
    }
  }

  /** One hit of a dig: on the block of the work, or on the ground in front of the feet. False when nothing breaks. */
  private digHit(p: Participant): boolean {
    const job: Job | null = p.job;
    if (job && job.r >= 0) return hitBlock(this.world, this.terrain, job.c, job.r);
    const tile = tileAt(this.terrain, p.x + p.dir * 4) ?? tileAt(this.terrain, p.x);
    return tile !== undefined && hit(this.terrain, tile, this.clock);
  }

  private dig(p: Participant): void {
    if (p.t % DURATION.digEvery === DURATION.digAt && !this.digHit(p)) {
      this.giveUp(p, p.job?.done ?? false);
      return;
    }
    if (p.t < DURATION.dig) return;
    const job: Job | null = p.job;
    if (!job) {
      this.rest(p);
      return;
    }
    job.left -= 1;
    job.done = true;
    // A dig to the side goes on in the gap, when the gap has a floor and room to stand.
    const r: number = this.row(p);
    const floor: boolean =
      r === 0 ? solidAt(this.terrain, cellX(job.c)) : !!blockAt(this.world, this.terrain, job.c, r - 1);
    if (job.side !== 0 && job.left > 0 && floor && fits(this.world, this.terrain, job.c, r)) this.walkOn(p, job.c);
    else setState(p, "hold");
  }

  /** Puts the block or the flag of the work in its cell. False when the cell is not free any more. */
  private place(p: Participant, job: Job): boolean {
    if (job.kind === "flag") {
      this.terrain.flags = this.terrain.flags.filter((flag: Flag): boolean => flag.id !== p.id);
      this.terrain.flags.push({ id: p.id, c: job.c, r: job.r });
    } else if (job.kind !== "dig") {
      if (!this.canBuild(job.c, job.r, p)) return false;
      const kind = job.kind === "stairs" ? "stair" : job.kind === "bridge" ? "plank" : "dirt";
      // Only a stair has a direction.
      placeBlock(this.world, this.terrain, job.c, job.r, kind, kind === "stair" ? p.dir : 1);
    }
    job.left -= 1;
    job.done = true;
    return true;
  }

  private build(p: Participant): void {
    const job: Job | null = p.job;
    if (p.t === DURATION.buildAt && job && !this.place(p, job)) {
      this.giveUp(p, job.done);
      return;
    }
    if (p.t < DURATION.buildEnd) return;
    if (job?.kind === "up") this.tween(p, "climb", p.x, floorY(this.world, job.r + 1), "hold");
    else if (job?.kind === "stairs" || job?.kind === "bridge") this.walkOn(p, job.c);
    else setState(p, job ? "hold" : p.piloted ? "hold" : "walk");
  }

  private visible(): Participant[] {
    return this.list().filter((p: Participant): boolean => p.admitted);
  }

  private chars(visible: Participant[]): CharTuple[] {
    return visible.map((p: Participant): CharTuple => {
      const flags: number =
        (p.mark > 0 ? FLAG_UNAVAILABLE : 0) | (this.clock - p.admittedAt < NEW_TICKS ? FLAG_NEW : 0);
      return [
        p.id,
        Math.round(p.x * 10),
        Math.round(p.y * 10),
        CHAR_STATES.indexOf(p.state as CharState),
        p.t % FRAME_T_WRAP,
        p.dir,
        flags,
      ];
    });
  }

  private extras(visible: Participant[]): ExtrasView {
    const ids = new Set<number>(visible.map((p: Participant): number => p.id));
    return {
      ropes: visible.flatMap((p: Participant): RopeTuple[] =>
        p.rope ? [[p.id, Math.round(p.rope.x), Math.round(p.rope.y), p.rope.hit ? 1 : 0]] : [],
      ),
      flags: this.terrain.flags
        .filter((flag: Flag): boolean => ids.has(flag.id))
        .map((flag: Flag): FlagTuple => [flag.id, cellX(flag.c), floorY(this.world, flag.r)]),
      crown: this.crown !== null && ids.has(this.crown) ? this.crown : null,
    };
  }

  private sections(): {
    roster: RosterEntry[];
    bubbles: BubbleView[];
    terrain: TerrainView;
    extras: ExtrasView;
    mode: ModeView;
  } {
    const visible: Participant[] = this.visible();
    return {
      roster: visible.map((p: Participant): RosterEntry => ({ id: p.id, platform: p.platform, name: p.name })),
      // Oldest first, so the overlay draws the newest bubble on top.
      bubbles: visible
        .flatMap((p: Participant): [number, BubbleView][] =>
          p.bubble ? [[p.bubble.at, { id: p.id, text: p.bubble.text }]] : [],
        )
        .sort((a: [number, BubbleView], b: [number, BubbleView]): number => a[0] - b[0])
        .map(([, bubble]: [number, BubbleView]): BubbleView => bubble),
      terrain: terrainView(this.world, this.terrain),
      extras: this.extras(visible),
      mode: { paused: this.paused, test: this.testEndsAt !== null },
    };
  }

  /** The frame for a socket that just subscribed: every section. */
  fullFrame(): PlaygroundFullFrame {
    return {
      type: "playground",
      v: PLAYGROUND_VERSION,
      full: true,
      tick: this.clock,
      chars: this.chars(this.visible()),
      ...this.sections(),
    };
  }

  /** The frame after a tick: the characters, and each other section only when it changed since the last tick frame. */
  tickFrame(): PlaygroundTickFrame {
    const frame: PlaygroundTickFrame = {
      type: "playground",
      v: PLAYGROUND_VERSION,
      full: false,
      tick: this.clock,
      chars: this.chars(this.visible()),
    };
    const sections = this.sections();
    for (const name of ["roster", "bubbles", "terrain", "extras", "mode"] as const) {
      const json: string = JSON.stringify(sections[name]);
      if (json === this.sent[name]) continue;
      this.sent[name] = json;
      Object.assign(frame, { [name]: sections[name] });
    }
    return frame;
  }

  /**
   * The state to keep across a Durable Object eviction, as JSON of at most CHECKPOINT_MAX_LENGTH. Actions, bubbles
   * and queued commands are not kept. When the JSON is too long, the participants without a slot that spoke least
   * recently go first, then the restrictions that end first. The kept participants stay in registration order, which
   * the crowd choice uses for ties and the rotation.
   */
  checkpoint(): string {
    let kept: Participant[] = this.list();
    // The drop order: the participants without a slot, the most recent message first, so the end goes first.
    const droppable: Participant[] = kept
      .filter((p: Participant): boolean => !p.admitted)
      .sort((a: Participant, b: Participant): number => b.lastChat - a.lastChat);
    const restrictions: [string, number][] = [...this.restrictions].sort(
      (a: [string, number], b: [string, number]): number => b[1] - a[1],
    );
    for (;;) {
      const json: string = JSON.stringify(this.snapshot(kept.map(toRecord), restrictions));
      if (json.length <= CHECKPOINT_MAX_LENGTH) return json;
      if (droppable.length > 0) {
        const dropped = new Set<Participant>(droppable.splice(-Math.ceil(kept.length / 10)));
        kept = kept.filter((p: Participant): boolean => !dropped.has(p));
      } else if (restrictions.length > 0) restrictions.splice(-Math.ceil(restrictions.length / 10));
      else throw new Error(`playground checkpoint too long: ${json.length}`);
    }
  }

  private snapshot(registry: ParticipantRecord[], restrictions: [string, number][]): Checkpoint {
    const repairs: [number, number][] = [];
    for (const [index, tile] of this.terrain.tiles.entries()) if (tile.repairAt) repairs.push([index, tile.repairAt]);
    return {
      v: PLAYGROUND_VERSION,
      clock: this.clock,
      nextId: this.nextId,
      rotation: this.rotation,
      paused: this.paused,
      testEndsAt: this.testEndsAt,
      timeoutSeconds: this.timeoutSeconds,
      visibleMax: this.maxVisible,
      cellsW: this.world.cellsW,
      cellsH: this.world.cellsH,
      ground: groundString(this.terrain),
      repairs,
      blocks: blocksString(this.world, this.terrain),
      flags: this.terrain.flags.map((flag: Flag): [number, number, number] => [flag.id, flag.c, flag.r]),
      registry,
      restrictions,
    };
  }

  /**
   * A playground from a checkpoint, in registry mode: the caller calls `resumeAfter(gap)` to run it. Visible
   * characters come back walking. Throws when the checkpoint is malformed.
   */
  static restore(
    raw: string,
    options: Omit<SimOptions, "cellsW" | "cellsH" | "timeoutSeconds" | "visibleMax">,
  ): PlaygroundSim {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error: unknown) {
      throw new Error("playground checkpoint is not JSON", { cause: error });
    }
    const result = checkpointSchema.safeParse(value);
    if (!result.success) throw new Error(`playground checkpoint invalid: ${issueText(result.error)}`);
    const data: Checkpoint = result.data;
    const sim = new PlaygroundSim({
      ...options,
      cellsW: data.cellsW,
      cellsH: data.cellsH,
      timeoutSeconds: data.timeoutSeconds,
      visibleMax: data.visibleMax,
    });
    restoreTerrain(sim.world, sim.terrain, data);
    Object.assign(sim, {
      clock: data.clock,
      rotation: data.rotation,
      paused: data.paused,
      testEndsAt: data.testEndsAt,
    });
    sim.nextId = data.nextId;
    for (const record of data.registry) {
      const p: Participant = fromRecord(record, sim.clock, sim.walkSpread);
      if (sim.participants.has(p.key) || p.id >= sim.nextId)
        throw new Error(`playground checkpoint duplicate: ${p.id}`);
      sim.participants.set(p.key, p);
    }
    if (sim.visible().length > VISIBLE_MAX) throw new Error("playground checkpoint has too many visible characters");
    for (const [key, until] of data.restrictions) sim.restrictions.set(key, until);
    for (const p of sim.participants.values()) sim.settle(p);
    return sim;
  }
}

/** Puts the checkpoint's ground stages, repairs, blocks and flags into a new terrain. Throws when they do not fit it. */
function restoreTerrain(world: World, terrain: Terrain, data: Checkpoint): void {
  const tiles = terrain.tiles;
  const kinds: boolean =
    data.ground.length === tiles.length &&
    tiles.every((tile, i: number): boolean => (tile.kind === "g") === (data.ground[i] === "g"));
  if (!kinds) throw new Error("playground checkpoint ground does not match its world");
  for (const [i, tile] of tiles.entries()) if (tile.kind === "d") tile.stage = Number(data.ground[i]);
  for (const [index, repairAt] of data.repairs) {
    if (index >= tiles.length) throw new Error(`playground checkpoint repair outside the ground: ${index}`);
    tiles[index].repairAt = repairAt;
  }
  restoreBlocks(world, terrain, data.blocks);
  terrain.flags = data.flags
    .filter(([, c, r]): boolean => c < world.cols && r <= world.rows)
    .map(([id, c, r]): Flag => ({ id, c, r }));
}

/** id, platform, user id, name, score, scoreAt, lastScored, lastChat, lastCommand, admitted, admittedAt, x, removed. */
type ParticipantRecord = [
  number,
  ActivityPlatform,
  string,
  string,
  number,
  number,
  number,
  number,
  number,
  0 | 1,
  number,
  number,
  0 | 1,
];

interface Checkpoint {
  v: typeof PLAYGROUND_VERSION;
  clock: number;
  nextId: number;
  rotation: number;
  paused: boolean;
  testEndsAt: number | null;
  timeoutSeconds: number;
  visibleMax: number;
  cellsW: number;
  cellsH: number;
  ground: string;
  repairs: [number, number][];
  blocks: string;
  flags: [number, number, number][];
  registry: ParticipantRecord[];
  restrictions: [string, number][];
}

function issueText(error: z.ZodError): string {
  const [first] = error.issues;
  return `${first.path.join(".")}: ${first.message} (${error.issues.length} issues)`;
}

function toRecord(p: Participant): ParticipantRecord {
  return [
    p.id,
    p.platform,
    p.userId,
    p.name,
    p.score,
    p.scoreAt,
    p.lastScored,
    p.lastChat,
    p.lastCommand,
    p.admitted ? 1 : 0,
    p.admittedAt,
    Math.round(p.x * 10) / 10,
    p.removed ? 1 : 0,
  ];
}

function fromRecord(record: ParticipantRecord, clock: number, walkSpread: number): Participant {
  const [
    id,
    platform,
    userId,
    name,
    score,
    scoreAt,
    lastScored,
    lastChat,
    lastCommand,
    admitted,
    admittedAt,
    x,
    removed,
  ] = record;
  const speed: number = WALK_SPEED + walkSpread * (mulberry32(id)() - 0.5);
  const p: Participant = newParticipant(siteKey(platform, userId), id, platform, userId, name, clock, speed);
  return Object.assign(p, {
    score,
    scoreAt,
    lastScored,
    lastChat,
    lastCommand,
    admitted: admitted === 1,
    admittedAt,
    x,
    removed: removed === 1,
    state: admitted === 1 ? "walk" : "away",
  });
}

const tick = z.number().int().min(-1e12).max(1e12);
const finite = z.number().finite();
const userId = z.string().min(1).max(128);
const cell = z.number().int().min(0).max(64);

const checkpointSchema: z.ZodType<Checkpoint> = z
  .object({
    v: z.literal(PLAYGROUND_VERSION),
    clock: tick.nonnegative(),
    nextId: z
      .number()
      .int()
      .min(1)
      .max(2 ** 31 - 1),
    rotation: z.number().int().nonnegative(),
    paused: z.boolean(),
    testEndsAt: tick.nullable(),
    timeoutSeconds: z.number().int().min(CHARACTERS_TIMEOUT.min).max(CHARACTERS_TIMEOUT.max),
    // A checkpoint from before this setting has no value: it takes the default.
    visibleMax: z.number().int().min(CHARACTERS_MAX.min).max(CHARACTERS_MAX.max).default(CHARACTERS_MAX.default),
    cellsW: z.number().int(),
    cellsH: z.number().int(),
    ground: z.string().regex(/^[g0-3]*$/),
    repairs: z.array(z.tuple([z.number().int().nonnegative(), tick])).max(FRAME_TILES_MAX),
    blocks: z
      .string()
      .max(FRAME_BLOCKS_MAX)
      .regex(/^[.a-r]*$/),
    flags: z.array(z.tuple([z.number().int().min(1), cell, cell])).max(VISIBLE_MAX),
    registry: z
      .array(
        z.tuple([
          z.number().int().min(1),
          z.enum(CHANNEL_PLATFORMS),
          userId,
          z.string().max(NAME_MAX_UNITS),
          finite.nonnegative(),
          tick,
          tick,
          tick,
          tick,
          z.union([z.literal(0), z.literal(1)]),
          tick,
          finite,
          z.union([z.literal(0), z.literal(1)]),
        ]),
      )
      .max(REGISTRY_MAX),
    restrictions: z.array(z.tuple([z.string().min(1).max(160), tick])).max(RESTRICTED_MAX),
  })
  .strict();
