import { DURATION } from "../../../lib/playground/constants";
import { PIXEL_SCALE, type PlaygroundTheme, type Rect, type TerrainPicture } from "../wasteland/playground-theme";
import { helmetColor } from "./sprites";
import type { BlockView, CharacterView, PlaygroundView, RopeView } from "./view";

/**
 * The drawing of what the viewers build: blocks, stairs, planks, flags, ropes, the crown and the jetpack. The shared
 * picture helpers are here too. Everything draws in world pixels.
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

/** One tread of the step picture (3 px, without its leg) with its left edge at x, turned for a stair to the left. */
function tread(
  ctx: CanvasRenderingContext2D,
  theme: PlaygroundTheme,
  terrain: HTMLImageElement,
  x: number,
  top: number,
  dir: 1 | -1,
  leg: number,
): void {
  const [sx, sy, sw] = theme.terrain.rects.step;
  ctx.save();
  ctx.translate(dir > 0 ? x : x + sw, 0);
  ctx.scale(dir, 1);
  ctx.drawImage(terrain, sx, sy, sw, 3, 0, top, sw, 3);
  if (leg > 0) ctx.drawImage(terrain, sx, sy + 3, sw, 1, 0, top + 3, sw, leg);
  ctx.restore();
}

/** The picture of a dirt block: one of the dirt tiles by its cell, or a cracked tile. */
function dirtPicture(block: BlockView): TerrainPicture {
  if (block.stage === 0) return (["dirt0", "dirt1", "dirt2"] as const)[(block.c + block.r) % 3];
  return block.stage === 1 ? "crack1" : "crack2";
}

/** The builds: dirt blocks with the ground pictures, planks and stairs with the step picture. */
export function drawBlocks(
  ctx: CanvasRenderingContext2D,
  view: PlaygroundView,
  theme: PlaygroundTheme,
  terrain: HTMLImageElement,
): void {
  const { rects, tile } = theme.terrain;
  const sw: number = rects.step[2];
  const { stairTreads, plankTreads } = theme.builds;
  for (const block of view.blocks) {
    const x: number = block.c * tile;
    const y: number = view.world.ground - (block.r + 1) * tile;
    if (block.kind === "dirt") picture(ctx, terrain, rects[dirtPicture(block)], x, y);
    else if (block.kind === "plank") for (const dx of plankTreads) tread(ctx, theme, terrain, x + dx, y, 1, 0);
    else {
      stairTreads.forEach((dx: number, i: number): void => {
        const rise: number = 4 * (i + 1);
        tread(ctx, theme, terrain, block.dir > 0 ? x + dx : x + tile - sw - dx, y + tile - rise, block.dir, rise - 3);
      });
    }
  }
}

/** The flags of the viewers: a pole and a pennant in the helmet colour of the owner's platform. */
export function drawFlags(ctx: CanvasRenderingContext2D, view: PlaygroundView, theme: PlaygroundTheme): void {
  for (const flag of view.flags) {
    const x: number = Math.round(flag.x) + 4;
    const y: number = Math.round(flag.y);
    ctx.fillStyle = theme.builds.pole;
    ctx.fillRect(x, y - 15, 1, 15);
    ctx.fillStyle = helmetColor(theme, flag.platform);
    ctx.fillRect(x + 1, y - 15, 7, 5);
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
  reduced: boolean,
): void {
  for (const rope of view.ropes) {
    const c: CharacterView | undefined = view.characters.find((o: CharacterView): boolean => o.id === rope.id);
    if (!c) continue;
    const share: number = reduced ? 1 : ropeShare(rope, c);
    const from = { x: snap(c.x) + c.dir * 4, y: snap(c.y) - 20 };
    const to = { x: from.x + (rope.x - from.x) * share, y: from.y + (rope.y - from.y) * share };
    for (const [color, width] of [
      [theme.builds.ropeInk, 2],
      [theme.builds.rope, 1],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    ctx.fillStyle = theme.builds.hook;
    ctx.fillRect(Math.round(to.x) - 1, Math.round(to.y) - 1, 3, 3);
  }
}

/** The crown over the head of the highest character, and the pack and flame of a jetpack. */
export function drawGear(
  ctx: CanvasRenderingContext2D,
  view: PlaygroundView,
  theme: PlaygroundTheme,
  now: number,
): void {
  const { builds } = theme;
  for (const c of view.characters) {
    const x: number = Math.round(c.x);
    const y: number = Math.round(c.y);
    if (c.state === "jet") {
      const back: number = x - c.dir * 7;
      ctx.fillStyle = builds.pack;
      ctx.fillRect(back - 2, y - 20, 4, 9);
      ctx.fillStyle = builds.flame[Math.floor(now / theme.blinkMs) % builds.flame.length];
      ctx.fillRect(back - 1, y - 11, 2, 5);
    }
    if (c.id !== view.crown || !theme.sequences[c.state]) continue;
    ctx.fillStyle = builds.crownInk;
    ctx.fillRect(x - 5, y - 35, 10, 5);
    ctx.fillStyle = builds.crown;
    ctx.fillRect(x - 4, y - 32, 8, 1);
    for (const dx of [-4, -1, 0, 3]) ctx.fillRect(x + dx, y - 34, 1, 2);
  }
}
