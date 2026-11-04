import * as THREE from "three";

/* An original retro public-service poster for the studio wall: two-tone slate and cream, embossed
   lettering, a storm of static up top and the station microphone in a roundel. Painted large and
   mipmapped so it stays crisp when the camera is far away and clean when it is close. */

const W = 512;
const H = 700;
const SLATE = "#4d7486";
const CREAM = "#f3d793";
const PALE = "#c9d3d6";
const WHITE = "#fbf7ec";
const INK = "#18191a";

type Ctx = CanvasRenderingContext2D;

function embossed(a: Ctx, text: string, y: number, size: number, family: string): void {
  a.font = `700 ${size}px ${family}`;
  a.textAlign = "center";
  a.textBaseline = "middle";
  a.fillStyle = "rgba(0,0,0,0.35)";
  a.fillText(text, W / 2 + 3, y + 4, W - 40);
  a.fillStyle = "#fff4d0";
  a.fillText(text, W / 2 - 1, y - 1, W - 40);
  a.fillStyle = CREAM;
  a.fillText(text, W / 2, y, W - 40);
}

function cloud(a: Ctx, x: number, y: number, s: number): void {
  a.beginPath();
  for (const [dx, dy, r] of [
    [-34, 6, 22],
    [-10, -10, 28],
    [22, -4, 24],
    [40, 10, 16],
    [0, 14, 22],
  ])
    a.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2);
  a.fill();
}

function bolt(a: Ctx, x: number, y: number, s: number): void {
  a.beginPath();
  a.moveTo(x, y);
  a.lineTo(x - 14 * s, y + 34 * s);
  a.lineTo(x - 2 * s, y + 32 * s);
  a.lineTo(x - 12 * s, y + 66 * s);
  a.lineTo(x + 14 * s, y + 22 * s);
  a.lineTo(x + 2 * s, y + 24 * s);
  a.lineTo(x + 10 * s, y);
  a.closePath();
  a.fill();
}

/** The upper scene: a broadcast mast beaming through storm clouds full of static. */
function skyline(a: Ctx): void {
  a.fillStyle = CREAM;
  a.strokeStyle = CREAM;
  a.lineCap = "round";
  a.lineWidth = 5;
  const mx = 120;
  a.beginPath();
  a.moveTo(mx - 34, 236);
  a.lineTo(mx, 120);
  a.lineTo(mx + 34, 236);
  for (let i = 0; i < 4; i++) {
    const y0 = 140 + i * 24;
    const w0 = 6 + i * 7;
    a.moveTo(mx - w0, y0);
    a.lineTo(mx + w0 + 7, y0 + 24);
    a.moveTo(mx + w0, y0);
    a.lineTo(mx - w0 - 7, y0 + 24);
  }
  a.stroke();
  a.beginPath();
  a.arc(mx, 112, 10, 0, Math.PI * 2);
  a.fill();
  a.lineWidth = 4;
  for (let i = 1; i <= 3; i++) {
    a.beginPath();
    a.arc(mx, 112, 14 + i * 16, -0.75, 0.75);
    a.stroke();
    a.beginPath();
    a.arc(mx, 112, 14 + i * 16, Math.PI - 0.75, Math.PI + 0.75);
    a.stroke();
  }
  cloud(a, 330, 128, 1.15);
  cloud(a, 430, 158, 0.85);
  bolt(a, 330, 150, 1.1);
  bolt(a, 438, 178, 0.75);
  for (const [x, y] of [
    [262, 196],
    [388, 214],
    [470, 120],
  ]) {
    a.beginPath();
    a.moveTo(x - 10, y);
    a.lineTo(x - 3, y - 7);
    a.lineTo(x + 3, y + 7);
    a.lineTo(x + 10, y);
    a.stroke();
  }
}

function outlined(a: Ctx, fill: string, width = 7): void {
  a.fillStyle = fill;
  a.fill();
  a.lineWidth = width;
  a.strokeStyle = INK;
  a.stroke();
}

/** The roundel: a big ribbon microphone on its yoke, outlined in ink like a print. */
function roundel(a: Ctx): void {
  const cx = W / 2;
  const cy = 420;
  a.beginPath();
  a.arc(cx, cy, 168, 0, Math.PI * 2);
  a.fillStyle = SLATE;
  a.fill();
  a.beginPath();
  a.arc(cx, cy, 146, 0, Math.PI * 2);
  a.fillStyle = PALE;
  a.fill();
  a.lineCap = "round";
  a.lineJoin = "round";
  a.beginPath();
  a.moveTo(cx - 40, 586);
  a.lineTo(cx + 40, 586);
  a.lineTo(cx + 22, 540);
  a.lineTo(cx - 22, 540);
  a.closePath();
  outlined(a, WHITE);
  a.beginPath();
  a.rect(cx - 9, 488, 18, 54);
  outlined(a, WHITE, 6);
  a.beginPath();
  a.moveTo(cx - 84, 400);
  a.quadraticCurveTo(cx - 84, 492, cx, 492);
  a.quadraticCurveTo(cx + 84, 492, cx + 84, 400);
  a.lineWidth = 16;
  a.strokeStyle = INK;
  a.stroke();
  a.lineWidth = 8;
  a.strokeStyle = WHITE;
  a.stroke();
  a.beginPath();
  a.ellipse(cx, 380, 62, 96, 0, 0, Math.PI * 2);
  outlined(a, WHITE);
  a.lineWidth = 5;
  for (let i = -3; i <= 3; i++) {
    const y = 380 + i * 22;
    const half = 62 * Math.sqrt(1 - (i * 22) ** 2 / 96 ** 2) - 8;
    a.beginPath();
    a.moveTo(cx - half, y);
    a.lineTo(cx + half, y);
    a.stroke();
  }
  a.beginPath();
  a.moveTo(cx, 288);
  a.lineTo(cx, 472);
  a.stroke();
  for (const side of [-1, 1]) {
    a.beginPath();
    a.arc(cx + side * 84, 400, 11, 0, Math.PI * 2);
    outlined(a, CREAM, 5);
  }
}

/** A small atom badge in the corner, the station's own emblem. */
function badge(a: Ctx): void {
  const x = 440;
  const y = 560;
  a.strokeStyle = SLATE;
  a.lineWidth = 3;
  for (const r of [0, Math.PI / 3, -Math.PI / 3]) {
    a.beginPath();
    a.ellipse(x, y, 28, 10, r, 0, Math.PI * 2);
    a.stroke();
  }
  a.fillStyle = SLATE;
  a.beginPath();
  a.arc(x, y, 5, 0, Math.PI * 2);
  a.fill();
}

export function poster(family: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const a = canvas.getContext("2d")!;
  a.fillStyle = SLATE;
  a.fillRect(0, 0, W, H);
  a.fillStyle = CREAM;
  a.fillRect(0, 250, W, 360);
  skyline(a);
  roundel(a);
  badge(a);
  embossed(a, "STATIC – NEVER!", 52, 64, family);
  embossed(a, "STAY – TUNED!", 655, 68, family);
  a.strokeStyle = "rgba(0,0,0,0.25)";
  a.lineWidth = 6;
  a.strokeRect(3, 3, W - 6, H - 6);
  return canvas;
}

/** The poster as a mipmapped, anisotropic texture, so it downsamples without shimmer. */
export function posterTexture(family: string): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(poster(family));
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  return t;
}
