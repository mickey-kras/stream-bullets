import {
  BODY_HEIGHT,
  BODY_REACH,
  BOOM_REACH_SQUARED,
  BOOM_THROW_PX,
  CROWN_BLOCKS,
  DURATION,
  GRAPPLE_REACH,
  JETPACK_BLOCKS,
  REPEAT_MAX,
  THROW_VX,
  THROW_VY,
  TILE,
} from "./constants";
import { type Job, type Participant } from "./crowd";

import {
  type Block,
  blockAt,
  canPlace,
  cellX,
  colOf,
  type Flag,
  fits,
  floorY,
  hit,
  hitBlock,
  placeBlock,
  removeBlock,
  rowOf,
  solidAt,
  type Terrain,
  tileAt,
  wallAt,
  type World,
} from "./terrain";
import { clamp, FIXED_STATES, setState, type SimHost, STANDING_STATES } from "./core";
import type { Motion } from "./motion";

/** The work of the characters on the builds: blocks, stairs, planks, flags, digs, hooks and booms. */
export class Works {
  constructor(
    private readonly sim: SimHost,
    private readonly motion: Motion,
  ) {}

  private get world(): World {
    return this.sim.world;
  }

  private get terrain(): Terrain {
    return this.sim.terrain;
  }

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
    for (const o of this.sim.participants.values()) {
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
  crush(c: number, r: number): boolean {
    let hit = false;
    for (const p of this.sim.participants.values()) {
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
  crownHolder(): void {
    const height = (p: Participant): number => this.world.gy - p.y;
    const high: Participant[] = this.sim
      .visible()
      .filter((p: Participant): boolean => STANDING_STATES.has(p.state) && height(p) >= CROWN_BLOCKS * TILE);
    let holder: Participant | null = high.find((p: Participant): boolean => p.id === this.sim.crown) ?? null;
    for (const p of high) if (!holder || height(p) > height(holder)) holder = p;
    this.sim.crown = holder?.id ?? null;
  }

  /** Starts work of `n` steps (1 without a number, REPEAT_MAX at most). */
  job(p: Participant, kind: Job["kind"], n: number, side: 1 | -1 | 0): void {
    p.job = { kind, left: clamp(n || 1, 1, REPEAT_MAX), side, c: 0, r: 0, done: false };
    this.work(p);
  }

  /** The next step of the work of a character, or its end. */
  work(p: Participant): void {
    const job: Job | null = p.job;
    if (!job) return;
    if (job.left <= 0) {
      p.job = null;
      this.sim.rest(p);
      return;
    }
    if (!this.jobs[job.kind](p, job)) this.sim.giveUp(p, job.done);
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
    this.motion.walkOn(p, c);
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

  grapple(p: Participant): void {
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
  jetpack(p: Participant, n: number): void {
    const c: number = this.col(p);
    let r: number = Math.min(this.world.rows, this.row(p) + clamp(n || JETPACK_BLOCKS, 1, REPEAT_MAX));
    while (!fits(this.world, this.terrain, c, r)) r += 1;
    this.motion.tween(p, "jet", p.x, floorY(this.world, r), "hold");
  }

  push(p: Participant): void {
    const victim: Participant | undefined = this.sim.visible().find((o: Participant): boolean => {
      const ahead: number = (o.x - p.x) * p.dir;
      return (
        o !== p && STANDING_STATES.has(o.state) && ahead > 0 && ahead <= TILE + BODY_REACH && Math.abs(o.y - p.y) < 8
      );
    });
    if (!victim) {
      this.sim.giveUp(p);
      return;
    }
    setState(p, "push", { victim: victim.id });
  }

  /** A boom breaks the builds around the character and throws the characters nearby. */
  blast(p: Participant): void {
    const c0: number = this.col(p);
    const r0: number = this.row(p);
    for (let c = c0 - 3; c <= c0 + 3; c++) {
      for (let r = r0 - 3; r <= r0 + 3; r++) {
        if ((c - c0) ** 2 + (r - r0 - 0.5) ** 2 <= BOOM_REACH_SQUARED) removeBlock(this.world, this.terrain, c, r);
      }
    }
    for (const o of this.sim.visible()) {
      const near: boolean = Math.abs(o.x - p.x) <= BOOM_THROW_PX && Math.abs(o.y - p.y) <= BOOM_THROW_PX;
      if (o === p || !near || FIXED_STATES.has(o.state)) continue;
      const away: 1 | -1 = o.x === p.x ? p.dir : o.x > p.x ? 1 : -1;
      this.motion.fling(o, away, THROW_VX, THROW_VY);
    }
  }

  /** One hit of a dig: on the block of the work, or on the ground in front of the feet. False when nothing breaks. */
  private digHit(p: Participant): boolean {
    const job: Job | null = p.job;
    if (job && job.r >= 0) return hitBlock(this.world, this.terrain, job.c, job.r);
    const tile = tileAt(this.terrain, p.x + p.dir * 4) ?? tileAt(this.terrain, p.x);
    return tile !== undefined && hit(this.terrain, tile, this.sim.clock);
  }

  dig(p: Participant): void {
    if (p.t % DURATION.digEvery === DURATION.digAt && !this.digHit(p)) {
      this.sim.giveUp(p, p.job?.done ?? false);
      return;
    }
    if (p.t < DURATION.dig) return;
    const job: Job | null = p.job;
    if (!job) {
      this.sim.rest(p);
      return;
    }
    job.left -= 1;
    job.done = true;
    // A dig to the side goes on in the gap, when the gap has a floor and room to stand.
    const r: number = this.row(p);
    const floor: boolean =
      r === 0 ? solidAt(this.terrain, cellX(job.c)) : !!blockAt(this.world, this.terrain, job.c, r - 1);
    if (job.side !== 0 && job.left > 0 && floor && fits(this.world, this.terrain, job.c, r))
      this.motion.walkOn(p, job.c);
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

  build(p: Participant): void {
    const job: Job | null = p.job;
    if (p.t === DURATION.buildAt && job && !this.place(p, job)) {
      this.sim.giveUp(p, job.done);
      return;
    }
    if (p.t < DURATION.buildEnd) return;
    if (job?.kind === "up") this.motion.tween(p, "climb", p.x, floorY(this.world, job.r + 1), "hold");
    else if (job?.kind === "stairs" || job?.kind === "bridge") this.motion.walkOn(p, job.c);
    else setState(p, job ? "hold" : p.piloted ? "hold" : "walk");
  }
}
