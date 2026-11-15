import {
  BOUNCE_INSET,
  BUILD_TURN_INSET,
  CELL_LOGICAL,
  CELLS_H_MAX,
  CELLS_H_MIN,
  CELLS_W_MAX,
  CELLS_W_MIN,
  ENTRY_X,
  EXIT_INSET,
  FALL_OUT,
  GROUND_OFFSET,
  MIDDLE_DIRT,
  MIDDLE_GIRDER,
  STAIRS_MAX,
  TERRAIN_LIFETIME_TICKS,
  TILE,
  WALK_INSET,
  ZONE_TILES,
} from "./constants";
import type { StairTuple, TerrainView } from "./protocol";

/**
 * The world geometry and the shared terrain. The world comes from the characters cell: CELL_LOGICAL logical px per
 * cell. The ground is at the bottom; extra height is sky. Both ends are protected girder zones for the doors. The
 * middle repeats breakable dirt and protected girder runs.
 */

export interface World {
  cellsW: number;
  cellsH: number;
  w: number;
  h: number;
  /** Ground y. */
  gy: number;
  xmin: number;
  xmax: number;
  entryX: number;
  exitX: number;
  padX: number;
  /** Below this y a character is gone. */
  fallY: number;
  /** Thrown characters keep inside these x limits. */
  bounceMin: number;
  bounceMax: number;
}

export interface Tile {
  /** "g" protected girder, "d" breakable dirt. */
  kind: "g" | "d";
  /** Damage of dirt: 0 intact to 3 a hole. */
  stage: number;
  /** The tick at which damaged dirt repairs, or 0. */
  repairAt: number;
}

interface Stair {
  x: number;
  top: number;
  dir: 1 | -1;
  /** The step goes after this tick. */
  until: number;
}

export interface Terrain {
  tiles: Tile[];
  stairs: Stair[];
}

/** Step width. */
const STAIR_W = 7;

function cellCount(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`playground ${name} must be an integer from ${min} to ${max}: ${value}`);
  }
  return value;
}

function tileKinds(count: number, w: number): ("g" | "d")[] {
  const zone: number = ZONE_TILES * TILE;
  const period: number = MIDDLE_DIRT + MIDDLE_GIRDER;
  return Array.from({ length: count }, (_, i: number): "g" | "d" => {
    // A tile in an end zone (wholly or partly) is protected.
    if (i * TILE < zone || (i + 1) * TILE > w - zone) return "g";
    return (i - ZONE_TILES) % period < MIDDLE_DIRT ? "d" : "g";
  });
}

/** The world of a characters cell of `cellsW` x `cellsH` grid cells. Throws on a size outside the limits. */
export function createWorld(cellsW: number, cellsH: number): World {
  const w: number = cellCount(cellsW, CELLS_W_MIN, CELLS_W_MAX, "width") * CELL_LOGICAL;
  const h: number = cellCount(cellsH, CELLS_H_MIN, CELLS_H_MAX, "height") * CELL_LOGICAL;
  const zone: number = ZONE_TILES * TILE;
  const xmin: number = zone - WALK_INSET;
  const xmax: number = w - zone + WALK_INSET;
  const kinds = tileKinds(Math.ceil(w / TILE), w);
  // The pad stands on the first protected middle run, else on the last entrance tile.
  let padTile: number = ZONE_TILES - 1;
  const first: number = kinds.findIndex((kind, i: number): boolean => i >= ZONE_TILES && kind === "g");
  if (first >= 0 && (first + 1) * TILE <= w - zone) padTile = first + Math.floor(MIDDLE_GIRDER / 2);
  return {
    cellsW,
    cellsH,
    w,
    h,
    gy: h - GROUND_OFFSET,
    xmin,
    xmax,
    entryX: ENTRY_X,
    exitX: w - EXIT_INSET,
    padX: padTile * TILE + TILE / 2,
    fallY: h + FALL_OUT,
    bounceMin: BOUNCE_INSET,
    bounceMax: w - BOUNCE_INSET,
  };
}

export function createTerrain(world: World): Terrain {
  const kinds = tileKinds(Math.ceil(world.w / TILE), world.w);
  return { tiles: kinds.map((kind): Tile => ({ kind, stage: 0, repairAt: 0 })), stairs: [] };
}

export function tileAt(terrain: Terrain, x: number): Tile | undefined {
  return x < 0 ? undefined : terrain.tiles[Math.floor(x / TILE)];
}

export function solidAt(terrain: Terrain, x: number): boolean {
  const tile = tileAt(terrain, x);
  return tile !== undefined && !(tile.kind === "d" && tile.stage === 3);
}

/** The surfaces at x: the ground (when solid) and the tops of stair steps. */
export function tops(world: World, terrain: Terrain, x: number): number[] {
  const found: number[] = [];
  if (solidAt(terrain, x)) found.push(world.gy);
  for (const stair of terrain.stairs) if (x >= stair.x && x < stair.x + STAIR_W) found.push(stair.top);
  return found;
}

/** The highest surface at x that a walker at y can reach (at most `up` higher), or Infinity. */
export function surface(world: World, terrain: Terrain, x: number, y: number, up: number): number {
  return Math.min(Infinity, ...tops(world, terrain, x).filter((top: number): boolean => top >= y - up));
}

/** Breaks dirt one stage. Returns false for protected ground. The repair restarts at each hit. */
export function hit(tile: Tile, tick: number): boolean {
  if (tile.kind === "g") return false;
  tile.stage = Math.min(3, tile.stage + 1);
  tile.repairAt = tick + TERRAIN_LIFETIME_TICKS;
  return true;
}

/** Adds a stair step. At STAIRS_MAX the oldest step goes. */
export function addStair(terrain: Terrain, x: number, top: number, dir: 1 | -1, tick: number): void {
  if (terrain.stairs.length >= STAIRS_MAX) terrain.stairs.shift();
  terrain.stairs.push({ x, top, dir, until: tick + TERRAIN_LIFETIME_TICKS });
}

/** Repairs due dirt and removes expired steps. */
export function expire(terrain: Terrain, tick: number): void {
  for (const tile of terrain.tiles) {
    if (tile.stage && tile.repairAt && tick >= tile.repairAt) {
      tile.stage = 0;
      tile.repairAt = 0;
    }
  }
  terrain.stairs = terrain.stairs.filter((stair: Stair): boolean => stair.until >= tick);
}

/** Where a build may place steps: a little outside the walking limits. */
export function buildFits(world: World, x: number): boolean {
  return x >= world.xmin - 10 && x + STAIR_W <= world.xmax + 10;
}

/** The direction a build takes from x: toward the middle near a walking limit, else `dir`. */
export function buildDirection(world: World, x: number, dir: 1 | -1): 1 | -1 {
  if (x > world.xmax - BUILD_TURN_INSET) return -1;
  if (x < world.xmin + BUILD_TURN_INSET) return 1;
  return dir;
}

export function groundString(terrain: Terrain): string {
  return terrain.tiles.map((tile: Tile): string => (tile.kind === "g" ? "g" : String(tile.stage))).join("");
}

export function terrainView(world: World, terrain: Terrain): TerrainView {
  return {
    w: world.w,
    h: world.h,
    gy: world.gy,
    tile: TILE,
    ground: groundString(terrain),
    stairs: terrain.stairs.map((stair: Stair): StairTuple => [Math.round(stair.x), Math.round(stair.top), stair.dir]),
    padX: world.padX,
    entryX: world.entryX,
    exitX: world.exitX,
    xmin: world.xmin,
    xmax: world.xmax,
  };
}
