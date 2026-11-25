import type { ActivityChat, ActivityEvent, ActivityPlatform } from "../activity";

import { CHARACTERS_MAX, CHARACTERS_TIMEOUT } from "../overlay-layers";
import {
  BUBBLE_LENGTH,
  BUBBLE_MAX,
  BLOCK_FALL_TICKS,
  BUBBLE_TICKS,
  CHARACTERS_TEST_TICKS,
  CHECKPOINT_MAX_LENGTH,
  COMMAND_BUBBLE_TICKS,
  COMMAND_COOLDOWN_TICKS,
  COMMAND_EXPIRY_TICKS,
  DURATION,
  GOTO_SPEED_MAX,
  IDLE_CHANCE,
  JUMP_VX,
  JUMP_VY,
  MARK_TICKS,
  MIN_STAY_TICKS,
  NEW_TICKS,
  PUSH_VX,
  PUSH_VY,
  REGISTRY_IDLE_TICKS,
  REGISTRY_MAX,
  RESTRICTED_MAX,
  ROTATION_TICKS,
  STEP_UP,
  SWEEP_TICKS,
  TEST_USER_PREFIX,
  TICK_HZ,
  TURN_CHANCE,
  VISIBLE_MAX,
  WALK_SPEED,
  WALK_SPEED_SPREAD,
} from "./constants";
import {
  addScore,
  type Command,
  type CommandCall,
  chooseCrowd,
  crowdSlots,
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
  FRAME_T_WRAP,
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
  blocksString,
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
  solidAt,
  surface,
  type Terrain,
  terrainView,
  type World,
} from "./terrain";
import {
  checkpointSchema,
  type Checkpoint,
  fromRecord,
  issueText,
  type ParticipantRecord,
  restoreTerrain,
  toRecord,
} from "./checkpoint";
import {
  clamp,
  EMOTES,
  FIXED_STATES,
  HALTED_STATES,
  mulberry32,
  parseCommand,
  setState,
  type SimHost,
  siteKey,
} from "./core";
import { Motion } from "./motion";
import { Works } from "./works";

export { mulberry32, parseCommand, setState } from "./core";

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

export class PlaygroundSim implements SimHost {
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
  /** The moves of the characters, and the work on the builds. */
  private readonly motion = new Motion(this);
  private readonly works = new Works(this, this.motion);

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
      dropLoose(this.world, this.terrain, (c: number, r: number): boolean => this.works.crush(c, r));
    }
    for (const p of this.participants.values()) this.step(p);
    this.works.crownHolder();
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

  /** After an action: a steered character stands still, and another character walks on. */
  rest(p: Participant, extra: Partial<Participant> = {}): void {
    setState(p, p.piloted ? "hold" : "walk", { vx: 0, vy: 0, resume: false, ...extra });
  }

  /** After a landing: a walk of some blocks that went off an edge goes on. */
  private landed(p: Participant): void {
    if (p.resume) setState(p, "step", { vx: 0, vy: 0, resume: false });
    else this.rest(p);
  }

  /** The command cannot run, or cannot go on: the work ends. A red cross shows unless a step was done. */
  giveUp(p: Participant, quiet: boolean = false): void {
    if (!quiet) p.mark = MARK_TICKS;
    p.job = null;
    p.rope = null;
    this.rest(p);
  }

  /**
   * A stop: the queued command and the work go, and a walk, a dig or a build ends where the character is. A character
   * that walks in or out keeps its walk: it stands still only inside the walking limits.
   */
  private halt(p: Participant): void {
    Object.assign(p, { pending: null, job: null, resume: false });
    if (!p.admitted || p.state === "away" || p.free) return;
    p.piloted = true;
    if (HALTED_STATES.has(p.state)) setState(p, "hold");
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
    left: (p: Participant, n: number): void => this.motion.walkTo(p, -1, n),
    right: (p: Participant, n: number): void => this.motion.walkTo(p, 1, n),
    look: (p: Participant, _n: number, side: 1 | -1 | 0): void => {
      if (side === p.dir) this.rest(p);
      else setState(p, "turn");
    },
    stop: (p: Participant): void => this.rest(p),
    jump: (p: Participant): void => setState(p, "jump"),
    block: (p: Participant): void => this.works.job(p, "block", 1, 0),
    up: (p: Participant): void => this.works.job(p, "up", 1, 0),
    stairs: (p: Participant, n: number): void => this.works.job(p, "stairs", n, 0),
    bridge: (p: Participant, n: number): void => this.works.job(p, "bridge", n, 0),
    dig: (p: Participant, n: number, side: 1 | -1 | 0): void => this.works.job(p, "dig", n, side),
    flag: (p: Participant): void => this.works.job(p, "flag", 1, 0),
    grapple: (p: Participant): void => this.works.grapple(p),
    jetpack: (p: Participant, n: number): void => this.works.jetpack(p, n),
    boom: (p: Participant): void => setState(p, "boom"),
    dance: (p: Participant): void => setState(p, "dance"),
    wave: (p: Participant): void => setState(p, "wave"),
    cheer: (p: Participant): void => setState(p, "cheer"),
    push: (p: Participant): void => this.works.push(p),
  };

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
      else setState(p, "goto", { target: this.motion.spot(p), after: "walk", free: true });
    },
    respawn: (p: Participant): void => {
      if (p.t >= DURATION.respawn) setState(p, "walk", { y: this.world.gy });
    },
    walk: (p: Participant): void => {
      this.motion.unbury(p);
      if (!p.free && this.motion.walled(p, p.x + p.dir * p.speed) !== null) {
        setState(p, "turn");
        return;
      }
      this.motion.walkStep(p, p.speed);
      if (p.free && p.x > this.world.xmin + 4) p.free = false;
      if (p.state !== "walk" || p.free) return;
      if (this.rng() < TURN_CHANCE) setState(p, "turn");
      else if (this.rng() < IDLE_CHANCE) setState(p, "idle");
    },
    idle: (p: Participant): void => {
      this.motion.unbury(p);
      if (p.t >= DURATION.idle) setState(p, "walk");
    },
    hold: (p: Participant): void => {
      this.motion.unbury(p);
      const top: number = surface(this.world, this.terrain, p.x, p.y, STEP_UP);
      if (top === Infinity || top > p.y + 0.5) {
        this.motion.drop(p, 0);
        return;
      }
      p.y = top;
      if (p.job) this.works.work(p);
    },
    step: (p: Participant): void => this.motion.stepWalk(p),
    turn: (p: Participant): void => {
      if (p.t >= DURATION.turn) this.rest(p, { dir: p.dir === 1 ? -1 : 1 });
    },
    goto: (p: Participant): void => {
      p.dir = p.target > p.x ? 1 : -1;
      this.motion.walkStep(p, Math.min(GOTO_SPEED_MAX, Math.abs(p.target - p.x)));
      if (p.state === "goto" && Math.abs(p.x - p.target) < 0.7) setState(p, p.after, { x: p.target });
    },
    jump: (p: Participant): void => {
      if (p.t < DURATION.jumpCrouch) return;
      if (p.t === DURATION.jumpCrouch) Object.assign(p, { vy: JUMP_VY, vx: p.dir * JUMP_VX, fromY: p.y });
      this.motion.physics(p);
    },
    fall: (p: Participant): void => this.motion.physics(p),
    land: (p: Participant): void => {
      if (p.t > DURATION.land) this.landed(p);
    },
    flat: (p: Participant): void => {
      if (p.t > DURATION.flat) this.landed(p);
    },
    dig: (p: Participant): void => this.works.dig(p),
    build: (p: Participant): void => this.works.build(p),
    climb: (p: Participant): void => this.motion.tweenStep(p),
    zip: (p: Participant): void => this.motion.tweenStep(p),
    jet: (p: Participant): void => this.motion.tweenStep(p),
    shoot: (p: Participant): void => {
      if (p.rope?.hit && p.t >= DURATION.shootHit) this.motion.tween(p, "zip", p.tx, p.ty, "hold");
      else if (!p.rope?.hit && p.t >= DURATION.shootMiss) this.giveUp(p);
    },
    wave: this.timed(DURATION.wave),
    dance: this.timed(DURATION.dance),
    cheer: this.timed(DURATION.cheer),
    push: (p: Participant): void => {
      if (p.t < DURATION.push) return;
      const victim: Participant | undefined = this.visible().find((o: Participant): boolean => o.id === p.victim);
      if (victim && !FIXED_STATES.has(victim.state)) this.motion.fling(victim, p.dir, PUSH_VX, PUSH_VY);
      this.rest(p);
    },
    boom: (p: Participant): void => {
      if (p.t === DURATION.boomAt) this.works.blast(p);
      if (p.t >= DURATION.boom) this.motion.vanish(p);
    },
    exit: (p: Participant): void => {
      if (p.t >= DURATION.exit) this.release(p);
    },
  };

  visible(): Participant[] {
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
