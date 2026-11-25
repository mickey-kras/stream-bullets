import { z } from "zod";
import { CHANNEL_PLATFORMS } from "../../../db/enums";
import type { ActivityPlatform } from "../activity";

import { CHARACTERS_MAX, CHARACTERS_TIMEOUT } from "../overlay-layers";
import { REGISTRY_MAX, RESTRICTED_MAX, VISIBLE_MAX, WALK_SPEED } from "./constants";
import { newParticipant, type Participant } from "./crowd";
import { FRAME_BLOCKS_MAX, FRAME_TILES_MAX, NAME_MAX_UNITS, PLAYGROUND_VERSION } from "./protocol";
import { type Flag, restoreBlocks, type Terrain, type World } from "./terrain";
import { mulberry32, siteKey } from "./core";

/** The checkpoint of the playground: what stays across a Durable Object eviction, and how it is read back. */

/** Puts the checkpoint's ground stages, repairs, blocks and flags into a new terrain. Throws when they do not fit it. */
export function restoreTerrain(world: World, terrain: Terrain, data: Checkpoint): void {
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
  restoreBlocks(world, terrain, data.blocks, data.order);
  terrain.flags = data.flags
    .filter(([, c, r]): boolean => c < world.cols && r <= world.rows)
    .map(([id, c, r]): Flag => ({ id, c, r }));
}

/** id, platform, user id, name, score, scoreAt, lastScored, lastChat, lastCommand, admitted, admittedAt, x, removed. */
export type ParticipantRecord = [
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

export interface Checkpoint {
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
  /** The cells of the blocks in building order (see blockOrder). */
  order: number[];
  flags: [number, number, number][];
  registry: ParticipantRecord[];
  restrictions: [string, number][];
}

export function issueText(error: z.ZodError): string {
  const [first] = error.issues;
  return `${first.path.join(".")}: ${first.message} (${error.issues.length} issues)`;
}

export function toRecord(p: Participant): ParticipantRecord {
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

export function fromRecord(record: ParticipantRecord, clock: number, walkSpread: number): Participant {
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

export const checkpointSchema: z.ZodType<Checkpoint> = z
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
    // A checkpoint without the order takes the blocks in rows from the ground up.
    order: z.array(z.number().int().min(0).max(FRAME_BLOCKS_MAX)).max(FRAME_BLOCKS_MAX).default([]),
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
