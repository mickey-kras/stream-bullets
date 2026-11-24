import {
  BLOCK_FILL,
  BOUNCE_INSET,
  BUILD_CEILING,
  CELL_LOGICAL,
  CELLS_H_MAX,
  CELLS_H_MIN,
  CELLS_W_MAX,
  CELLS_W_MIN,
  DOOR_CLEAR_ROWS,
  ENTRY_X,
  EXIT_INSET,
  FALL_OUT,
  GROUND_OFFSET,
  MIDDLE_DIRT,
  MIDDLE_GIRDER,
  PAD_CLEAR_COLS,
  PAD_CLEAR_ROWS,
  TERRAIN_LIFETIME_TICKS,
  TILE,
  WALK_INSET,
  ZONE_TILES,
} from "./constants";
import { BLOCK_NONE, BLOCK_STAGES, type BlockKind, blockCode, blockOf, type TerrainView } from "./protocol";

/**
 * The world geometry and the shared terrain. The world comes from the characters cell: CELL_LOGICAL logical px per
 * cell. The ground is at the bottom. Both ends are protected girder zones for the doors. The middle repeats breakable
 * dirt and protected girder runs. Above the ground is the block grid: cells of TILE px that viewers fill with blocks.
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
  /** The block grid: columns (one per ground tile) and rows, and the most blocks at once. */
  cols: number;
  rows: number;
  cap: number;
}

export interface Tile {
  /** "g" protected girder, "d" breakable dirt. */
  kind: "g" | "d";
  /** Damage of dirt: 0 intact to 3 a hole. */
  stage: number;
  /** The tick at which damaged dirt repairs, or 0. */
  repairAt: number;
}

export interface Block {
  kind: BlockKind;
  /** A stair rises in this direction. Other blocks have 1. */
  dir: 1 | -1;
  /** Damage: 0 intact to BLOCK_STAGES - 1. One more hit breaks the block. */
  stage: number;
  /** The order of building: at the limit the block with the lowest number goes. */
  seq: number;
}

/** A flag of a participant (frame id), on the floor of cell (c, r). */
export interface Flag {
  id: number;
  c: number;
  r: number;
}

export interface Terrain {
  tiles: Tile[];
  /** The block grid, row 0 on the ground: cell (c, r) is at r * cols + c. */
  blocks: (Block | null)[];
  flags: Flag[];
  count: number;
  seq: number;
  /** A block went or the ground opened: loose blocks can fall. */
  loose: boolean;
}

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
  const cols: number = Math.ceil(w / TILE);
  const kinds = tileKinds(cols, w);
  // The pad stands on the first protected middle run, else on the last entrance tile.
  let padTile: number = ZONE_TILES - 1;
  const first: number = kinds.findIndex((kind, i: number): boolean => i >= ZONE_TILES && kind === "g");
  if (first >= 0 && (first + 1) * TILE <= w - zone) padTile = first + Math.floor(MIDDLE_GIRDER / 2);
  const gy: number = h - GROUND_OFFSET;
  const rows: number = Math.max(0, Math.floor((gy - BUILD_CEILING) / TILE));
  return {
    cellsW,
    cellsH,
    w,
    h,
    gy,
    xmin,
    xmax,
    entryX: ENTRY_X,
    exitX: w - EXIT_INSET,
    padX: padTile * TILE + TILE / 2,
    fallY: h + FALL_OUT,
    bounceMin: BOUNCE_INSET,
    bounceMax: w - BOUNCE_INSET,
    cols,
    rows,
    cap: Math.max(1, Math.round(cols * rows * BLOCK_FILL)),
  };
}

export function createTerrain(world: World): Terrain {
  const kinds = tileKinds(world.cols, world.w);
  return {
    tiles: kinds.map((kind): Tile => ({ kind, stage: 0, repairAt: 0 })),
    blocks: new Array<Block | null>(world.cols * world.rows).fill(null),
    flags: [],
    count: 0,
    seq: 0,
    loose: false,
  };
}

export function tileAt(terrain: Terrain, x: number): Tile | undefined {
  return x < 0 ? undefined : terrain.tiles[Math.floor(x / TILE)];
}

export function solidAt(terrain: Terrain, x: number): boolean {
  const tile = tileAt(terrain, x);
  return tile !== undefined && !(tile.kind === "d" && tile.stage === 3);
}

/** The column of x, the row of feet at y (0 on the ground), the centre x of a column and the floor y of a row. */
export function colOf(x: number): number {
  return Math.floor(x / TILE);
}
export function rowOf(world: World, y: number): number {
  return Math.round((world.gy - y) / TILE);
}
export function cellX(c: number): number {
  return c * TILE + TILE / 2;
}
export function floorY(world: World, r: number): number {
  return world.gy - r * TILE;
}

/** The block of cell (c, r), or null for an empty cell and for a cell outside the grid. */
export function blockAt(world: World, terrain: Terrain, c: number, r: number): Block | null {
  if (c < 0 || c >= world.cols || r < 0 || r >= world.rows) return null;
  return terrain.blocks[r * world.cols + c];
}

/** A dirt block or a plank is a wall to a body. A stair is not: a character walks up it, or behind it. */
export function wallAt(world: World, terrain: Terrain, c: number, r: number): boolean {
  const block: Block | null = blockAt(world, terrain, c, r);
  return block !== null && block.kind !== "stair";
}

/** A character can stand with its feet on the floor of row r in column c: no wall at its body. */
export function fits(world: World, terrain: Terrain, c: number, r: number): boolean {
  return c >= 0 && c < world.cols && !wallAt(world, terrain, c, r) && !wallAt(world, terrain, c, r + 1);
}

/** The height of a stair at `u` px from its low edge: four steps, the top one from the middle of the cell. */
function stairRise(u: number): number {
  if (u < 3) return 4;
  if (u < 5) return 8;
  return u < 8 ? 12 : TILE;
}

/** The surfaces at x: the ground (when solid) and the tops of the blocks of that column. */
export function tops(world: World, terrain: Terrain, x: number): number[] {
  const found: number[] = [];
  if (solidAt(terrain, x)) found.push(world.gy);
  const c: number = colOf(x);
  if (c < 0 || c >= world.cols) return found;
  for (let r = 0; r < world.rows; r++) {
    const block: Block | null = terrain.blocks[r * world.cols + c];
    if (!block) continue;
    const u: number = block.dir > 0 ? x - c * TILE : (c + 1) * TILE - x;
    found.push(floorY(world, r) - (block.kind === "stair" ? stairRise(u) : TILE));
  }
  return found;
}

/** The highest surface at x that a walker at y can reach (at most `up` higher), or Infinity. */
export function surface(world: World, terrain: Terrain, x: number, y: number, up: number): number {
  return Math.min(Infinity, ...tops(world, terrain, x).filter((top: number): boolean => top >= y - up));
}

/** Breaks dirt one stage. Returns false for protected ground. The repair restarts at each hit. */
export function hit(terrain: Terrain, tile: Tile, tick: number): boolean {
  if (tile.kind === "g") return false;
  tile.stage = Math.min(3, tile.stage + 1);
  tile.repairAt = tick + TERRAIN_LIFETIME_TICKS;
  if (tile.stage === 3) terrain.loose = true;
  return true;
}

/** Repairs due dirt. */
export function expire(terrain: Terrain, tick: number): void {
  for (const tile of terrain.tiles) {
    if (tile.stage && tile.repairAt && tick >= tile.repairAt) {
      tile.stage = 0;
      tile.repairAt = 0;
    }
  }
}

/** Nobody builds here: the door zones up to the door height, and the space over the respawn pad. */
export function protectedCell(world: World, c: number, r: number): boolean {
  const zone: number = ZONE_TILES * TILE;
  if ((c * TILE < zone || (c + 1) * TILE > world.w - zone) && r < DOOR_CLEAR_ROWS) return true;
  return Math.abs(c - colOf(world.padX)) <= PAD_CLEAR_COLS && r < PAD_CLEAR_ROWS;
}

/** A block in this cell holds: it is on solid ground, or it touches another block, also at a corner. */
function touches(world: World, terrain: Terrain, c: number, r: number): boolean {
  if (r === 0) return solidAt(terrain, cellX(c));
  for (let dc = -1; dc <= 1; dc++) {
    for (let dr = -1; dr <= 1; dr++) if ((dc || dr) && blockAt(world, terrain, c + dc, r + dr)) return true;
  }
  return false;
}

/** A block can go in cell (c, r): the cell is in the grid, empty, not protected, and the block would hold. */
export function canPlace(world: World, terrain: Terrain, c: number, r: number): boolean {
  if (c < 0 || c >= world.cols || r < 0 || r >= world.rows) return false;
  return !terrain.blocks[r * world.cols + c] && !protectedCell(world, c, r) && touches(world, terrain, c, r);
}

export function removeBlock(world: World, terrain: Terrain, c: number, r: number): void {
  if (!blockAt(world, terrain, c, r)) return;
  terrain.blocks[r * world.cols + c] = null;
  terrain.count -= 1;
  terrain.loose = true;
}

/** Puts a block in an empty cell. At the limit of the world, the oldest block goes first. */
export function placeBlock(world: World, terrain: Terrain, c: number, r: number, kind: BlockKind, dir: 1 | -1): void {
  if (terrain.count >= world.cap) {
    let oldest = -1;
    for (const [i, block] of terrain.blocks.entries()) {
      if (block && (oldest < 0 || block.seq < (terrain.blocks[oldest]?.seq ?? Infinity))) oldest = i;
    }
    if (oldest >= 0) removeBlock(world, terrain, oldest % world.cols, Math.floor(oldest / world.cols));
  }
  terrain.seq += 1;
  terrain.blocks[r * world.cols + c] = { kind, dir, stage: 0, seq: terrain.seq };
  terrain.count += 1;
}

/** Damages a block one stage. The hit after the last stage breaks it. Returns false for an empty cell. */
export function hitBlock(world: World, terrain: Terrain, c: number, r: number): boolean {
  const block: Block | null = blockAt(world, terrain, c, r);
  if (!block) return false;
  block.stage += 1;
  if (block.stage >= BLOCK_STAGES) removeBlock(world, terrain, c, r);
  return true;
}

/** The cells of the blocks that hold: a path of touching blocks, also at a corner, goes from each to solid ground. */
function heldCells(world: World, terrain: Terrain): Set<number> {
  const { cols } = world;
  const held = new Set<number>();
  const stack: number[] = [];
  const hold = (c: number, r: number): void => {
    const at: number = r * cols + c;
    if (!blockAt(world, terrain, c, r) || held.has(at)) return;
    held.add(at);
    stack.push(at);
  };
  for (let c = 0; c < cols; c++) if (solidAt(terrain, cellX(c))) hold(c, 0);
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    for (let dc = -1; dc <= 1; dc++)
      for (let dr = -1; dr <= 1; dr++) hold((at % cols) + dc, Math.floor(at / cols) + dr);
  }
  return held;
}

/** A flag stays while it has a floor under it and no wall in it. */
function flagStands(world: World, terrain: Terrain, flag: Flag): boolean {
  const floor: boolean = flag.r === 0 ? solidAt(terrain, cellX(flag.c)) : !!blockAt(world, terrain, flag.c, flag.r - 1);
  return floor && !wallAt(world, terrain, flag.c, flag.r);
}

/**
 * One step of the loose blocks. A block that does not hold falls one row. A block over a hole in the ground falls
 * out. `crush(c, r)` is true when a character is in the cell below: the block then breaks. Flags without a floor go.
 * `terrain.loose` stays true while a block moved.
 */
export function dropLoose(world: World, terrain: Terrain, crush: (c: number, r: number) => boolean): void {
  const { cols } = world;
  const held: Set<number> = heldCells(world, terrain);
  let moved = false;
  for (const [at, block] of terrain.blocks.entries()) {
    if (!block || held.has(at)) continue;
    moved = true;
    const c: number = at % cols;
    const r: number = Math.floor(at / cols);
    if (r === 0 || crush(c, r - 1)) removeBlock(world, terrain, c, r);
    else if (!terrain.blocks[at - cols]) {
      terrain.blocks[at - cols] = block;
      terrain.blocks[at] = null;
    }
  }
  terrain.flags = terrain.flags.filter((flag: Flag): boolean => flagStands(world, terrain, flag));
  terrain.loose = moved;
}

/** Removes all builds: the blocks and the flags. The ground stays as it is. */
export function clearBuilds(terrain: Terrain): void {
  terrain.blocks.fill(null);
  terrain.flags = [];
  terrain.count = 0;
  terrain.loose = false;
}

export function groundString(terrain: Terrain): string {
  return terrain.tiles.map((tile: Tile): string => (tile.kind === "g" ? "g" : String(tile.stage))).join("");
}

/** The block grid as text (see TerrainView.blocks): the rows up to the highest block. */
export function blocksString(world: World, terrain: Terrain): string {
  let last = -1;
  for (const [i, block] of terrain.blocks.entries()) if (block) last = i;
  const cells: number = last < 0 ? 0 : (Math.floor(last / world.cols) + 1) * world.cols;
  return terrain.blocks
    .slice(0, cells)
    .map((block: Block | null): string => (block ? blockCode(block) : BLOCK_NONE))
    .join("");
}

/** Puts the blocks of a `blocksString` text into an empty terrain, in building order from the ground up. Throws when the text does not fit the grid. */
export function restoreBlocks(world: World, terrain: Terrain, text: string): void {
  if (text.length > terrain.blocks.length || text.length % Math.max(1, world.cols) !== 0) {
    throw new Error(`playground blocks do not fit the grid: ${text.length}`);
  }
  for (const [i, code] of Array.from(text).entries()) {
    const cell = blockOf(code);
    if (!cell) continue;
    terrain.seq += 1;
    terrain.blocks[i] = { ...cell, seq: terrain.seq };
    terrain.count += 1;
  }
  terrain.loose = terrain.count > 0;
}

export function terrainView(world: World, terrain: Terrain): TerrainView {
  return {
    w: world.w,
    h: world.h,
    gy: world.gy,
    tile: TILE,
    ground: groundString(terrain),
    rows: world.rows,
    blocks: blocksString(world, terrain),
    padX: world.padX,
    entryX: world.entryX,
    exitX: world.exitX,
    xmin: world.xmin,
    xmax: world.xmax,
  };
}
