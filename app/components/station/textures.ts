import * as THREE from "three";

/* Procedural surfaces for the broadcast station. Everything is painted onto canvases at start-up,
   so the model ships without image assets. Each surface returns a colour map plus matching bump
   and roughness maps, drawn in the same pass so seams, rivets, chips and rust line up. */

export type Random = () => number;

export function random(seed: number): Random {
  let state = seed >>> 0;
  return (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export interface Surface {
  map: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
  rough: THREE.CanvasTexture;
}

function layer(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return [canvas, canvas.getContext("2d")!];
}

function texture(canvas: HTMLCanvasElement, color: boolean): THREE.CanvasTexture {
  const result = new THREE.CanvasTexture(canvas);
  result.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  result.wrapS = result.wrapT = THREE.RepeatWrapping;
  result.anisotropy = 8;
  return result;
}

function surface(color: HTMLCanvasElement, bump: HTMLCanvasElement, rough: HTMLCanvasElement): Surface {
  return {
    map: texture(color, true),
    bump: texture(bump, false),
    rough: texture(rough, false),
  };
}

/** Clone a surface with its own repeat, sharing the painted canvases. */
export function repeat(source: Surface, x: number, y: number): Surface {
  const clone = (t: THREE.CanvasTexture): THREE.CanvasTexture => {
    const c = t.clone();
    c.repeat.set(x, y);
    c.needsUpdate = true;
    return c;
  };
  return {
    map: clone(source.map),
    bump: clone(source.bump),
    rough: clone(source.rough),
  };
}

function blob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
}

function grey(v: number): string {
  const c = Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${c},${c},${c})`;
}

function shade(hex: string, amount: number): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + amount)));
  return "#" + c.getHexString();
}

function chipShape(ctx: CanvasRenderingContext2D, rnd: Random, x: number, y: number, r: number): void {
  ctx.beginPath();
  const points = 7 + Math.floor(rnd() * 5);
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const d = r * (0.45 + rnd() * 0.75);
    if (i === 0) ctx.moveTo(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7);
    else ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7);
  }
  ctx.closePath();
}

export interface PaintOptions {
  base: string;
  seed: number;
  rust?: number;
  chips?: number;
  seamsX?: number;
  seamsY?: number;
  rivets?: boolean;
  grime?: number;
  roughness?: number;
}

/** Enamel over steel: mottled paint, panel seams, rivets, chipped edges and rust runs. */
export function paintedMetal(o: PaintOptions): Surface {
  const W = 1024,
    H = 512;
  const rnd = random(o.seed);
  const [c, a] = layer(W, H);
  const [b, bb] = layer(W, H);
  const [r, rr] = layer(W, H);
  const rust = o.rust ?? 0.6,
    chips = o.chips ?? 0.6,
    grime = o.grime ?? 0.6;
  const baseRough = (o.roughness ?? 0.55) * 255;
  a.fillStyle = o.base;
  a.fillRect(0, 0, W, H);
  bb.fillStyle = grey(128);
  bb.fillRect(0, 0, W, H);
  rr.fillStyle = grey(baseRough);
  rr.fillRect(0, 0, W, H);
  // Mottled, sun-faded enamel.
  for (let i = 0; i < 260; i++) {
    const x = rnd() * W,
      y = rnd() * H,
      rad = 20 + rnd() * 90;
    blob(a, x, y, rad, rnd() > 0.5 ? shade(o.base, 0.07) : shade(o.base, -0.08), 0.18);
    blob(rr, x, y, rad, grey(baseRough + (rnd() - 0.5) * 60), 0.3);
  }
  for (let i = 0; i < 9000; i++) {
    const x = rnd() * W,
      y = rnd() * H,
      v = rnd();
    a.fillStyle = v > 0.5 ? "rgba(255,248,230,.08)" : "rgba(20,12,6,.1)";
    a.fillRect(x, y, 1.5, 1.5);
    bb.fillStyle = grey(110 + v * 40);
    bb.fillRect(x, y, 1.5, 1.5);
  }
  // Grime settles toward the bottom of every panel.
  const g = a.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(0.7, `rgba(40,26,12,${0.12 * grime})`);
  g.addColorStop(1, `rgba(30,18,8,${0.4 * grime})`);
  a.fillStyle = g;
  a.fillRect(0, 0, W, H);
  // Panel seams with a lit lip and riveted edges.
  const sx = o.seamsX ?? 6,
    sy = o.seamsY ?? 2;
  const seamPoints: Array<[number, number]> = [];
  function paintSeams(): void {
    for (let i = 0; i < sx; i++) {
      const x = ((i + 0.5) * W) / sx;
      a.fillStyle = "rgba(15,10,6,.55)";
      a.fillRect(x - 1.5, 0, 3, H);
      a.fillStyle = "rgba(255,240,210,.14)";
      a.fillRect(x + 2, 0, 1.5, H);
      bb.fillStyle = grey(40);
      bb.fillRect(x - 2, 0, 4, H);
      if (o.rivets !== false) for (let y = 10; y < H; y += 24) seamPoints.push([x + 9, y], [x - 9, y]);
    }
    for (let j = 0; j < sy; j++) {
      const y = ((j + 0.5) * H) / sy;
      a.fillStyle = "rgba(15,10,6,.55)";
      a.fillRect(0, y - 1.5, W, 3);
      a.fillStyle = "rgba(255,240,210,.14)";
      a.fillRect(0, y + 2, W, 1.5);
      bb.fillStyle = grey(40);
      bb.fillRect(0, y - 2, W, 4);
      if (o.rivets !== false) for (let x = 12; x < W; x += 24) seamPoints.push([x, y + 9]);
    }
  }
  paintSeams();
  for (const [x, y] of seamPoints) {
    a.fillStyle = "rgba(10,6,3,.45)";
    a.beginPath();
    a.arc(x + 1, y + 1.5, 4, 0, Math.PI * 2);
    a.fill();
    a.fillStyle = shade(o.base, 0.05);
    a.beginPath();
    a.arc(x, y, 3.4, 0, Math.PI * 2);
    a.fill();
    a.fillStyle = "rgba(255,250,235,.45)";
    a.beginPath();
    a.arc(x - 1, y - 1, 1.2, 0, Math.PI * 2);
    a.fill();
    bb.fillStyle = grey(235);
    bb.beginPath();
    bb.arc(x, y, 3.6, 0, Math.PI * 2);
    bb.fill();
  }
  function paintChips(): void {
    // Chipped enamel exposing dark primer and bare metal.
    for (let i = 0; i < chips * 90; i++) {
      const near =
        seamPoints.length && rnd() > 0.4
          ? seamPoints[Math.floor(rnd() * seamPoints.length)]
          : ([rnd() * W, rnd() * H] as [number, number]);
      const x = near[0] + (rnd() - 0.5) * 20,
        y = near[1] + (rnd() - 0.5) * 20,
        rad = 2 + Math.pow(rnd(), 2) * 16;
      chipShape(a, rnd, x + 1, y + 1, rad * 1.12);
      a.fillStyle = shade(o.base, 0.1);
      a.fill();
      chipShape(a, rnd, x, y, rad);
      a.fillStyle = rnd() > 0.3 ? "#3b2d22" : "#7d6a55";
      a.fill();
      chipShape(bb, rnd, x, y, rad);
      bb.fillStyle = grey(85);
      bb.fill();
      chipShape(rr, rnd, x, y, rad);
      rr.fillStyle = grey(200);
      rr.fill();
    }
  }
  paintChips();
  // Rust runs that start at seams and rivets and drip downward.
  for (let i = 0; i < rust * 70; i++) {
    const start =
      seamPoints.length && rnd() > 0.3
        ? seamPoints[Math.floor(rnd() * seamPoints.length)]
        : ([rnd() * W, rnd() * H] as [number, number]);
    const x = start[0] + (rnd() - 0.5) * 6,
      y = start[1],
      w = 1.5 + rnd() * 6,
      len = 25 + rnd() * 170;
    const run = a.createLinearGradient(0, y, 0, y + len);
    run.addColorStop(0, "rgba(122,58,22,.62)");
    run.addColorStop(0.35, "rgba(105,52,22,.32)");
    run.addColorStop(1, "rgba(90,45,20,0)");
    a.fillStyle = run;
    a.beginPath();
    a.moveTo(x - w / 2, y);
    a.quadraticCurveTo(x + (rnd() - 0.5) * 8, y + len * 0.6, x, y + len);
    a.quadraticCurveTo(x + w / 2 + (rnd() - 0.5) * 6, y + len * 0.5, x + w / 2, y);
    a.fill();
    blob(a, x, y, 4 + rnd() * 9, "#7a3412", 0.7);
    blob(rr, x, y + len * 0.3, w + 10, grey(235), 0.5);
    blob(bb, x, y, 5, grey(95), 0.6);
  }
  return surface(c, b, r);
}

/** Aged brass: warm metal with smudges, a little verdigris and fine polishing scratches. */
export function agedBrass(seed: number, base: string = "#b8894a"): Surface {
  const W = 512,
    H = 512;
  const rnd = random(seed);
  const [c, a] = layer(W, H);
  const [b, bb] = layer(W, H);
  const [r, rr] = layer(W, H);
  a.fillStyle = base;
  a.fillRect(0, 0, W, H);
  bb.fillStyle = grey(128);
  bb.fillRect(0, 0, W, H);
  rr.fillStyle = grey(95);
  rr.fillRect(0, 0, W, H);
  for (let i = 0; i < 220; i++) {
    const x = rnd() * W,
      y = rnd() * H,
      rad = 10 + rnd() * 60;
    blob(a, x, y, rad, rnd() > 0.55 ? "#e6c07a" : "#5e4120", 0.22);
    blob(rr, x, y, rad, grey(70 + rnd() * 110), 0.35);
  }
  for (let i = 0; i < 40; i++) {
    const x = rnd() * W,
      y = rnd() * H,
      rad = 4 + rnd() * 18;
    blob(a, x, y, rad, "#4f7660", 0.35);
    blob(rr, x, y, rad, grey(220), 0.6);
  }
  for (let i = 0; i < 260; i++) {
    const x = rnd() * W,
      y = rnd() * H,
      len = 10 + rnd() * 60,
      ang = (rnd() - 0.5) * 0.5;
    a.strokeStyle = "rgba(255,236,190,.16)";
    a.lineWidth = 0.7;
    a.beginPath();
    a.moveTo(x, y);
    a.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    a.stroke();
    bb.strokeStyle = grey(150);
    bb.lineWidth = 0.7;
    bb.beginPath();
    bb.moveTo(x, y);
    bb.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    bb.stroke();
  }
  return surface(c, b, r);
}

/** Radial deck of riveted brass and copper plates, worn bright along the walking line. */
export function deckPlates(seed: number): Surface {
  const S = 1024,
    C = S / 2;
  const rnd = random(seed);
  const [c, a] = layer(S, S);
  const [b, bb] = layer(S, S);
  const [r, rr] = layer(S, S);
  a.fillStyle = "#3e3d39";
  a.fillRect(0, 0, S, S);
  bb.fillStyle = grey(128);
  bb.fillRect(0, 0, S, S);
  rr.fillStyle = grey(140);
  rr.fillRect(0, 0, S, S);
  const rings = [0, 120, 250, 370, 470, 512];
  const tones = ["#7b7a72", "#6f6d66", "#85827a", "#66655f", "#76736b", "#5f5e59"];
  function paintSectorEdge(k: number, a0: number, r0: number, r1: number): void {
    if (k > 0) {
      for (const ctx of [a, bb]) {
        ctx.strokeStyle = ctx === a ? "rgba(20,12,6,.7)" : grey(30);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(C + Math.cos(a0) * r0, C + Math.sin(a0) * r0);
        ctx.lineTo(C + Math.cos(a0) * r1, C + Math.sin(a0) * r1);
        ctx.stroke();
      }
    }
  }
  function paintRing(k: number): void {
    const r0 = rings[k],
      r1 = rings[k + 1];
    const count = k === 0 ? 1 : 8 + k * 6;
    for (let i = 0; i < count; i++) {
      const a0 = (i / count) * Math.PI * 2,
        a1 = ((i + 1) / count) * Math.PI * 2;
      a.beginPath();
      a.arc(C, C, r1, a0, a1);
      a.arc(C, C, r0, a1, a0, true);
      a.closePath();
      a.fillStyle = tones[Math.floor(rnd() * tones.length)];
      a.fill();
      rr.beginPath();
      rr.arc(C, C, r1, a0, a1);
      rr.arc(C, C, r0, a1, a0, true);
      rr.closePath();
      rr.fillStyle = grey(110 + rnd() * 70);
      rr.fill();
      paintSectorEdge(k, a0, r0, r1);
    }
    for (const ctx of [a, bb]) {
      ctx.strokeStyle = ctx === a ? "rgba(20,12,6,.7)" : grey(30);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(C, C, r1, 0, Math.PI * 2);
      ctx.stroke();
    }
    const around = Math.floor((r1 * Math.PI * 2) / 26);
    for (let i = 0; i < around; i++) {
      const ang = (i / around) * Math.PI * 2,
        rad = r1 - 9;
      const x = C + Math.cos(ang) * rad,
        y = C + Math.sin(ang) * rad;
      a.fillStyle = "rgba(0,0,0,.4)";
      a.beginPath();
      a.arc(x + 1, y + 1, 3.6, 0, 7);
      a.fill();
      a.fillStyle = "#c49a55";
      a.beginPath();
      a.arc(x, y, 3, 0, 7);
      a.fill();
      bb.fillStyle = grey(230);
      bb.beginPath();
      bb.arc(x, y, 3.4, 0, 7);
      bb.fill();
    }
  }
  for (let k = 0; k < rings.length - 1; k++) {
    paintRing(k);
  }
  for (let i = 0; i < 400; i++) {
    const x = rnd() * S,
      y = rnd() * S,
      rad = 8 + rnd() * 50;
    let color = "#22201c";
    if (rnd() <= 0.5) color = rnd() > 0.6 ? "#7a3c1c" : "#a8a59c";
    blob(a, x, y, rad, color, 0.16);
  }
  // Polished walking ring: brighter and smoother where feet have worn the patina.
  a.globalAlpha = 0.22;
  a.strokeStyle = "#b9b6ab";
  a.lineWidth = 70;
  a.beginPath();
  a.arc(C, C, 420, 0, Math.PI * 2);
  a.stroke();
  a.globalAlpha = 1;
  rr.globalAlpha = 0.5;
  rr.strokeStyle = grey(70);
  rr.lineWidth = 70;
  rr.beginPath();
  rr.arc(C, C, 420, 0, Math.PI * 2);
  rr.stroke();
  rr.globalAlpha = 1;
  const result = surface(c, b, r);
  for (const t of [result.map, result.bump, result.rough]) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return result;
}

/** Oiled plank floor or desk veneer. */
export function woodPlanks(seed: number, base: string = "#6b3f24", planks: number = 8): Surface {
  const W = 512,
    H = 512;
  const rnd = random(seed);
  const [c, a] = layer(W, H);
  const [b, bb] = layer(W, H);
  const [r, rr] = layer(W, H);
  bb.fillStyle = grey(128);
  bb.fillRect(0, 0, W, H);
  rr.fillStyle = grey(120);
  rr.fillRect(0, 0, W, H);
  const ph = H / planks;
  for (let i = 0; i < planks; i++) {
    a.fillStyle = shade(base, (rnd() - 0.5) * 0.08);
    a.fillRect(0, i * ph, W, ph);
    for (let j = 0; j < 26; j++) {
      const y = i * ph + rnd() * ph;
      a.strokeStyle = `rgba(30,15,6,${0.08 + rnd() * 0.18})`;
      a.lineWidth = 0.6 + rnd() * 1.6;
      a.beginPath();
      a.moveTo(0, y);
      for (let x = 0; x <= W; x += 32) a.lineTo(x, y + Math.sin(x * 0.02 + j) * 2.5);
      a.stroke();
    }
    a.fillStyle = "rgba(15,8,3,.7)";
    a.fillRect(0, i * ph, W, 2);
    bb.fillStyle = grey(50);
    bb.fillRect(0, i * ph, W, 3);
    const cut = rnd() * W;
    a.fillRect(cut, i * ph, 2, ph);
    bb.fillRect(cut, i * ph, 3, ph);
  }
  return surface(c, b, r);
}

/** Diamond-tufted leather for the studio walls and chair. */
export function tufted(seed: number, base: string = "#7a3a22"): Surface {
  const S = 512;
  const rnd = random(seed);
  const [c, a] = layer(S, S);
  const [b, bb] = layer(S, S);
  const [r, rr] = layer(S, S);
  a.fillStyle = base;
  a.fillRect(0, 0, S, S);
  bb.fillStyle = grey(110);
  bb.fillRect(0, 0, S, S);
  rr.fillStyle = grey(110);
  rr.fillRect(0, 0, S, S);
  const step = S / 4;
  for (let y = 0; y <= 4; y++) {
    for (let x = 0; x <= 4; x++) {
      const cx = x * step + (y % 2 ? step / 2 : 0),
        cy = y * step;
      blob(a, cx, cy, step * 0.62, shade(base, 0.1), 0.55);
      blob(bb, cx, cy, step * 0.62, grey(200), 0.9);
      a.fillStyle = "#2a120a";
      a.beginPath();
      a.arc(cx, cy - step / 2, 5, 0, 7);
      a.fill();
      bb.fillStyle = grey(20);
      bb.beginPath();
      bb.arc(cx, cy - step / 2, 7, 0, 7);
      bb.fill();
    }
  }
  for (let i = 0; i < 3000; i++) {
    a.fillStyle = `rgba(0,0,0,${rnd() * 0.08})`;
    a.fillRect(rnd() * S, rnd() * S, 2, 2);
  }
  return surface(c, b, r);
}

export function hazard(): THREE.CanvasTexture {
  const [c, a] = layer(256, 64);
  a.fillStyle = "#d9a527";
  a.fillRect(0, 0, 256, 64);
  a.fillStyle = "#16191a";
  for (let x = -64; x < 300; x += 40) {
    a.beginPath();
    a.moveTo(x, 64);
    a.lineTo(x + 20, 64);
    a.lineTo(x + 84, 0);
    a.lineTo(x + 64, 0);
    a.fill();
  }
  return texture(c, true);
}

/** Soft cloud puff used for fog banks and steam. */
export function cloud(seed: number): THREE.CanvasTexture {
  const S = 256;
  const rnd = random(seed);
  const [c, a] = layer(S, S);
  for (let i = 0; i < 26; i++) {
    const ang = rnd() * Math.PI * 2,
      d = rnd() * 60;
    blob(a, S / 2 + Math.cos(ang) * d, S / 2 + Math.sin(ang) * d, 40 + rnd() * 60, "#ffffff", 0.22);
  }
  a.globalCompositeOperation = "destination-in";
  const mask = a.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  mask.addColorStop(0, "rgba(0,0,0,1)");
  mask.addColorStop(0.65, "rgba(0,0,0,.6)");
  mask.addColorStop(1, "rgba(0,0,0,0)");
  a.fillStyle = mask;
  a.fillRect(0, 0, S, S);
  const t = texture(c, true);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export function glow(inner: string = "rgba(255,226,170,1)"): THREE.CanvasTexture {
  const [c, a] = layer(128, 128);
  const g = a.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(0.22, "rgba(255,190,100,.35)");
  g.addColorStop(1, "rgba(255,170,60,0)");
  a.fillStyle = g;
  a.fillRect(0, 0, 128, 128);
  const t = texture(c, true);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Instrument face: cream dial with ticks and a red zone; `amber` gives a backlit VU meter. */
export function dial(amber: boolean): THREE.CanvasTexture {
  const S = 256;
  const [c, a] = layer(S, S);
  a.fillStyle = amber ? "#f2c46b" : "#efe4c6";
  a.beginPath();
  a.arc(128, 128, 126, 0, 7);
  a.fill();
  if (amber) {
    const g = a.createRadialGradient(128, 160, 10, 128, 128, 140);
    g.addColorStop(0, "rgba(255,240,190,.9)");
    g.addColorStop(1, "rgba(190,110,30,.6)");
    a.fillStyle = g;
    a.fill();
  }
  a.strokeStyle = "#2b2116";
  a.lineCap = "round";
  for (let i = 0; i <= 20; i++) {
    const ang = Math.PI * (1.15 + (i / 20) * 0.7);
    const r0 = i % 5 ? 92 : 80;
    a.lineWidth = i % 5 ? 3 : 6;
    a.strokeStyle = i > 15 ? "#b4271a" : "#2b2116";
    a.beginPath();
    a.moveTo(128 + Math.cos(ang) * r0, 150 + Math.sin(ang) * r0);
    a.lineTo(128 + Math.cos(ang) * 108, 150 + Math.sin(ang) * 108);
    a.stroke();
  }
  a.lineWidth = 10;
  a.strokeStyle = "#b4271a";
  a.beginPath();
  a.arc(128, 150, 118, Math.PI * 1.71, Math.PI * 1.85);
  a.stroke();
  a.fillStyle = "#2b2116";
  a.font = "700 30px sans-serif";
  a.textAlign = "center";
  a.fillText(amber ? "VU" : "PSI", 128, 205);
  const t = texture(c, true);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Glow mask for a dial's red zone: the red ticks and arc on black, for an emissive map. */
export function dialRedZone(): THREE.CanvasTexture {
  const [c, a] = layer(256, 256);
  a.fillStyle = "#000000";
  a.fillRect(0, 0, 256, 256);
  a.strokeStyle = "#ffffff";
  a.lineCap = "round";
  for (let i = 16; i <= 20; i++) {
    const ang = Math.PI * (1.15 + (i / 20) * 0.7);
    const r0 = i % 5 ? 92 : 80;
    a.lineWidth = i % 5 ? 3 : 6;
    a.beginPath();
    a.moveTo(128 + Math.cos(ang) * r0, 150 + Math.sin(ang) * r0);
    a.lineTo(128 + Math.cos(ang) * 108, 150 + Math.sin(ang) * 108);
    a.stroke();
  }
  a.lineWidth = 10;
  a.beginPath();
  a.arc(128, 150, 118, Math.PI * 1.71, Math.PI * 1.85);
  a.stroke();
  const t = texture(c, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Horizontal slot grille for the classic desk microphone. */
export function grille(): THREE.CanvasTexture {
  const [c, a] = layer(64, 512);
  a.fillStyle = "#e8e8e4";
  a.fillRect(0, 0, 64, 512);
  a.fillStyle = "#050607";
  for (let y = 60; y < 452; y += 22) a.fillRect(0, y, 64, 12);
  const t = texture(c, true);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Tape reel face: aluminium flange with three cut-outs. */
export function reel(): THREE.CanvasTexture {
  const S = 256;
  const [c, a] = layer(S, S);
  a.fillStyle = "#c9ccc9";
  a.beginPath();
  a.arc(128, 128, 126, 0, 7);
  a.fill();
  a.fillStyle = "#5a3a22";
  a.beginPath();
  a.arc(128, 128, 92, 0, 7);
  a.fill();
  a.fillStyle = "#d9dcd8";
  a.beginPath();
  a.arc(128, 128, 40, 0, 7);
  a.fill();
  a.fillStyle = "#1a1c1d";
  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * Math.PI * 2;
    a.beginPath();
    a.arc(128 + Math.cos(ang) * 66, 128 + Math.sin(ang) * 66, 22, 0, 7);
    a.fill();
  }
  a.beginPath();
  a.arc(128, 128, 9, 0, 7);
  a.fill();
  const t = texture(c, true);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Studio clock face. */
export function clockFace(): THREE.CanvasTexture {
  const [c, a] = layer(256, 256);
  a.fillStyle = "#efe4c6";
  a.beginPath();
  a.arc(128, 128, 126, 0, 7);
  a.fill();
  a.strokeStyle = "#2b2116";
  for (let i = 0; i < 12; i++) {
    const ang = (i / 12) * Math.PI * 2;
    a.lineWidth = i % 3 ? 4 : 8;
    a.beginPath();
    a.moveTo(128 + Math.cos(ang) * 92, 128 + Math.sin(ang) * 92);
    a.lineTo(128 + Math.cos(ang) * 112, 128 + Math.sin(ang) * 112);
    a.stroke();
  }
  const t = texture(c, true);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Page-matching backdrop: deep teal with a lit haze behind the station. */
export function backdrop(): THREE.CanvasTexture {
  const [c, a] = layer(1024, 640);
  a.fillStyle = "#061a1e";
  a.fillRect(0, 0, 1024, 640);
  blob(a, 640, 280, 560, "#1d4f4d", 0.95);
  blob(a, 700, 250, 300, "#2c6763", 0.55);
  blob(a, 900, 470, 260, "#244f4b", 0.5);
  blob(a, 220, 520, 300, "#173d3c", 0.5);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Dark fluted wall panelling for the studio, with vertical channels and a faint sheen. */
export function flutes(seed: number): Surface {
  const W = 512,
    H = 512;
  const rnd = random(seed);
  const [c, a] = layer(W, H);
  const [b, bb] = layer(W, H);
  const [r, rr] = layer(W, H);
  const step = 16;
  for (let x = 0; x < W; x += step) {
    const g = a.createLinearGradient(x, 0, x + step, 0);
    g.addColorStop(0, "#1d2624");
    g.addColorStop(0.35, "#3a4744");
    g.addColorStop(0.6, "#2b3533");
    g.addColorStop(1, "#151c1b");
    a.fillStyle = g;
    a.fillRect(x, 0, step, H);
    const h = bb.createLinearGradient(x, 0, x + step, 0);
    h.addColorStop(0, grey(40));
    h.addColorStop(0.5, grey(215));
    h.addColorStop(1, grey(40));
    bb.fillStyle = h;
    bb.fillRect(x, 0, step, H);
  }
  rr.fillStyle = grey(120);
  rr.fillRect(0, 0, W, H);
  for (let i = 0; i < 120; i++)
    blob(a, rnd() * W, rnd() * H, 10 + rnd() * 40, rnd() > 0.5 ? "#5a4630" : "#0c1010", 0.12);
  return surface(c, b, r);
}

/** Face of a rack of broadcast equipment: brushed panels, amber meters, knobs and a tuning dial.
    Returns the colour map and a matching emissive map in which only the meter windows glow. */
export function rackFace(): {
  map: THREE.CanvasTexture;
  glow: THREE.CanvasTexture;
} {
  const W = 512,
    H = 1024;
  const [c, a] = layer(W, H);
  const [e, ee] = layer(W, H);
  a.fillStyle = "#1b1f1e";
  a.fillRect(0, 0, W, H);
  ee.fillStyle = "#000";
  ee.fillRect(0, 0, W, H);
  const units = [180, 200, 160, 220, 200];
  let y = 12;
  const meter = (x: number, yy: number, w: number, h: number): void => {
    for (const ctx of [a, ee]) {
      const g = ctx.createLinearGradient(0, yy, 0, yy + h);
      g.addColorStop(0, "#ffd88a");
      g.addColorStop(1, "#e8902a");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(x, yy, w, h, 8);
      ctx.fill();
      ctx.strokeStyle = "#3a2412";
      ctx.lineWidth = 2;
      for (let i = 0; i <= 8; i++) {
        const ang = Math.PI * (1.2 + (i / 8) * 0.6);
        ctx.beginPath();
        ctx.moveTo(x + w / 2 + Math.cos(ang) * h * 0.55, yy + h * 0.95 + Math.sin(ang) * h * 0.55);
        ctx.lineTo(x + w / 2 + Math.cos(ang) * h * 0.72, yy + h * 0.95 + Math.sin(ang) * h * 0.72);
        ctx.stroke();
      }
      ctx.strokeStyle = "#2a1508";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x + w / 2, yy + h * 0.95);
      ctx.lineTo(x + w * 0.68, yy + h * 0.25);
      ctx.stroke();
    }
    a.strokeStyle = "#b8955a";
    a.lineWidth = 5;
    a.beginPath();
    a.roundRect(x - 3, yy - 3, w + 6, h + 6, 10);
    a.stroke();
  };
  const knob = (x: number, yy: number, r: number): void => {
    a.fillStyle = "#0d0f0f";
    a.beginPath();
    a.arc(x, yy, r, 0, TAU2);
    a.fill();
    a.fillStyle = "#2c3030";
    a.beginPath();
    a.arc(x - r * 0.2, yy - r * 0.2, r * 0.7, 0, TAU2);
    a.fill();
    a.strokeStyle = "#efe3c4";
    a.lineWidth = 3;
    a.beginPath();
    a.moveTo(x, yy);
    a.lineTo(x + r * 0.6, yy - r * 0.6);
    a.stroke();
  };
  function paintIndicators(): void {
    for (let k = 0; k < 4; k++) {
      for (const ctx of [a, ee]) {
        ctx.fillStyle = k % 2 ? "#ff5a30" : "#7cff9a";
        ctx.beginPath();
        ctx.arc(430, y + 40 + k * 22, 6, 0, TAU2);
        ctx.fill();
      }
    }
  }
  function paintRadio(): void {
    for (const ctx of [a, ee]) {
      ctx.fillStyle = "#ffcf7a";
      ctx.fillRect(50, y + 30, W - 100, 56);
    }
    a.fillStyle = "#3a2412";
    a.font = "700 22px sans-serif";
    a.textAlign = "center";
    ["88", "92", "96", "100", "104", "108"].forEach((t: string, k: number): void => {
      a.fillText(t, 80 + k * 70, y + 66);
    });
    a.fillStyle = "#b4271a";
    a.fillRect(360, y + 30, 4, 56);
    for (let k = 0; k < 4; k++) knob(90 + k * 110, y + 135, 22);
  }
  function paintControls(i: number, h: number): void {
    if (i === 1) {
      paintRadio();
    } else if (i === 3) {
      for (let k = 0; k < 3; k++) meter(40 + k * 150, y + 30, 120, 80);
      for (let k = 0; k < 6; k++) knob(60 + k * 78, y + 160, 18);
    } else {
      for (let k = 0; k < 2; k++) meter(60 + k * 220, y + 26, 150, 90);
      for (let k = 0; k < 5; k++) knob(70 + k * 92, y + h - 50, 17);
      if (i === 0) paintIndicators();
    }
  }
  units.forEach((h: number, i: number): void => {
    const g = a.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, i % 2 ? "#8d8a80" : "#b5ad97");
    g.addColorStop(1, i % 2 ? "#6f6c63" : "#968e78");
    a.fillStyle = g;
    a.fillRect(10, y, W - 20, h - 10);
    a.fillStyle = "rgba(0,0,0,.35)";
    a.fillRect(10, y + h - 14, W - 20, 4);
    for (const sx of [24, W - 24])
      for (const sy of [y + 16, y + h - 26]) {
        a.fillStyle = "#3b3b36";
        a.beginPath();
        a.arc(sx, sy, 6, 0, TAU2);
        a.fill();
      }
    paintControls(i, h);
    y += h;
  });
  return { map: texture(c, true), glow: texture(e, true) };
}
const TAU2 = Math.PI * 2;
