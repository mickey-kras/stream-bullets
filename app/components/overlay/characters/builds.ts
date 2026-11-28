import { DURATION, TICK_HZ } from "../../../lib/playground/constants";
import {
  PIXEL_SCALE,
  type PlaygroundTheme,
  type Point,
  type Rect,
  type TerrainPicture,
} from "../wasteland/playground-theme";
import type { Atlas } from "./sprites";
import type { BlockView, CharacterView, PlaygroundView, RopeView } from "./view";

/**
 * The drawing of what the viewers build and carry: blocks, stairs, planks, flags, ropes, the crown and the flame of
 * a jetpack. The shared picture helpers are here too. Everything draws in world pixels.
 */

export function snap(value: number): number {
  return Math.round(value * PIXEL_SCALE) / PIXEL_SCALE;
}

export function picture(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  rect: Rect,
  x: number,
  y: number,
  flip: boolean = false,
): void {
  const [sx, sy, w, h] = rect;
  if (!flip) {
    ctx.drawImage(image, sx, sy, w, h, x, y, w, h);
    return;
  }
  ctx.save();
  ctx.translate(x + w, y);
  ctx.scale(-1, 1);
  ctx.drawImage(image, sx, sy, w, h, 0, 0, w, h);
  ctx.restore();
}

/** The picture of a dirt block: one of the dirt tiles by its cell, or a cracked tile. */
function dirtPicture(block: BlockView): TerrainPicture {
  if (block.stage === 0) return (["dirt0", "dirt1", "dirt2"] as const)[(block.c + block.r) % 3];
  return block.stage === 1 ? "crack1" : "crack2";
}

/** The picture of a plank: an end cap where the bridge ends in the air, the middle piece beside a block. */
function plankPicture(block: BlockView, taken: ReadonlySet<string>): TerrainPicture {
  const left: boolean = taken.has(`${block.c - 1},${block.r}`);
  const right: boolean = taken.has(`${block.c + 1},${block.r}`);
  if (left === right) return "plankM";
  return left ? "plankR" : "plankL";
}

/** The builds: dirt blocks with the ground pictures, planks at the top of their cell, and stairs of four treads. */
export function drawBlocks(
  ctx: CanvasRenderingContext2D,
  view: PlaygroundView,
  theme: PlaygroundTheme,
  terrain: HTMLImageElement,
): void {
  const { rects, tile } = theme.terrain;
  const taken = new Set<string>(view.blocks.map((block: BlockView): string => `${block.c},${block.r}`));
  for (const block of view.blocks) {
    const x: number = block.c * tile;
    const y: number = view.world.ground - (block.r + 1) * tile;
    if (block.kind === "dirt") picture(ctx, terrain, rects[dirtPicture(block)], x, y);
    else if (block.kind === "plank") picture(ctx, terrain, rects[plankPicture(block, taken)], x, y);
    else picture(ctx, terrain, rects.stair, x, y, block.dir < 0);
  }
}

/** The frame of a loop at `now` (performance.now()): each frame shows for `ticks` rules ticks. */
function loopFrame(now: number, ticks: number, count: number): number {
  return Math.floor((now * TICK_HZ) / (1000 * ticks)) % count;
}

/** The flags of the viewers: the cloth has the helmet colour of the owner's platform. The pole stands on flag.x + 4. */
export function drawFlags(
  ctx: CanvasRenderingContext2D,
  view: PlaygroundView,
  theme: PlaygroundTheme,
  atlas: Atlas,
  now: number,
  reduced: boolean,
): void {
  const { frames, ticksPerFrame } = theme.builds.viewerFlag;
  const frame: Rect = frames[reduced ? 0 : loopFrame(now, ticksPerFrame, frames.length)];
  for (const flag of view.flags) {
    picture(ctx, atlas.flags.get(flag.platform), frame, Math.round(flag.x) + 4, Math.round(flag.y) - frame[3]);
  }
}

/** How much of a rope shows: it grows to a hook that holds, and it goes out and comes back after a miss. */
function ropeShare(rope: RopeView, character: CharacterView): number {
  if (character.state !== "shoot") return 1;
  if (rope.hit) return Math.min(1, character.t / DURATION.shootHit);
  return Math.sin(Math.min(1, character.t / DURATION.shootMiss) * Math.PI);
}

export function drawRopes(
  ctx: CanvasRenderingContext2D,
  view: PlaygroundView,
  theme: PlaygroundTheme,
  atlas: Atlas,
  reduced: boolean,
): void {
  const { builds } = theme;
  const hook: Rect = theme.terrain.rects.hook;
  for (const rope of view.ropes) {
    const c: CharacterView | undefined = view.characters.find((o: CharacterView): boolean => o.id === rope.id);
    if (!c) continue;
    const share: number = reduced ? 1 : ropeShare(rope, c);
    const [dx, dy]: Point = c.state === "zip" ? builds.ropeFrom.zip : builds.ropeFrom.shoot;
    const from = { x: snap(c.x) + c.dir * dx, y: snap(c.y) + dy };
    // At the end of the ride the hand is above the hook: the rope is then behind the character.
    if (c.state === "zip" && from.y <= rope.y) continue;
    const to = { x: from.x + (rope.x - from.x) * share, y: from.y + (rope.y - from.y) * share };
    for (const [color, width] of [
      [builds.ropeInk, 2],
      [builds.rope, 1],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    picture(ctx, atlas.terrain, hook, Math.round(to.x) - 2, Math.round(to.y) - 2, c.dir < 0);
  }
}

/** The crown over the head of the highest character, and the flame under the pack of a jetpack. */
export function drawGear(
  ctx: CanvasRenderingContext2D,
  view: PlaygroundView,
  theme: PlaygroundTheme,
  atlas: Atlas,
  now: number,
  reduced: boolean,
): void {
  const { rects } = theme.terrain;
  const { flame, crown } = theme.builds;
  const burn: Rect = rects[flame.pictures[reduced ? 0 : loopFrame(now, 2, flame.pictures.length)]];
  for (const c of view.characters) {
    const x: number = Math.round(c.x);
    const y: number = Math.round(c.y);
    if (c.state === "jet") picture(ctx, atlas.terrain, burn, x + c.dir * flame.at[0] - burn[2] / 2, y + flame.at[1]);
    if (c.id !== view.crown || !theme.sequences[c.state]) continue;
    picture(ctx, atlas.terrain, rects.crown, x + crown[0] - rects.crown[2] / 2, y + crown[1] - rects.crown[3]);
  }
}
