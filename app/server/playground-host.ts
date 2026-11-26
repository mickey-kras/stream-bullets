import { z } from "zod";
import type { ActivityEvent } from "../lib/activity";
import { parseStoredLayers } from "../lib/overlay-legacy";
import { type CellRect, DEFAULT_LAYERS, type OverlayLayers, playgroundCell } from "../lib/overlay-layers";
import { TICK_HZ } from "../lib/playground/constants";
import {
  encodeFrame,
  type PlaygroundControl,
  playgroundControlSchema,
  type PlaygroundStatus,
} from "../lib/playground/protocol";
import { mulberry32, PlaygroundSim } from "../lib/playground/sim";
import { type TestCrowdEvent, testCrowdScript } from "../lib/playground/test-crowd";

/**
 * The character playground of one page (issue #664, docs/characters.md), inside the page's ChannelIngest object.
 * The simulation runs only while a socket that asked for characters is open, the characters layer is on and the
 * playground is not paused. Otherwise it is in registry mode: chat changes only scores and activity, moderation
 * applies, and commands are dropped. The state survives an eviction through one storage checkpoint. Commands are
 * never kept, so a restored playground never replays them. With the characters layer off the playground keeps
 * nothing. A participant is forgotten 30 minutes after its last message and a restriction when it ends; the alarm
 * forgets them on time, and deletes the checkpoint once nothing is left. A stopped playground that keeps a state reads
 * the saved layers again at each alarm, at least every LAYER_CHECK_MS, so a missed layer change still deletes it.
 */

/** The storage key of the checkpoint. */
export const PLAYGROUND_KEY = "playground";
/** The frame interval. Each frame runs the rules ticks that are due, at most MAX_STEP_TICKS. */
export const FRAME_MS = 100;
export const MAX_STEP_TICKS = 10;
/** A checkpoint at most this often while the state changes, and when the playground stops. */
export const CHECKPOINT_MS = 5_000;
/** While it runs, an alarm this far ahead restarts the playground after an eviction. */
export const WATCHDOG_MS = 15_000;
/** While it stands with a state, an alarm at least this often reads the saved layers again. */
export const LAYER_CHECK_MS = 60_000;

/** The answer to a control while the playground keeps nothing: the characters layer is off or nobody spoke yet. */
const IDLE_STATUS: PlaygroundStatus = { paused: false, testEndsAt: null };

export interface PlaygroundClock {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

interface PlaygroundHostOptions {
  storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
  /** The sockets that asked for characters. Closed sockets are filtered out here. */
  sockets: () => WebSocket[];
  /** The saved layers of the page (one D1 read). */
  readLayers: () => Promise<OverlayLayers>;
  /** Sets the object's alarm to `at`, unless it already runs earlier. */
  schedule: (at: number) => Promise<void>;
  clock?: PlaygroundClock;
  /** A 32-bit seed for each new simulation and characters test. */
  seed?: () => number;
}

interface TestRun {
  seed: number;
  startMs: number;
}

interface Stored {
  v: 1;
  sim: string;
  enabled: boolean;
  /** The server time of the simulation clock. */
  at: number;
  test: TestRun | null;
}

const storedSchema: z.ZodType<Stored> = z
  .object({
    v: z.literal(1),
    sim: z.string(),
    enabled: z.boolean(),
    at: z.number().int().nonnegative(),
    test: z
      .object({ seed: z.number().int().nonnegative(), startMs: z.number().int().nonnegative() })
      .strict()
      .nullable(),
  })
  .strict();

const systemClock: PlaygroundClock = {
  now: (): number => Date.now(),
  setInterval: (callback: () => void, ms: number): unknown => setInterval(callback, ms),
  clearInterval: (handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>),
};

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/** Only the error class: messages can carry chat text. */
function cause(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** The saved layers of a page, or the defaults when the page has no overlay row. */
async function readLayers(db: D1Database, streamerId: string | undefined): Promise<OverlayLayers> {
  if (streamerId === undefined) return DEFAULT_LAYERS;
  const row = await db
    .prepare("SELECT layers FROM overlay_state WHERE streamer_id=?")
    .bind(streamerId)
    .first<{ layers: string }>();
  return row ? parseStoredLayers(row.layers) : DEFAULT_LAYERS;
}

function refusal(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

/** The playground of a ChannelIngest object: its storage, its sockets tagged `characters` and its page's layers. */
export function playgroundOf(
  ctx: DurableObjectState,
  env: { DB: D1Database },
  streamerId: () => string | undefined,
  schedule: (at: number) => Promise<void>,
): PlaygroundHost {
  return new PlaygroundHost({
    storage: ctx.storage,
    sockets: (): WebSocket[] =>
      ctx.getWebSockets("characters").filter((socket: WebSocket): boolean => socket.readyState === WebSocket.OPEN),
    readLayers: (): Promise<OverlayLayers> => readLayers(env.DB, streamerId()),
    schedule,
  });
}

export class PlaygroundHost {
  private sim: PlaygroundSim | null = null;
  private enabled = false;
  /** The server time of `sim.clock`. */
  private syncedAt = 0;
  private savedAt = 0;
  private dirty = false;
  /** A checkpoint delete failed: the alarm tries again. */
  private leftover = false;
  private ticker: unknown = null;
  private test: (TestRun & { events: TestCrowdEvent[]; next: number }) | null = null;
  /** Sockets that got a full frame of the current simulation. After an eviction each socket gets a new one. */
  private primed = new WeakSet<WebSocket>();
  private refreshing: Promise<boolean> | null = null;
  /** The saved layers changed while a read ran: that read is followed by one more. */
  private stale = false;
  private readonly clock: PlaygroundClock;
  private readonly seed: () => number;

  constructor(private readonly options: PlaygroundHostOptions) {
    this.clock = options.clock ?? systemClock;
    this.seed = options.seed ?? randomSeed;
  }

  get ticking(): boolean {
    return this.ticker !== null;
  }

  /** Restores the checkpoint after a wake. A malformed checkpoint is deleted: the playground starts fresh. */
  async load(): Promise<void> {
    const raw: unknown = await this.options.storage.get(PLAYGROUND_KEY);
    if (raw === undefined) return;
    try {
      const stored: Stored = storedSchema.parse(raw);
      this.sim = PlaygroundSim.restore(stored.sim, { rng: mulberry32(this.seed()) });
      this.enabled = stored.enabled;
      this.syncedAt = stored.at;
      this.savedAt = this.clock.now();
      if (stored.test && this.sim.testEndsAt !== null) this.startScript(stored.test, false);
    } catch {
      // The reason can quote stored names, so only the event is logged.
      console.warn("playground_checkpoint_invalid");
      await this.forget();
      return;
    }
    // A kept state always has an alarm, so the layers check and the expiries run also without traffic.
    if (this.enabled) await this.wake();
    // A playground saved with the characters layer off keeps nothing: nothing shows it.
    else await this.forget();
  }

  /**
   * One admitted activity event. Status events change nothing; with the characters layer off nothing is kept. While
   * the playground stands, the sockets get a full frame after moderation, so a removed character or bubble goes at once.
   */
  receive(event: ActivityEvent): void {
    const sim = this.sim;
    if (!sim || !this.enabled || event.kind === "status") return;
    this.ensure();
    if (!this.ticking) this.skipTo(this.clock.now());
    sim.receive(event);
    this.dirty = true;
    if (!this.ticking && event.kind !== "chat") this.publish(sim, this.options.sockets());
  }

  /**
   * A socket that asked for characters was accepted. It gets a full frame after the activity snapshot. When the last
   * characters socket closes, the next frame stops the playground and saves it.
   */
  async open(socket: WebSocket): Promise<void> {
    if (!this.ticking) await this.refresh();
    this.ensure();
    if (this.sim && !this.primed.has(socket)) this.publish(this.sim, [socket]);
    await this.wake();
  }

  /** The object's `/playground` (an owner control) and `/playground-config` (the saved layers changed) requests. */
  async request(path: string, request: Request): Promise<Response> {
    let response: Response;
    if (path === "/playground-config") {
      await this.config();
      response = new Response(null, { status: 204 });
    } else {
      const parsed = playgroundControlSchema.safeParse(await request.json().catch((): null => null));
      if (!parsed.success) return refusal("Invalid control", 400);
      const status: PlaygroundStatus | null = await this.control(parsed.data);
      response = status ? Response.json(status) : refusal("Character not found", 404);
    }
    await this.wake();
    return response;
  }

  /** The saved layers changed. The playground reads them while a characters socket is open or it keeps a state. */
  private async config(): Promise<void> {
    if (this.options.sockets().length === 0 && !this.sim) return;
    await this.refresh(true);
    this.settle();
  }

  /**
   * An owner control. Null when `remove` finds no such character. `status` never creates a playground. Starting a
   * test also ends a pause, so the test shows at once.
   */
  private async control(control: PlaygroundControl): Promise<PlaygroundStatus | null> {
    if (control.op === "status" && !this.sim) return IDLE_STATUS;
    // A test needs the saved layer on, so it reads the layers again, after a read that already runs; the other
    // controls work on what is known.
    const test: boolean = control.op === "test";
    if ((!this.sim || test) && !(await this.refresh(test)) && !this.sim) throw new Error("playground not created");
    const sim = this.sim;
    // The characters layer is off: there is nothing to control.
    if (!sim) return control.op === "remove" ? null : IDLE_STATUS;
    const now = this.clock.now();
    if (!this.ticking) this.skipTo(now);
    if (control.op === "status") return this.status(sim);
    switch (control.op) {
      case "test": {
        sim.stopTest();
        sim.resume();
        sim.startTest();
        this.startScript({ seed: this.seed(), startMs: now }, true);
        break;
      }
      case "stopTest":
        sim.stopTest();
        this.test = null;
        break;
      case "pause":
        sim.pause();
        break;
      case "resume":
        sim.resume();
        break;
      case "reset":
        sim.reset();
        break;
      case "clear":
        sim.clearBuilds();
        break;
      case "remove":
        if (!sim.remove(control.id)) return null;
        break;
    }
    this.dirty = true;
    this.settle();
    await this.save();
    return this.status(sim);
  }

  /**
   * The alarm: restarts a playground that an eviction stopped, saves a pending change, forgets participants and
   * restrictions that expired, and sets the next alarm. A stopped playground reads the saved layers first, so a
   * missed change that turned the characters layer off deletes it here.
   */
  async alarm(): Promise<void> {
    this.ensure();
    // Taken before the layers read: it moves the clock too, so it can forget participants or end the test.
    const before: string = this.kept();
    if (!this.ticking && this.sim) await this.refresh();
    if (!this.ticking) await this.expire(before);
    if (this.dirty && !this.ticking) await this.save();
    await this.wake();
  }

  /**
   * When the playground needs the next alarm, or null: the watchdog while it runs, a pending checkpoint, or the next
   * expiry of a participant or restriction, and at the latest the next layers check.
   */
  wakeAt(): number | null {
    const now: number = this.clock.now();
    if (this.ticking) return now + WATCHDOG_MS;
    if (this.leftover) return now + CHECKPOINT_MS;
    if (this.dirty) return this.savedAt + CHECKPOINT_MS;
    const sim = this.sim;
    if (!sim) return null;
    const check: number = now + LAYER_CHECK_MS;
    const tick: number | null = sim.expiresAt();
    if (tick === null) return check;
    // One millisecond late, so the rules clock has surely reached the tick.
    return Math.min(check, Math.max(now, Math.ceil(this.syncedAt + ((tick - sim.clock) * 1000) / TICK_HZ) + 1));
  }

  /** The page is going away. Its storage is deleted by the caller. */
  wipe(): void {
    this.halt();
    this.sim = null;
    this.test = null;
    this.enabled = false;
    this.dirty = false;
    this.leftover = false;
    this.primed = new WeakSet<WebSocket>();
  }

  /** Sets the alarm that the playground needs, if any. */
  private async wake(): Promise<void> {
    const at: number | null = this.wakeAt();
    if (at !== null) await this.options.schedule(at);
  }

  /**
   * Registry mode: moves the clock, so participants and restrictions that expired are forgotten. A playground that
   * then keeps nobody, with no socket, pause or test, is forgotten with its checkpoint. `before` is `kept()` when the
   * alarm began; a change since then is saved and shown.
   */
  private async expire(before: string): Promise<void> {
    const sim = this.sim;
    if (!sim) {
      if (this.leftover) await this.forget();
      return;
    }
    this.skipTo(this.clock.now());
    if (this.kept() !== before) {
      if (sim.testEndsAt === null) this.test = null;
      this.dirty = true;
      this.settle();
    }
    const idle: boolean = !sim.paused && sim.testEndsAt === null && this.options.sockets().length === 0;
    if (idle && sim.participants.size + sim.restrictions.size === 0) await this.forget();
  }

  /**
   * What an expiry can change: the participants, the restrictions, the test end, and every frame section that the
   * sockets show (roster, bubbles, terrain and mode). Positions are left out, because moving the clock changes them.
   */
  private kept(): string {
    const sim = this.sim;
    if (!sim) return "";
    const { roster, bubbles, terrain, mode } = sim.fullFrame();
    const counts: (number | null)[] = [sim.participants.size, sim.restrictions.size, sim.testEndsAt];
    return JSON.stringify([counts, roster, bubbles, terrain, mode]);
  }

  /** Drops the playground and deletes its checkpoint. A failed delete is logged and tried again by the alarm. */
  private async forget(): Promise<void> {
    this.wipe();
    try {
      await this.options.storage.delete(PLAYGROUND_KEY);
    } catch (error: unknown) {
      this.leftover = true;
      console.error("playground_checkpoint_delete_failed", { cause: cause(error) });
    }
  }

  private status(sim: PlaygroundSim): PlaygroundStatus {
    const testEndsAt: number | null =
      sim.testEndsAt === null ? null : Math.round(this.syncedAt + ((sim.testEndsAt - sim.clock) * 1000) / TICK_HZ);
    return { paused: sim.paused, testEndsAt };
  }

  /**
   * Reads the layers once, also for callers that ask while a read runs. With `changed` (the saved layers changed),
   * a read that already runs is followed by one more. A failed read keeps what is known and gives false.
   */
  private refresh(changed = false): Promise<boolean> {
    if (this.refreshing) {
      this.stale ||= changed;
      return this.refreshing;
    }
    this.refreshing = this.read().finally((): void => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async read(): Promise<boolean> {
    let ok: boolean;
    do {
      this.stale = false;
      try {
        await this.apply(await this.options.readLayers());
        ok = true;
      } catch (error: unknown) {
        console.error("playground_config_failed", { cause: cause(error) });
        ok = false;
      }
    } while (this.stale);
    return ok;
  }

  private async apply(layers: OverlayLayers): Promise<void> {
    // Off stream: the layer is off, or it has no cell in an output. One playground serves the two outputs.
    const cell: CellRect | null = playgroundCell(layers);
    if (!layers.characters.enabled || !cell) {
      if (this.sim || this.leftover) await this.forget();
      return;
    }
    const now = this.clock.now();
    if (this.sim) {
      const sim = this.sim;
      const shape = (): string => `${sim.world.cellsW} ${sim.world.cellsH} ${sim.timeoutTicks} ${sim.visibleMax}`;
      const before: string = shape();
      if (!this.ticking) this.skipTo(now);
      sim.resize(cell.w, cell.h);
      sim.setTimeoutSeconds(layers.characters.timeout);
      sim.setVisibleMax(layers.characters.max);
      // An unchanged layer saves nothing: the alarm reads the layers every LAYER_CHECK_MS.
      this.dirty ||= !this.enabled || shape() !== before;
    } else {
      this.sim = new PlaygroundSim({
        cellsW: cell.w,
        cellsH: cell.h,
        rng: mulberry32(this.seed()),
        timeoutSeconds: layers.characters.timeout,
        visibleMax: layers.characters.max,
      });
      this.syncedAt = now;
      // The open sockets get the new playground's full frame.
      this.primed = new WeakSet<WebSocket>();
      this.dirty = true;
    }
    this.enabled = true;
  }

  /** Runs or stops the playground as the sockets, the layer and the pause ask, then shows the change. */
  private settle(): void {
    this.ensure();
    if (!this.ticking && this.sim) this.publish(this.sim, this.options.sockets());
  }

  /** Starts or stops the frame interval. */
  private ensure(): void {
    const sim = this.sim;
    const run = sim !== null && this.enabled && !sim.paused && this.options.sockets().length > 0;
    if (run === this.ticking) return;
    if (!run || !sim) {
      this.halt();
      // The stopped playground saves and sets the alarm of its next expiry.
      this.save()
        .then((): Promise<void> => this.wake())
        .catch((error: unknown): void => console.error("playground_alarm_failed", { cause: cause(error) }));
      return;
    }
    const now = this.clock.now();
    this.skipTo(now);
    sim.resumeAfter(0);
    // The first tick frame repeats every section: the sockets may hold an older mode or roster.
    sim.resendSections();
    // Test events that fell due while the playground stood never play.
    this.feedTest(now, false);
    this.ticker = this.clock.setInterval((): void => this.step(), FRAME_MS);
  }

  private halt(): void {
    if (this.ticker === null) return;
    this.clock.clearInterval(this.ticker);
    this.ticker = null;
    this.sim?.stop();
  }

  /** Moves the clock of a standing simulation over the time since it last moved. */
  private skipTo(now: number): void {
    const sim = this.sim;
    if (!sim) return;
    const gap: number = this.ticksSince(now);
    this.syncedAt += (gap * 1000) / TICK_HZ;
    if (gap > 0) sim.skip(gap);
  }

  /** Whole rules ticks from `syncedAt` to `now`. */
  private ticksSince(now: number): number {
    return Math.max(0, Math.floor(((now - this.syncedAt) * TICK_HZ) / 1000));
  }

  private step(): void {
    const sim = this.sim;
    if (!sim?.running || this.options.sockets().length === 0) {
      this.ensure();
      return;
    }
    try {
      const now = this.clock.now();
      const due: number = this.ticksSince(now);
      const ticks: number = Math.min(due, MAX_STEP_TICKS);
      // A stall longer than MAX_STEP_TICKS is not made up: the rules clock falls behind by that much.
      this.syncedAt = due > ticks ? now : this.syncedAt + (ticks * 1000) / TICK_HZ;
      this.publish(
        sim,
        this.options.sockets().filter((s: WebSocket): boolean => !this.primed.has(s)),
      );
      this.feedTest(now, true);
      for (let i = 0; i < ticks; i += 1) sim.tick();
      if (sim.testEndsAt === null) this.test = null;
      this.dirty = true;
      const primed = this.options.sockets().filter((s: WebSocket): boolean => this.primed.has(s));
      this.send(encodeFrame(sim.tickFrame()), primed);
      if (now - this.savedAt >= CHECKPOINT_MS) void this.save();
    } catch (error: unknown) {
      console.error("playground_tick_failed", { cause: cause(error) });
      this.enabled = false;
      this.halt();
    }
  }

  /** Sends a full frame to `sockets`, which then get the tick frames. */
  private publish(sim: PlaygroundSim, sockets: WebSocket[]): void {
    if (sockets.length === 0) return;
    let frame: string;
    try {
      frame = encodeFrame(sim.fullFrame());
    } catch (error: unknown) {
      console.error("playground_frame_invalid", { cause: cause(error) });
      return;
    }
    this.send(frame, sockets);
    for (const socket of sockets) this.primed.add(socket);
    // The sockets that already had frames may miss a section that changed: the next tick frame repeats every section.
    sim.resendSections();
  }

  private send(frame: string, sockets: WebSocket[]): void {
    for (const socket of sockets) {
      try {
        socket.send(frame);
      } catch {
        // The socket already closed; the runtime calls webSocketClose.
      }
    }
  }

  private startScript(run: TestRun, live: boolean): void {
    this.test = { ...run, events: testCrowdScript(run.seed, run.startMs), next: 0 };
    if (!live) this.feedTest(this.clock.now(), false);
  }

  /** Plays the test events that are due, or with `play` false only passes over them. */
  private feedTest(now: number, play: boolean): void {
    const test = this.test;
    if (!test || !this.sim) return;
    while (test.next < test.events.length && test.startMs + test.events[test.next].atMs <= now) {
      if (play) this.sim.receive(test.events[test.next].event);
      test.next += 1;
    }
  }

  private async save(): Promise<void> {
    const sim = this.sim;
    if (!sim) return;
    this.dirty = false;
    this.savedAt = this.clock.now();
    try {
      const stored: Stored = {
        v: 1,
        sim: sim.checkpoint(),
        enabled: this.enabled,
        at: Math.round(this.syncedAt),
        test: this.test ? { seed: this.test.seed, startMs: this.test.startMs } : null,
      };
      await this.options.storage.put(PLAYGROUND_KEY, stored);
    } catch (error: unknown) {
      this.dirty = true;
      console.error("playground_checkpoint_failed", { cause: cause(error) });
    }
  }
}
