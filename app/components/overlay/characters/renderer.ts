import { graphemes } from "../../../lib/chat-feed";
import { DURATION, TICK_HZ } from "../../../lib/playground/constants";
import { CUT_MARK } from "../../../lib/playground/protocol";
import { type GlyphShape, glyphOf } from "../wasteland/glyphs";
import {
  PIXEL_SCALE,
  type PlaygroundTheme,
  type Rect,
  type Sequence,
  type TerrainPicture,
} from "../wasteland/playground-theme";
import { type Atlas, helmetColor } from "./sprites";
import type { BlockView, CharacterState, CharacterView, PlaygroundView, RopeView, TileView } from "./view";

/** States in which a character only moves around; a name label shows in all other states. */
const QUIET_STATES: ReadonlySet<CharacterState> = new Set<CharacterState>([
  "walk",
  "goto",
  "idle",
  "hold",
  "step",
  "turn",
  "enter",
  "exit",
  "respawn",
  "gone",
]);
/** Label bitmaps kept; the cache is emptied when it grows past this. */
const LABEL_CACHE_MAX = 200;
/** Cosmetic particles on screen at most. */
const PARTICLES_MAX = 160;
const MS_PER_TICK = 1000 / TICK_HZ;

/** A name label shows while the character speaks, acts on a command, or was just admitted. */
export function showsLabel(character: CharacterView): boolean {
  return character.bubble !== null || character.recent || !QUIET_STATES.has(character.state);
}

/** The frame column of a sequence after `t` ticks. */
export function frameAt(sequence: Sequence, t: number): number {
  const step: number = Math.max(0, Math.floor(t / sequence.ticksPerFrame));
  const { frames, loopFrom } = sequence;
  if (loopFrom === undefined) return frames[Math.min(step, frames.length - 1)];
  if (step < frames.length) return frames[step];
  return frames[loopFrom + ((step - loopFrom) % (frames.length - loopFrom))];
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  life: number;
  /** A pixel of this colour, or a picture. */
  color: string | null;
  picture: { image: CanvasImageSource; rect: Rect } | null;
}

/** What the renderer keeps between frames: particles, the previous state of each character, label bitmaps. */
export interface RenderMemory {
  particles: Particle[];
  seen: Map<number, { state: CharacterState; t: number }>;
  holes: boolean[];
  /** The cells that had a block in the previous frame, as "column,row". */
  blocks: Set<string>;
  labels: Map<string, HTMLCanvasElement>;
  last: number;
  seed: number;
}

export function createMemory(): RenderMemory {
  return {
    particles: [],
    seen: new Map(),
    holes: [],
    blocks: new Set(),
    labels: new Map(),
    last: 0,
    seed: 1,
  };
}

export interface DrawOptions {
  /** No particles, no blinking, first frames only. */
  reduced: boolean;
  /** Badge texts for the test and paused modes. */
  badges: { test: string; paused: string };
}

/** A repeatable pseudo-random number in [0, 1) for cosmetic scatter. */
function noise(memory: RenderMemory): number {
  memory.seed = (Math.imul(memory.seed, 1664525) + 1013904223) >>> 0;
  return memory.seed / 4294967296;
}

function burst(
  memory: RenderMemory,
  x: number,
  y: number,
  count: number,
  make: (i: number) => Partial<Particle>,
): void {
  for (let i = 0; i < count && memory.particles.length < PARTICLES_MAX; i++) {
    memory.particles.push({
      x,
      y,
      vx: (noise(memory) - 0.5) * 1.8,
      vy: -noise(memory) * 1.8,
      gravity: 0.15,
      life: 26,
      color: null,
      picture: null,
      ...make(i),
    });
  }
}

function snap(value: number): number {
  return Math.round(value * PIXEL_SCALE) / PIXEL_SCALE;
}

function tilePicture(tiles: readonly TileView[], i: number): TerrainPicture {
  const tile: TileView = tiles[i];
  if (tile.kind === "girder") {
    if (tiles[i - 1]?.kind !== "girder") return "girderL";
    return tiles[i + 1]?.kind === "girder" ? "girderM" : "girderR";
  }
  if (tile.stage === 3) return "hole";
  if (tile.stage === 0) return (["dirt0", "dirt1", "dirt2"] as const)[i % 3];
  return tile.stage === 1 ? "crack1" : "crack2";
}

/** Runs of equal tiles between the two door zones (the first and last runs). */
function middleRuns(tiles: readonly TileView[]): { kind: TileView["kind"]; from: number; to: number }[] {
  const runs: { kind: TileView["kind"]; from: number; to: number }[] = [];
  tiles.forEach((tile: TileView, i: number): void => {
    const run = runs.at(-1);
    if (run?.kind === tile.kind) run.to = i + 1;
    else runs.push({ kind: tile.kind, from: i, to: i + 1 });
  });
  return runs.slice(1, -1);
}

function spawnEffects(view: PlaygroundView, theme: PlaygroundTheme, atlas: Atlas, memory: RenderMemory): void {
  const { tile } = theme.terrain;
  const terrain: HTMLImageElement = atlas.terrain;
  const rock = (i: number): Partial<Particle> => ({
    picture: {
      image: terrain,
      rect: theme.terrain.rects[theme.particles.rocks[i % theme.particles.rocks.length]],
    },
  });
  view.tiles.forEach((t: TileView, i: number): void => {
    const hole: boolean = t.stage === 3;
    if (hole && memory.holes[i] === false) burst(memory, i * tile + tile / 2, view.world.ground + 4, 10, rock);
    memory.holes[i] = hole;
  });
  const blocks = new Set<string>(view.blocks.map((b: BlockView): string => `${b.c},${b.r}`));
  for (const key of memory.blocks) {
    if (blocks.has(key)) continue;
    const [c, r] = key.split(",").map(Number);
    burst(memory, c * tile + tile / 2, view.world.ground - r * tile - tile / 2, 5, (i) =>
      i % 2 ? rock(i) : { color: theme.particles.soil[i % 2] },
    );
  }
  memory.blocks = blocks;
  const seen = new Map<number, { state: CharacterState; t: number }>();
  for (const c of view.characters) {
    const before = memory.seen.get(c.id);
    seen.set(c.id, { state: c.state, t: c.t });
    if (before?.state !== c.state) continue;
    if (c.state === "dig" && Math.floor((before.t - 15) / 20) < Math.floor((c.t - 15) / 20)) {
      const ground: TileView | undefined = view.tiles[Math.floor((c.x + c.dir * 4) / tile)];
      // On a build, the dig is on a block. On the ground, only dirt gives rocks.
      if (c.y < view.world.ground || ground?.kind === "dirt") {
        burst(memory, c.x + c.dir * 8, c.y - 2, 4, rock);
        burst(memory, c.x + c.dir * 8, c.y - 2, 3, (i) => ({
          color: theme.particles.soil[i % 2],
        }));
      }
    }
    if (c.state === "boom" && before.t < 30 && c.t >= 30) {
      const sheet: HTMLCanvasElement = atlas.sheets.get(c.platform);
      const loose = (rect: Rect, vx: number, vy: number, dy: number): Particle => ({
        x: c.x + vx * 5,
        y: c.y + dy,
        vx,
        vy,
        gravity: 0.13,
        life: 48,
        color: null,
        picture: { image: sheet, rect },
      });
      memory.particles.push(
        loose(theme.courier.boot, -1.1, -2.6, -20),
        loose(theme.courier.boot, 1.2, -3, -22),
        loose(theme.courier.helmet, 0.3, -3.4, -28),
      );
      burst(memory, c.x, c.y - 12, 14, (i) => ({
        color: theme.particles.dust[i % 2],
      }));
    }
  }
  memory.seen = seen;
}

function moveParticles(memory: RenderMemory, ticks: number): void {
  memory.particles = memory.particles.filter((p: Particle): boolean => {
    p.vy += p.gravity * ticks;
    p.x += p.vx * ticks;
    p.y += p.vy * ticks;
    p.life -= ticks;
    return p.life > 0;
  });
}

function picture(
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

type PlaceTerrain = (name: TerrainPicture, x: number, y: number, flip?: boolean) => void;

function drawWorld(
  ctx: CanvasRenderingContext2D,
  view: PlaygroundView,
  theme: PlaygroundTheme,
  atlas: Atlas,
  now: number,
  reduced: boolean,
): void {
  const { rects, tile } = theme.terrain;
  const at: PlaceTerrain = (name: TerrainPicture, x: number, y: number, flip: boolean = false): void =>
    picture(ctx, atlas.terrain, rects[name], x, y, flip);
  const blink: boolean = !reduced && Math.floor(now / theme.blinkMs) % 2 === 0;

  view.tiles.forEach((_: TileView, i: number): void => at(tilePicture(view.tiles, i), i * tile, view.world.ground));
  drawProps(view, theme, at);
  drawLandmarks(ctx, view, theme, at, now, reduced, blink);
  drawBlocks(ctx, view, theme, atlas.terrain);
  drawFlags(ctx, view, theme);
}

/** One prop in the middle of each run of equal tiles, unless a hole is there. */
function drawProps(view: PlaygroundView, theme: PlaygroundTheme, at: PlaceTerrain): void {
  const { rects, tile } = theme.terrain;
  const ground: number = view.world.ground;
  let girderRun = 0;
  let dirtRun = 0;
  for (const run of middleRuns(view.tiles)) {
    const props: readonly TerrainPicture[] =
      run.kind === "girder" ? theme.terrain.girderProps : theme.terrain.dirtProps;
    const name: TerrainPicture = props[(run.kind === "girder" ? girderRun++ : dirtRun++) % props.length];
    const centre: number = ((run.from + run.to) / 2) * tile;
    const [, , w, h] = rects[name];
    if (view.tiles[Math.floor(centre / tile)]?.stage !== 3) at(name, Math.round(centre - w / 2), ground - h);
  }
}

/** The doors with their lamps, the flag, the signs, the antenna and the respawn pad. */
function drawLandmarks(
  ctx: CanvasRenderingContext2D,
  view: PlaygroundView,
  theme: PlaygroundTheme,
  at: PlaceTerrain,
  now: number,
  reduced: boolean,
  blink: boolean,
): void {
  const ground: number = view.world.ground;
  const { door } = theme;
  const inUse = (state: CharacterState): boolean => view.characters.some((c: CharacterView) => c.state === state);
  for (const [x, name, lamp, active] of [
    [view.doors.entrance, "doorIn", door.entranceLamp, inUse("enter")],
    [view.doors.exit, "doorOut", door.exitLamp, inUse("exit")],
  ] as const) {
    at(name, x + door.dx, ground + door.dy);
    if (active && blink) {
      const [lx, ly, lw, lh] = lamp.rect;
      ctx.fillStyle = lamp.color;
      ctx.fillRect(x + lx, ground + ly, lw, lh);
    }
  }
  const flags = ["flag0", "flag1", "flag2", "flag3", "flag4", "flag5"] as const;
  const flagFrame: number = reduced ? 0 : Math.floor(now / MS_PER_TICK / theme.flag.ticksPerFrame) % flags.length;
  // The flag needs sky above the doors; a low world has none.
  if (ground + theme.flag.dy >= 0) at(flags[flagFrame], view.doors.entrance + theme.flag.dx, ground + theme.flag.dy);
  at("signJoin", view.doors.entrance + theme.joinSign.dx, ground + theme.joinSign.dy);
  at("signExit", view.doors.exit + theme.exitSign.dx, ground + theme.exitSign.dy);
  at("antenna", view.doors.exit + theme.antenna.dx, ground + theme.antenna.dy);
  if (inUse("respawn") && (blink || reduced))
    at("padActive", view.pad + theme.pad.activeDx, ground + theme.pad.activeDy);
  else at("pad", view.pad + theme.pad.dx, ground + theme.pad.dy);
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
function drawBlocks(
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
function drawFlags(ctx: CanvasRenderingContext2D, view: PlaygroundView, theme: PlaygroundTheme): void {
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

function drawRopes(
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
function drawGear(ctx: CanvasRenderingContext2D, view: PlaygroundView, theme: PlaygroundTheme, now: number): void {
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

function drawCharacters(
  ctx: CanvasRenderingContext2D,
  view: PlaygroundView,
  theme: PlaygroundTheme,
  atlas: Atlas,
  reduced: boolean,
): void {
  const { cell, anchor, rows } = theme.courier;
  for (const c of view.characters) {
    const sequence: Sequence | null = theme.sequences[c.state];
    if (!sequence) continue;
    const column: number = reduced ? (sequence.still ?? sequence.frames[0]) : frameAt(sequence, c.t);
    const rect: Rect = [column * cell, rows.indexOf(sequence.row) * cell, cell, cell];
    const { danceTurnTicks, cheerLift, cheerTicks } = theme.builds;
    // A dance turns around in time, and a cheer jumps on the spot. The atlas has no pictures for them yet.
    const turned: boolean = !reduced && c.state === "dance" && Math.floor(c.t / danceTurnTicks) % 2 === 1;
    const left: boolean = c.dir < 0 !== turned;
    const lift: number =
      !reduced && c.state === "cheer" ? Math.abs(Math.sin((c.t / cheerTicks) * Math.PI)) * cheerLift : 0;
    picture(
      ctx,
      atlas.sheets.get(c.platform),
      rect,
      snap(c.x) - (left ? cell - anchor.x : anchor.x),
      snap(c.y - lift) - anchor.y,
      left,
    );
  }
}

function drawMarks(ctx: CanvasRenderingContext2D, view: PlaygroundView, theme: PlaygroundTheme): void {
  for (const mark of view.marks) {
    const x: number = Math.round(mark.x);
    const y: number = Math.round(mark.y);
    for (const [color, size] of [
      [theme.particles.markInk, 3],
      [theme.particles.markRed, 1],
    ] as const) {
      ctx.fillStyle = color;
      const half: number = (size - 1) / 2;
      for (let i = -2; i <= 2; i++) {
        ctx.fillRect(x + i - half, y + i - half, size, size);
        ctx.fillRect(x + i - half, y - i - half, size, size);
      }
    }
  }
}

function drawParticles(ctx: CanvasRenderingContext2D, memory: RenderMemory): void {
  for (const p of memory.particles) {
    const x: number = Math.round(p.x);
    const y: number = Math.round(p.y);
    if (p.picture) {
      const [, , w, h] = p.picture.rect;
      picture(ctx, p.picture.image, p.picture.rect, x - (w >> 1), y - (h >> 1), Math.floor(p.life / 8) % 2 === 1);
    } else if (p.color) {
      ctx.fillStyle = p.color;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

/** Cuts text to `max` user-perceived characters with the cut mark. */
function cut(text: string, max: number): string {
  const chars: string[] = graphemes(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}${CUT_MARK}` : text;
}

/** The first strong (letter) character of a text is from a right-to-left script. */
const RTL_FIRST = /^[^\p{L}]*[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;

/** The base direction of a text, from its first strong character (the Unicode paragraph rule). */
export function textDirection(text: string): CanvasDirection {
  return RTL_FIRST.test(text) ? "rtl" : "ltr";
}

/** Wraps text into at most `maxLines` lines no wider than `width`; the last line ends in an ellipsis if text is left. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  let left = false;
  for (const ch of graphemes(text.trim())) {
    if (lines.length === maxLines) {
      left = true;
      break;
    }
    if (line === "" || ctx.measureText(line + ch).width <= width) {
      line += ch;
      continue;
    }
    const [full, next] = breakLine(line, ch);
    lines.push(full);
    line = next;
  }
  if (line !== "" && lines.length < maxLines) lines.push(line);
  else if (line !== "") left = true;
  if (left) lines[lines.length - 1] = withCutMark(ctx, lines.at(-1) ?? "", width);
  return lines;
}

/** A full line and the start of the next when `ch` does not fit: the break goes at the last space if there is one. */
function breakLine(line: string, ch: string): [string, string] {
  const space: number = line.lastIndexOf(" ");
  if (ch !== " " && space > 0) return [line.slice(0, space), line.slice(space + 1) + ch];
  return [line, ch === " " ? "" : ch];
}

/** The line shortened until it fits `width` with the cut mark, then the mark. */
function withCutMark(ctx: CanvasRenderingContext2D, line: string, width: number): string {
  let last: string = line;
  while (last !== "" && ctx.measureText(`${last}${CUT_MARK}`).width > width)
    last = graphemes(last).slice(0, -1).join("");
  return `${last.trimEnd()}${CUT_MARK}`;
}

function labelCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element: HTMLCanvasElement = document.createElement("canvas");
  element.width = Math.ceil(width);
  element.height = Math.ceil(height);
  const context: CanvasRenderingContext2D | null = element.getContext("2d");
  if (!context) throw new Error("The browser gave no 2D canvas context for a label.");
  return [element, context];
}

function cached(memory: RenderMemory, key: string, make: () => HTMLCanvasElement): HTMLCanvasElement {
  let label: HTMLCanvasElement | undefined = memory.labels.get(key);
  if (!label) {
    if (memory.labels.size >= LABEL_CACHE_MAX) memory.labels.clear();
    label = make();
    memory.labels.set(key, label);
  }
  return label;
}

/** The platform glyph size on a name tag, in design px, and the gaps around it (as in the approved prototype). */
const GLYPH_PX = 16;
const GLYPH_LEFT = 6;
const GLYPH_GAP = 5;

/** Draws a 24 x 24 glyph at `x`, `y` in `color`, GLYPH_PX wide. */
function drawGlyph(
  ctx: CanvasRenderingContext2D,
  shapes: readonly GlyphShape[],
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(GLYPH_PX / 24, GLYPH_PX / 24);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (const shape of shapes) {
    const path = new Path2D(shape.d);
    if (shape.paint === "fill") ctx.fill(path);
    else ctx.stroke(path);
  }
  ctx.restore();
}

/** A name tag: dark rounded box, the platform glyph in the platform colour, light text, a small tail pointing down. */
function nameTag(theme: PlaygroundTheme, name: string, platform: string): HTMLCanvasElement {
  const style = theme.label.name;
  const font = `500 ${style.size}px ${theme.label.font}`;
  const [, probe] = labelCanvas(1, 1);
  probe.font = font;
  const text: string = cut(name, style.maxChars);
  const textX: number = GLYPH_LEFT + GLYPH_PX + GLYPH_GAP;
  const width: number = Math.ceil(probe.measureText(text).width) + textX + 7;
  const box: number = style.size + 8;
  const [tag, ctx] = labelCanvas(width + 2, box + 8);
  ctx.fillStyle = style.outline;
  ctx.beginPath();
  ctx.roundRect(0, 0, width + 2, box + 2, 7);
  ctx.fill();
  ctx.fillStyle = style.fill;
  ctx.beginPath();
  ctx.roundRect(1, 1, width, box, 6);
  ctx.moveTo(width / 2 - 5, box + 1);
  ctx.lineTo(width / 2 + 1, box + 7);
  ctx.lineTo(width / 2 + 7, box + 1);
  ctx.fill();
  drawGlyph(ctx, glyphOf(platform), GLYPH_LEFT, 1 + (box - GLYPH_PX) / 2, helmetColor(theme, platform));
  ctx.font = font;
  ctx.fillStyle = style.ink;
  ctx.textBaseline = "middle";
  // A right-to-left name keeps its place after the glyph; the direction puts its punctuation on the correct side.
  ctx.direction = textDirection(text);
  ctx.textAlign = "left";
  ctx.fillText(text, textX, box / 2 + 1);
  return tag;
}

/**
 * A bubble in design px: a 3 px border, a dark name row at the top, the text lines, and a tail under the box. The
 * tail is not in the bitmap: it draws on the layer, so it can point at a speaker who stands off the bubble centre.
 */
const BUBBLE_BORDER = 3;
const BUBBLE_PAD_X = 10;
const BUBBLE_NAME_ROW = 22;
/** The height of a bubble without its text lines: border, name row, the gaps above and below the text, border. */
const BUBBLE_FRAME = BUBBLE_BORDER + BUBBLE_NAME_ROW + 1 + 3 + BUBBLE_BORDER;
const BUBBLE_TAIL = 6;
/** The tail stays this far from the bubble corners. */
const TAIL_INSET = 16;
/** The free space between two bubbles side by side. */
export const BUBBLE_GAP = 8;
/** A tail that points further than this from its speaker's head gets a leader line to the head. */
export const LEADER_MIN = 24;
/** The leader line ends this far below the label point of a head: just above the helmet. */
const LEADER_DROP = 2;

function lineHeight(theme: PlaygroundTheme): number {
  return Math.round(theme.label.bubble.size * 1.1);
}

/** A speech bubble: light box with a dark border, the platform glyph and name in a dark row, then the text lines. */
function bubble(
  theme: PlaygroundTheme,
  name: string,
  platform: string,
  text: string,
  maxLines: number,
  maxWidth: number,
): HTMLCanvasElement {
  const style = theme.label.bubble;
  const nameStyle = theme.label.name;
  const font = `500 ${style.size}px ${theme.label.font}`;
  const nameFont = `600 ${nameStyle.size}px ${theme.label.font}`;
  const inner: number = maxWidth - 2 * (BUBBLE_BORDER + BUBBLE_PAD_X);
  const nameX: number = BUBBLE_BORDER + GLYPH_LEFT + GLYPH_PX + GLYPH_GAP;
  const [, probe] = labelCanvas(1, 1);
  probe.font = nameFont;
  const title: string = wrap(
    probe,
    cut(name, nameStyle.maxChars),
    maxWidth - nameX - BUBBLE_PAD_X - BUBBLE_BORDER,
    1,
  )[0];
  const titleWidth: number = nameX + probe.measureText(title).width + BUBBLE_PAD_X + BUBBLE_BORDER;
  probe.font = font;
  const lines: string[] = wrap(probe, text, inner, maxLines);
  const textWidth: number = Math.max(...lines.map((l: string) => probe.measureText(l).width));
  const width: number = Math.ceil(Math.max(titleWidth, textWidth + 2 * (BUBBLE_BORDER + BUBBLE_PAD_X)));
  const step: number = lineHeight(theme);
  const height: number = BUBBLE_FRAME + lines.length * step;
  const [element, ctx] = labelCanvas(width, height);
  const half: number = BUBBLE_BORDER / 2;
  ctx.beginPath();
  ctx.roundRect(half, half, width - BUBBLE_BORDER, height - BUBBLE_BORDER, 10);
  ctx.fillStyle = style.fill;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = nameStyle.fill;
  ctx.fillRect(0, 0, width, BUBBLE_BORDER + BUBBLE_NAME_ROW);
  ctx.restore();
  ctx.lineWidth = BUBBLE_BORDER;
  ctx.strokeStyle = style.ink;
  ctx.stroke();
  const glyphY: number = BUBBLE_BORDER + (BUBBLE_NAME_ROW - GLYPH_PX) / 2;
  drawGlyph(ctx, glyphOf(platform), BUBBLE_BORDER + GLYPH_LEFT, glyphY, helmetColor(theme, platform));
  ctx.font = nameFont;
  ctx.fillStyle = nameStyle.ink;
  ctx.textBaseline = "middle";
  ctx.direction = textDirection(title);
  ctx.textAlign = "left";
  ctx.fillText(title, nameX, BUBBLE_BORDER + BUBBLE_NAME_ROW / 2 + 1);
  ctx.font = font;
  ctx.fillStyle = style.ink;
  ctx.textBaseline = "top";
  // Right-to-left text starts at the right edge, with its punctuation where its readers expect it.
  ctx.direction = textDirection(text);
  const rtl: boolean = ctx.direction === "rtl";
  ctx.textAlign = rtl ? "right" : "left";
  const textX: number = rtl ? width - BUBBLE_BORDER - BUBBLE_PAD_X : BUBBLE_BORDER + BUBBLE_PAD_X;
  const textY: number = BUBBLE_BORDER + BUBBLE_NAME_ROW + 1;
  lines.forEach((line: string, i: number): void => ctx.fillText(line, textX, textY + i * step));
  return element;
}

/**
 * The text lines a bubble may have when `room` design px are free between the top of the layer and the tip of its
 * tail: the theme's maximum, fewer near the top edge, and at least one.
 */
export function bubbleLines(theme: PlaygroundTheme, room: number): number {
  const fit: number = Math.floor((room - BUBBLE_FRAME - BUBBLE_TAIL) / lineHeight(theme));
  return Math.min(theme.label.bubble.maxLines, Math.max(1, fit));
}

/** The widest bubble on a layer `canvasWidth` design px wide: the theme's maximum, a third of a narrow layer. */
export function bubbleCap(theme: PlaygroundTheme, canvasWidth: number): number {
  return Math.min(theme.label.bubble.maxWidth, Math.round(canvasWidth / 3));
}

/** A bubble to place: the x of its speaker's head and its width. */
export interface BubbleItem {
  x: number;
  width: number;
}

/** A placed bubble: `index` into the items, its left edge and width, and the x of its tail. */
export interface BubbleSlot {
  index: number;
  left: number;
  width: number;
  tail: number;
}

/** A row of bubbles side by side: slots[from..to). `wish` is the sum of the left edges each member wants. */
interface Row {
  from: number;
  to: number;
  width: number;
  wish: number;
  left: number;
}

/** A point in design px: the top of a speaker's head, or an end of a leader line. */
type Head = { x: number; y: number };

/**
 * Places bubbles side by side, oldest item first. Each starts centred on its speaker. Bubbles that would overlap join
 * a row, and the row centres on its speakers, inside the layer. When the bubbles do not fit next to each other, the
 * oldest go. The slots come back oldest first, so the newest draws last.
 */
export function layoutBubbles(items: readonly BubbleItem[], canvasWidth: number, cap: number): BubbleSlot[] {
  const gap: number = BUBBLE_GAP;
  const widths: number[] = items.map((item: BubbleItem): number => Math.min(item.width, cap, canvasWidth));
  let first = 0;
  const total = (from: number): number => widths.slice(from).reduce((sum: number, w: number) => sum + w + gap, -gap);
  while (first < items.length - 1 && total(first) > canvasWidth) first += 1;
  const slots: BubbleSlot[] = items
    .slice(first)
    .map((item: BubbleItem, k: number): BubbleSlot => {
      const width: number = widths[first + k];
      return { index: first + k, left: Math.round(item.x - width / 2), width, tail: item.x };
    })
    .sort((a: BubbleSlot, b: BubbleSlot): number => a.tail - b.tail || a.index - b.index);
  const place = (row: Row): Row => {
    const left: number = Math.round(row.wish / (row.to - row.from));
    return { ...row, left: Math.max(0, Math.min(left, canvasWidth - row.width)) };
  };
  const rows: Row[] = [];
  slots.forEach((slot: BubbleSlot, i: number): void => {
    let row: Row = place({ from: i, to: i + 1, width: slot.width, wish: slot.left, left: 0 });
    for (let prev = rows.at(-1); prev && prev.left + prev.width + gap > row.left; prev = rows.at(-1)) {
      rows.pop();
      const shift: number = prev.width + gap;
      row = place({
        from: prev.from,
        to: row.to,
        width: shift + row.width,
        wish: prev.wish + row.wish - shift * (row.to - row.from),
        left: 0,
      });
    }
    rows.push(row);
  });
  for (const row of rows) {
    let left: number = row.left;
    for (const slot of slots.slice(row.from, row.to)) {
      slot.left = left;
      left += slot.width + gap;
    }
  }
  for (const slot of slots) slot.tail = tailBase(slot, slot.tail);
  return slots.sort((a: BubbleSlot, b: BubbleSlot): number => a.index - b.index);
}

/** Where a tail leaves the bottom of a bubble: under `head`, kept TAIL_INSET from the corners. */
function tailBase(slot: { left: number; width: number }, head: number): number {
  const inset: number = Math.min(TAIL_INSET, slot.width / 2);
  return Math.min(Math.max(Math.round(head), slot.left + inset), slot.left + slot.width - inset);
}

/**
 * The tail of a bubble whose bottom is at `bottom`, from `base` towards the speaker's `head` (the label point, where a
 * tail ends): the x of its tip, and a leader line from the tip to just above the helmet when the head is more than
 * LEADER_MIN px to the side.
 */
export function tailGeometry(base: number, bottom: number, head: Head): { tip: number; leader: [Head, Head] | null } {
  const tip: number = Math.min(Math.max(head.x, base - 10), base + 10);
  const from: Head = { x: tip, y: bottom - BUBBLE_BORDER / 2 + BUBBLE_TAIL };
  const to: Head = { x: head.x, y: head.y + LEADER_DROP };
  const leader: [Head, Head] | null = Math.abs(head.x - base) > LEADER_MIN && to.y > from.y ? [from, to] : null;
  return { tip, leader };
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * The tail from the bubble bottom at `base` towards the speaker's head, over the bottom border. A speaker far to the
 * side also gets a thin leader line, in the bubble colours, from the tail to just above the head.
 */
function drawTail(
  ctx: CanvasRenderingContext2D,
  theme: PlaygroundTheme,
  base: number,
  bottom: number,
  head: Head,
): void {
  const { tip, leader } = tailGeometry(base, bottom, head);
  const y: number = bottom - BUBBLE_BORDER / 2;
  ctx.fillStyle = theme.label.bubble.fill;
  ctx.strokeStyle = theme.label.bubble.ink;
  ctx.lineJoin = "round";
  if (leader) {
    ctx.lineCap = "round";
    for (const [color, width] of [
      [theme.label.bubble.ink, 4],
      [theme.label.bubble.fill, 2],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(leader[0].x, leader[0].y);
      ctx.lineTo(leader[1].x, leader[1].y);
      ctx.stroke();
    }
    // A small dot over the speaker ends the leader, so it reads as pointing at that head.
    ctx.beginPath();
    ctx.arc(leader[1].x, leader[1].y, 3, 0, 2 * Math.PI);
    ctx.fillStyle = theme.label.bubble.fill;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme.label.bubble.ink;
    ctx.fill();
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.strokeStyle = theme.label.bubble.ink;
  }
  ctx.lineWidth = BUBBLE_BORDER;
  ctx.beginPath();
  ctx.moveTo(base - 7, y);
  ctx.lineTo(tip, y + BUBBLE_TAIL);
  ctx.lineTo(base + 7, y);
  ctx.fill();
  ctx.stroke();
  ctx.fillRect(base - 5, bottom - BUBBLE_BORDER - 1, 10, BUBBLE_BORDER + 1);
}

/** The space the badges take at the top right: bubbles under it start below `bottom` (both in canvas px). */
interface BadgeBand {
  left: number;
  bottom: number;
}

/**
 * Bubbles first in layout, then drawing: name tags, then bubbles, the newest last. A speaker's bubble carries its
 * name, so it has no tag. Bubbles stand side by side above their speakers, and a tag under a bubble does not draw.
 * A bubble under the badges starts below them, with fewer lines when needed.
 */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  view: PlaygroundView,
  theme: PlaygroundTheme,
  memory: RenderMemory,
  top: number,
  band: BadgeBand | null,
): void {
  const heads = new Map<number, Head>();
  for (const c of view.characters) {
    if (!theme.sequences[c.state] || !showsLabel(c)) continue;
    heads.set(c.id, {
      x: Math.round(snap(c.x) * PIXEL_SCALE),
      y: Math.round((snap(c.y) - theme.courier.anchor.y + 5) * PIXEL_SCALE) - 1,
    });
  }
  const byId = new Map<number, CharacterView>(view.characters.map((c: CharacterView) => [c.id, c]));
  const cap: number = bubbleCap(theme, ctx.canvas.width);
  const speaking: { c: CharacterView; text: string; head: Head; box: HTMLCanvasElement }[] = [];
  const bubbleOf = (c: CharacterView, text: string, lines: number, width: number): HTMLCanvasElement =>
    cached(memory, JSON.stringify(["b", c.platform, c.name, text, lines, width]), () =>
      bubble(theme, c.name, c.platform, text, lines, width),
    );
  for (const id of view.speakers) {
    const c: CharacterView | undefined = byId.get(id);
    const head: Head | undefined = heads.get(id);
    if (!c || !head || c.bubble === null) continue;
    speaking.push({ c, text: c.bubble, head, box: bubbleOf(c, c.bubble, bubbleLines(theme, head.y + top), cap) });
  }
  const slots: BubbleSlot[] = layoutBubbles(
    speaking.map((s) => ({ x: s.head.x, width: s.box.width })),
    ctx.canvas.width,
    cap,
  );
  const boxes: Box[] = slots.map((slot: BubbleSlot): Box => {
    const entry = speaking[slot.index];
    const floor: number = band && slot.left + slot.width > band.left ? band.bottom - top : -top;
    if (entry.head.y - entry.box.height - BUBBLE_TAIL < floor && floor > -top) {
      // No wider than its slot, so the layout of the row stays.
      entry.box = bubbleOf(entry.c, entry.text, bubbleLines(theme, entry.head.y - floor), slot.width);
      slot.width = entry.box.width;
      slot.tail = tailBase(slot, entry.head.x);
    }
    const height: number = entry.box.height + BUBBLE_TAIL;
    return { left: slot.left, top: Math.max(floor, entry.head.y - height), width: entry.box.width, height };
  });
  const shown = new Set<number>(slots.map((slot: BubbleSlot): number => speaking[slot.index].c.id));
  for (const c of view.characters) {
    const head: Head | undefined = heads.get(c.id);
    if (!head || shown.has(c.id)) continue;
    const tag: HTMLCanvasElement = cached(memory, JSON.stringify(["n", c.platform, c.name]), () =>
      nameTag(theme, c.name, c.platform),
    );
    const rect: Box = {
      left: head.x - Math.round(tag.width / 2),
      top: head.y - 1 - tag.height,
      width: tag.width,
      height: tag.height,
    };
    if (!boxes.some((b: Box): boolean => overlaps(rect, b))) ctx.drawImage(tag, rect.left, rect.top);
  }
  slots.forEach((slot: BubbleSlot, i: number): void => {
    const { box, head } = speaking[slot.index];
    const { left, top: y } = boxes[i];
    ctx.drawImage(box, left, y);
    drawTail(ctx, theme, slot.tail, y + box.height, head);
  });
}

/** Badges stand this far from the top right corner, and this far apart. */
const BADGE_MARGIN = 12;
const BADGE_SPACE = 8;

/** The test and paused badges, right to left from the top right corner: label, left edge and width in canvas px. */
function badgesOf(
  ctx: CanvasRenderingContext2D,
  view: PlaygroundView,
  theme: PlaygroundTheme,
  badges: DrawOptions["badges"],
): { label: string; left: number; width: number }[] {
  const texts: string[] = [view.mode.test ? badges.test : "", view.mode.paused ? badges.paused : ""].filter(Boolean);
  ctx.font = `600 ${theme.label.name.size}px ${theme.label.font}`;
  let right: number = ctx.canvas.width - BADGE_MARGIN;
  return texts.map((text: string) => {
    const label: string = cut(text, 24);
    const width: number = Math.ceil(ctx.measureText(label).width) + 20;
    right -= width + BADGE_SPACE;
    return { label, left: right + BADGE_SPACE, width };
  });
}

function drawBadges(
  ctx: CanvasRenderingContext2D,
  theme: PlaygroundTheme,
  placed: readonly { label: string; left: number; width: number }[],
): void {
  const size: number = theme.label.name.size;
  ctx.font = `600 ${size}px ${theme.label.font}`;
  ctx.textBaseline = "middle";
  ctx.direction = "ltr";
  ctx.textAlign = "left";
  for (const { label, left, width } of placed) {
    ctx.fillStyle = theme.label.badge.fill;
    ctx.beginPath();
    ctx.roundRect(left, BADGE_MARGIN, width, size + 12, 6);
    ctx.fill();
    ctx.fillStyle = theme.label.badge.ink;
    ctx.fillText(label, left + 10, BADGE_MARGIN + (size + 12) / 2 + 1);
  }
}

/**
 * Draws one playground moment on a canvas at design size (world size x PIXEL_SCALE), anchored to the bottom.
 * Sprites draw in world pixels, scaled without smoothing; labels and badges draw at design resolution.
 */
export function draw(
  ctx: CanvasRenderingContext2D,
  view: PlaygroundView,
  theme: PlaygroundTheme,
  atlas: Atlas,
  now: number,
  memory: RenderMemory,
  options: DrawOptions,
): void {
  const ticks: number = memory.last === 0 ? 0 : Math.min(10, (now - memory.last) / MS_PER_TICK);
  memory.last = now;
  if (options.reduced) memory.particles = [];
  else {
    moveParticles(memory, ticks);
    spawnEffects(view, theme, atlas, memory);
  }
  const top: number = ctx.canvas.height - view.world.height * PIXEL_SCALE;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(PIXEL_SCALE, 0, 0, PIXEL_SCALE, 0, top);
  drawWorld(ctx, view, theme, atlas, now, options.reduced);
  drawRopes(ctx, view, theme, options.reduced);
  drawCharacters(ctx, view, theme, atlas, options.reduced);
  drawGear(ctx, view, theme, now);
  drawParticles(ctx, memory);
  drawMarks(ctx, view, theme);
  const badges = badgesOf(ctx, view, theme, options.badges);
  const band: BadgeBand | null =
    badges.length === 0
      ? null
      : {
          left: Math.min(...badges.map((badge) => badge.left)) - BUBBLE_GAP,
          bottom: BADGE_MARGIN + theme.label.name.size + 12 + BUBBLE_GAP,
        };
  ctx.setTransform(1, 0, 0, 1, 0, top);
  drawLabels(ctx, view, theme, memory, top, band);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawBadges(ctx, theme, badges);
}
