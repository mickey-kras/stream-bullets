import {
  BODY_HEIGHT,
  BODY_REACH,
  DURATION,
  FALL_VX,
  FLAT_HEIGHT,
  GRAVITY,
  RESPAWN_TICKS,
  STEP_SPEED,
  STEP_UP,
  TILE,
  WALK_BLOCKS_MAX,
} from "./constants";
import { type Participant } from "./crowd";
import { type CharState } from "./protocol";
import { cellX, colOf, fits, floorY, rowOf, solidAt, surface, type Terrain, tops, wallAt, type World } from "./terrain";
import { clamp, setState, type SimHost } from "./core";

/** How the characters move: walks, climbs, flights, falls and throws. */
export class Motion {
  constructor(private readonly sim: SimHost) {}

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

  /** Moves a character in a straight line to (tx, ty) in a time that grows with the height, then to state `after`. */
  tween(p: Participant, state: "climb" | "zip" | "jet", tx: number, ty: number, after: CharState): void {
    const blocks: number = Math.abs(ty - p.y) / TILE;
    const span: number =
      state === "climb" ? DURATION.climb : DURATION.tweenBase + Math.round(blocks * DURATION.tweenPerBlock);
    setState(p, state, { sx: p.x, sy: p.y, tx, ty, span, after, vx: 0, vy: 0 });
  }

  tweenStep(p: Participant): void {
    const share: number = Math.min(1, p.t / p.span);
    p.x = p.sx + (p.tx - p.sx) * share;
    p.y = p.sy + (p.ty - p.sy) * share;
    if (share < 1) return;
    p.rope = null;
    setState(p, p.after, { fromY: p.y });
  }

  /** A wall is in front of a walker: a dirt block or a plank at its body in the next column. */
  walled(p: Participant, nx: number): number | null {
    const c: number = colOf(nx + p.dir * BODY_REACH);
    if (c === this.col(p) || fits(this.world, this.terrain, c, this.row(p))) return null;
    return c;
  }

  walkStep(p: Participant, speed: number, bounded: boolean = !p.free): void {
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
  drop(p: Participant, vx: number): void {
    if (p.job?.kind !== "dig") p.job = null;
    setState(p, "fall", { vy: 0, vx, fromY: p.y });
  }

  /** A character in a block comes out on top of it. */
  unbury(p: Participant): void {
    const c: number = this.col(p);
    let r: number = this.row(p);
    if (!wallAt(this.world, this.terrain, c, r)) return;
    while (wallAt(this.world, this.terrain, c, r)) r += 1;
    p.y = floorY(this.world, r);
  }

  /** A walk of some blocks: over one block alone, off an edge, and to a stop at a higher wall or a door zone. */
  stepWalk(p: Participant): void {
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
      this.sim.giveUp(p);
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
    else this.sim.giveUp(p);
  }

  /** The walk is at its target. When another character stands there, the walk takes one more block, one time. */
  private arrive(p: Participant): void {
    p.x = p.target;
    const shared: boolean = this.sim
      .visible()
      .some(
        (o: Participant): boolean =>
          o !== p && o.state === "hold" && Math.abs(o.x - p.x) < 5 && Math.abs(o.y - p.y) < 4,
      );
    if (shared && !p.extra) {
      Object.assign(p, { extra: true, target: clamp(p.target + p.dir * TILE, TILE / 2, this.world.w - TILE / 2) });
      return;
    }
    this.sim.rest(p);
  }

  /** A dirt block or a plank is at the body of a character with its feet at (x, y). */
  private bodyHits(x: number, y: number): boolean {
    const c: number = colOf(x);
    const from: number = Math.floor((this.world.gy - y + 0.01) / TILE);
    const to: number = Math.floor((this.world.gy - y + BODY_HEIGHT) / TILE);
    for (let r = from; r <= to; r++) if (wallAt(this.world, this.terrain, c, r)) return true;
    return false;
  }

  physics(p: Participant): void {
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
  vanish(p: Participant): void {
    setState(p, "gone", { wait: RESPAWN_TICKS, piloted: false, job: null, rope: null, resume: false });
  }

  /**
   * The place on the ground for a character that comes in: the free column in the walking limits that is farthest
   * from the other characters on the ground.
   */
  spot(me: Participant): number {
    const first: number = this.world.xmin + 12;
    const others: number[] = this.sim
      .visible()
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

  /** A walk of `n` blocks (1 without a number) to the centre of a column. */
  walkTo(p: Participant, dir: 1 | -1, n: number): void {
    const blocks: number = clamp(n || 1, 1, WALK_BLOCKS_MAX);
    const target: number = clamp(cellX(this.col(p) + dir * blocks), TILE / 2, this.world.w - TILE / 2);
    setState(p, "step", { dir, target, extra: false });
  }

  /** A walk to the next column for work that goes on there. It does not take one more block. */
  walkOn(p: Participant, c: number): void {
    setState(p, "step", { target: cellX(c), extra: true });
  }

  /** Throws a character: it flies to `dir` and falls. Its work ends. */
  fling(o: Participant, dir: 1 | -1, vx: number, vy: number): void {
    o.job = null;
    o.rope = null;
    setState(o, "fall", { vx: dir * vx, vy, fromY: o.y, resume: false });
  }
}
