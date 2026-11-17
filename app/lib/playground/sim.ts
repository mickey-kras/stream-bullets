import { z } from "zod";
import { CHANNEL_PLATFORMS } from "../../../db/enums";
import type { ActivityChat, ActivityEvent, ActivityPlatform } from "../activity";
import { isChatCommand } from "../chat-feed";
import { CHARACTERS_TIMEOUT } from "../overlay-layers";
import {
  BUBBLE_LENGTH,
  BUBBLE_MAX,
  BUBBLE_TICKS,
  BUILD_STEPS,
  CHARACTERS_TEST_TICKS,
  CHECKPOINT_MAX_LENGTH,
  COMMAND_BUBBLE_TICKS,
  COMMAND_COOLDOWN_TICKS,
  COMMAND_EXPIRY_TICKS,
  DURATION,
  FALL_VX,
  FLAT_HEIGHT,
  GOTO_SPEED_MAX,
  GRAVITY,
  IDLE_CHANCE,
  JUMP_VX,
  JUMP_VY,
  MARK_TICKS,
  MIN_STAY_TICKS,
  NEW_TICKS,
  REGISTRY_IDLE_TICKS,
  REGISTRY_MAX,
  RESPAWN_TICKS,
  RESTRICTED_MAX,
  ROTATING_SLOTS,
  ROTATION_TICKS,
  STAIR_SPEED,
  STAIRS_MAX,
  STEP_UP,
  SWEEP_TICKS,
  TEST_USER_PREFIX,
  TICK_HZ,
  TURN_CHANCE,
  VISIBLE_MAX,
  WALK_SPEED,
  WALK_SPEED_SPREAD,
} from "./constants";
import { addScore, COMMANDS, type Command, chooseCrowd, newParticipant, type Participant } from "./crowd";
import {
  BUBBLE_MAX_UNITS,
  type BubbleView,
  boundText,
  CHAR_STATES,
  type CharState,
  type CharTuple,
  FLAG_NEW,
  FLAG_UNAVAILABLE,
  FRAME_T_WRAP,
  FRAME_TILES_MAX,
  type ModeView,
  CUT_MARK,
  NAME_GRAPHEMES,
  NAME_MAX_UNITS,
  PLAYGROUND_VERSION,
  type PlaygroundFullFrame,
  type PlaygroundTickFrame,
  type RosterEntry,
  type TerrainView,
} from "./protocol";
import {
  addStair,
  buildDirection,
  buildFits,
  createTerrain,
  createWorld,
  expire,
  groundString,
  hit,
  solidAt,
  surface,
  type Terrain,
  terrainView,
  tileAt,
  tops,
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

/** The command of a chat text (`!jump`, `！dig now`), or null. */
export function parseCommand(text: string): Command | null {
  if (!isChatCommand(text)) return null;
  const word: string = text
    .replace(/^[\s\p{Cf}]*[!！]/u, "")
    .split(/\s/u)[0]
    .toLowerCase();
  return COMMANDS.find((command: Command): boolean => command === word) ?? null;
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
  /** Participants by `platform:userId`, in registration order. */
  readonly participants = new Map<string, Participant>();
  /** Restricted participants by `platform:userId`: the tick at which the restriction ends. */
  readonly restrictions = new Map<string, number>();
  private active = false;
  private nextId = 1;
  private timeoutSeconds: number = CHARACTERS_TIMEOUT.default;
  private readonly rng: () => number;
  private readonly walkSpread: number;
  private readonly sent = { roster: "", bubbles: "", terrain: "", mode: "" };

  constructor(options: SimOptions) {
    this.world = createWorld(options.cellsW, options.cellsH);
    this.terrain = createTerrain(this.world);
    this.rng = options.rng;
    this.walkSpread = options.walkSpread ?? WALK_SPEED_SPREAD;
    if (options.timeoutSeconds !== undefined) this.setTimeoutSeconds(options.timeoutSeconds);
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
    const command: Command | null = parseCommand(event.text);
    if (command) {
      if (this.clock - p.lastCommand < COMMAND_COOLDOWN_TICKS) return;
      p.pending = { name: command, expires: this.clock + COMMAND_EXPIRY_TICKS, key: event.id };
      p.lastCommand = this.clock;
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
    this.rotation += ROTATING_SLOTS * (Math.floor(this.clock / ROTATION_TICKS) - Math.floor(from / ROTATION_TICKS));
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
    if (this.clock % ROTATION_TICKS === 0) this.rotation += ROTATING_SLOTS;
    if (this.clock % SWEEP_TICKS === 0) this.sweep();
    this.select();
    expire(this.terrain, this.clock);
    for (const p of this.participants.values()) this.step(p);
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
    Object.assign(this.sent, { roster: "", bubbles: "", terrain: "", mode: "" });
  }

  /** Chooses the crowd and admits chosen participants while slots are free. */
  select(): void {
    const chosen: Participant[] = chooseCrowd(this.list(), this.clock, this.timeoutTicks, this.rotation);
    let occupied: number = this.list().filter((p: Participant): boolean => p.admitted).length;
    for (const [index, p] of chosen.entries()) {
      if (p.admitted || occupied >= VISIBLE_MAX) continue;
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
    setState(p, "away", { admitted: false, free: false, exitReason: null, mark: 0 });
    this.clearQueue(p);
  }

  private clearQueue(p: Participant): void {
    p.bubble = null;
    p.pending = null;
    p.pendingText = null;
  }

  /** After a gap or a change of world: a visible character stands walking on solid ground. */
  private settle(p: Participant): void {
    this.clearQueue(p);
    if (!p.admitted) return;
    let x: number = Math.min(this.world.xmax, Math.max(this.world.xmin, p.x));
    if (!solidAt(this.terrain, x)) x = this.world.padX;
    setState(p, "walk", { x, y: this.world.gy, vx: 0, vy: 0, free: false, exitReason: null, mark: 0 });
  }

  /** Shows a bubble. With BUBBLE_MAX bubbles already shown by others, the one closest to its end goes. */
  private say(p: Participant, text: string, ticks: number, key: string): void {
    const shown: { owner: Participant; ticks: number }[] = this.list().flatMap((o: Participant) =>
      o !== p && o.bubble ? [{ owner: o, ticks: o.bubble.ticks }] : [],
    );
    if (shown.length >= BUBBLE_MAX) shown.reduce((a, b) => (b.ticks < a.ticks ? b : a), shown[0]).owner.bubble = null;
    p.bubble = { text, ticks, key, at: this.clock };
  }

  /** Starts a command action. The caller makes sure the character is walking inside the walking limits. */
  perform(p: Participant, command: Command, key = ""): void {
    if (command === "build") {
      const x: number = Math.round(p.x);
      setState(p, "build", { steps: 0, bx: x, by: p.y, x, dir: buildDirection(this.world, p.x, p.dir) });
    } else {
      setState(p, command);
    }
    this.say(p, `!${command}`, COMMAND_BUBBLE_TICKS, key);
  }

  private walkStep(p: Participant, speed: number): void {
    const nx: number = p.x + p.dir * speed;
    if (!p.free && ((nx < this.world.xmin && p.dir < 0) || (nx > this.world.xmax && p.dir > 0))) {
      setState(p, "turn");
      return;
    }
    const top: number = surface(this.world, this.terrain, nx, p.y, STEP_UP);
    p.x = nx;
    if (top === Infinity || top > p.y + 0.5) setState(p, "fall", { vy: 0, vx: p.dir * FALL_VX, fromY: p.y });
    else p.y = top;
  }

  private physics(p: Participant): void {
    p.vy += GRAVITY;
    const ny: number = p.y + p.vy;
    let nx: number = p.x + p.vx;
    if (nx < this.world.bounceMin || nx > this.world.bounceMax) {
      p.vx = 0;
      nx = p.x;
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
    if (p.y > this.world.fallY) setState(p, "gone", { wait: RESPAWN_TICKS });
  }

  private step(p: Participant): void {
    if (p.bubble && --p.bubble.ticks <= 0) p.bubble = null;
    if (p.mark > 0) p.mark -= 1;
    if (p.pending && p.pending.expires < this.clock) p.pending = null;
    if (p.pendingText && p.pendingText.expires < this.clock) p.pendingText = null;
    if (p.state === "away") return;
    p.t += 1;
    if (p.state === "walk") this.walkTurn(p);
    this.actions[p.state](p);
  }

  /** A walking character leaves when its time is up, or else shows its queued text and starts its queued command. */
  private walkTurn(p: Participant): void {
    const timedOut: boolean = this.clock - p.lastChat >= this.timeoutTicks;
    if ((!p.eligible || timedOut) && this.clock - p.admittedAt >= MIN_STAY_TICKS) {
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
      this.perform(p, pending.name, pending.key);
    }
  }

  /** What a character in each state does in a tick. */
  private readonly actions: Record<CharState, (p: Participant) => void> = {
    gone: (p: Participant): void => {
      if (--p.wait > 0) return;
      if (p.eligible) setState(p, "respawn", { x: this.world.padX, y: this.world.gy - 6, dir: 1 });
      else this.release(p);
    },
    enter: (p: Participant): void => {
      if (p.t >= DURATION.enter) setState(p, "walk", { free: true });
    },
    respawn: (p: Participant): void => {
      if (p.t >= DURATION.respawn) setState(p, "walk", { y: this.world.gy });
    },
    walk: (p: Participant): void => {
      this.walkStep(p, p.speed);
      if (p.free && p.x > this.world.xmin + 4) p.free = false;
      if (p.state !== "walk" || p.free) return;
      if (this.rng() < TURN_CHANCE) setState(p, "turn");
      else if (this.rng() < IDLE_CHANCE) setState(p, "idle");
    },
    idle: (p: Participant): void => {
      if (p.t >= DURATION.idle) setState(p, "walk");
    },
    turn: (p: Participant): void => {
      if (p.t >= DURATION.turn) setState(p, "walk", { dir: p.dir === 1 ? -1 : 1 });
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
      if (p.t > DURATION.land) setState(p, "walk");
    },
    flat: (p: Participant): void => {
      if (p.t > DURATION.flat) setState(p, "walk");
    },
    dig: (p: Participant): void => this.dig(p),
    build: (p: Participant): void => this.build(p),
    bwalk: (p: Participant): void => {
      this.walkStep(p, STAIR_SPEED);
      if (p.state === "bwalk" && Math.abs(p.x - p.target) < 0.5) setState(p, p.steps < BUILD_STEPS ? "build" : "walk");
    },
    wave: (p: Participant): void => {
      if (p.t >= DURATION.wave) setState(p, "walk");
    },
    boom: (p: Participant): void => {
      if (p.t >= DURATION.boom) setState(p, "gone", { wait: RESPAWN_TICKS });
    },
    exit: (p: Participant): void => {
      if (p.t >= DURATION.exit) this.release(p);
    },
  };

  private dig(p: Participant): void {
    if (p.t % DURATION.digEvery === DURATION.digAt) {
      const tile = tileAt(this.terrain, p.x + p.dir * 4) ?? tileAt(this.terrain, p.x);
      if (!tile || !hit(tile, this.clock)) {
        p.mark = MARK_TICKS;
        setState(p, "walk");
        return;
      }
    }
    if (p.t >= DURATION.dig) setState(p, "walk");
  }

  private build(p: Participant): void {
    if (p.t === DURATION.buildAt) {
      const i: number = p.steps;
      const x: number = p.dir > 0 ? p.bx + 5 + 7 * i : p.bx - 12 - 7 * i;
      if (!buildFits(this.world, x)) {
        if (i === 0) p.mark = MARK_TICKS;
        setState(p, "walk");
        return;
      }
      addStair(this.terrain, x, p.by - 4 * (i + 1), p.dir, this.clock);
      p.steps += 1;
      p.target = x + 3;
    }
    if (p.t >= DURATION.buildEnd) setState(p, "bwalk");
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

  private sections(): { roster: RosterEntry[]; bubbles: BubbleView[]; terrain: TerrainView; mode: ModeView } {
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
    for (const name of ["roster", "bubbles", "terrain", "mode"] as const) {
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
      cellsW: this.world.cellsW,
      cellsH: this.world.cellsH,
      ground: groundString(this.terrain),
      repairs,
      stairs: this.terrain.stairs.map((s): [number, number, 1 | -1, number] => [s.x, s.top, s.dir, s.until]),
      registry,
      restrictions,
    };
  }

  /**
   * A playground from a checkpoint, in registry mode: the caller calls `resumeAfter(gap)` to run it. Visible
   * characters come back walking. Throws when the checkpoint is malformed.
   */
  static restore(raw: string, options: Omit<SimOptions, "cellsW" | "cellsH" | "timeoutSeconds">): PlaygroundSim {
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
    });
    restoreTerrain(sim.terrain, data);
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

/** Puts the checkpoint's ground stages, repairs and stairs into a new terrain. Throws when they do not fit it. */
function restoreTerrain(terrain: Terrain, data: Checkpoint): void {
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
  terrain.stairs = data.stairs.map(([x, top, dir, until]) => ({ x, top, dir, until }));
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
  cellsW: number;
  cellsH: number;
  ground: string;
  repairs: [number, number][];
  stairs: [number, number, 1 | -1, number][];
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
    cellsW: z.number().int(),
    cellsH: z.number().int(),
    ground: z.string().regex(/^[g0-3]*$/),
    repairs: z.array(z.tuple([z.number().int().nonnegative(), tick])).max(FRAME_TILES_MAX),
    stairs: z.array(z.tuple([finite, finite, z.union([z.literal(1), z.literal(-1)]), tick])).max(STAIRS_MAX),
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
