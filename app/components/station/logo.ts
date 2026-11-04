import * as THREE from "three";
import type { Kit } from "./kit";
import { add, ball, mesh, tube, TAU } from "./shapes";
import { plan, loop } from "./plan";
import { enamel } from "./palette";

/* The StreamBullets wordmark as a 3D sign on the hall fascia. The letters are the brand SVG glyphs,
   extruded and wrapped onto the curved wall; the fascia's three enamel stripes are the logo's bullets,
   so they stop short of the letters in the same rhythm as the logo's bars. */

const WORDMARK = [
  "M11.0 40.48Q7.96 40.48 5.92 39.4Q3.88 38.32 2.84 36.06Q1.8 33.8 1.68 30.2L7.8 29.28Q7.84 31.36 8.18 32.64Q8.52 33.92 9.14 34.480000000000004Q9.76 35.04 10.64 35.04Q11.76 35.04 12.1 34.28Q12.44 33.519999999999996 12.44 32.68Q12.44 30.68 11.48 29.3Q10.52 27.92 8.88 26.52L6.08 24.08Q4.24 22.52 2.98 20.54Q1.72 18.56 1.72 15.64Q1.72 11.52 4.16 9.339999999999998Q6.6000000000000005 7.159999999999997 10.8 7.159999999999997Q13.4 7.159999999999997 14.98 8.039999999999997Q16.56 8.919999999999998 17.38 10.339999999999998Q18.2 11.759999999999998 18.5 13.339999999999998Q18.8 14.919999999999998 18.84 16.36L12.68 17.12Q12.64 15.68 12.5 14.62Q12.36 13.559999999999999 11.92 12.979999999999999Q11.48 12.399999999999999 10.56 12.399999999999999Q9.56 12.399999999999999 9.100000000000001 13.239999999999998Q8.64 14.079999999999998 8.64 14.919999999999998Q8.64 16.72 9.5 17.86Q10.36 19.0 11.76 20.24L14.44 22.599999999999998Q16.56 24.4 18.02 26.68Q19.48 28.96 19.48 32.32Q19.48 34.6 18.44 36.46Q17.400000000000002 38.32 15.5 39.4Q13.6 40.48 11.0 40.48Z M26.08 40.0V12.919999999999998H21.2V7.600000000000001H38.12V12.919999999999998H33.28V40.0Z M41.16 40.0V7.600000000000001H50.08Q53.36 7.600000000000001 55.76 8.32Q58.16 9.04 59.5 10.899999999999999Q60.84 12.759999999999998 60.84 16.16Q60.84 18.16 60.52 19.72Q60.2 21.28 59.34 22.42Q58.48 23.56 56.879999999999995 24.32L61.31999999999999 40.0H53.92L50.36 25.48H48.32V40.0ZM48.32 21.36H50.32Q51.839999999999996 21.36 52.67999999999999 20.82Q53.519999999999996 20.28 53.86 19.259999999999998Q54.199999999999996 18.24 54.199999999999996 16.8Q54.199999999999996 14.719999999999999 53.44 13.559999999999999Q52.68 12.399999999999999 50.64 12.399999999999999H48.32Z M65.36 40.0V7.600000000000001H79.91999999999999V12.48H72.52V20.52H78.16V25.48H72.52V35.16H80.0V40.0Z M81.88 40.0 87.99999999999999 7.600000000000001H96.16L102.19999999999999 40.0H95.6L94.52 33.16H89.75999999999999L88.63999999999999 40.0ZM90.39999999999999 28.88H93.83999999999999L92.11999999999999 16.24Z M105.55999999999999 40.0 106.11999999999999 7.600000000000001H113.79999999999998L117.35999999999999 26.439999999999998L121.19999999999999 7.600000000000001H128.6L129.16 40.0H124.07999999999998L123.47999999999999 18.44L119.71999999999998 40.0H115.19999999999999L111.19999999999999 18.28L110.71999999999998 40.0Z",
  "M2.4 73.6V41.199999999999996H10.84Q12.92 41.199999999999996 14.780000000000001 41.519999999999996Q16.64 41.83999999999999 18.08 42.739999999999995Q19.52 43.63999999999999 20.34 45.3Q21.16 46.959999999999994 21.16 49.67999999999999Q21.16 51.63999999999999 20.58 52.97999999999999Q20.0 54.31999999999999 18.939999999999998 55.11999999999999Q17.88 55.919999999999995 16.4 56.19999999999999Q18.28 56.44 19.560000000000002 57.419999999999995Q20.84 58.39999999999999 21.5 60.03999999999999Q22.16 61.67999999999999 22.16 63.99999999999999Q22.16 66.52 21.5 68.34Q20.84 70.16 19.6 71.32Q18.36 72.47999999999999 16.54 73.03999999999999Q14.72 73.6 12.36 73.6ZM9.56 68.6H11.08Q13.44 68.6 14.34 67.39999999999999Q15.24 66.19999999999999 15.24 63.879999999999995Q15.24 62.03999999999999 14.84 60.959999999999994Q14.44 59.879999999999995 13.52 59.379999999999995Q12.6 58.879999999999995 11.040000000000001 58.879999999999995H9.56ZM9.56 54.16H10.96Q12.6 54.16 13.440000000000001 53.66Q14.280000000000001 53.16 14.580000000000002 52.199999999999996Q14.88 51.239999999999995 14.88 49.879999999999995Q14.88 48.599999999999994 14.420000000000002 47.739999999999995Q13.96 46.879999999999995 13.06 46.44Q12.16 45.99999999999999 10.8 45.99999999999999H9.56Z M35.48 74.08Q31.759999999999998 74.08 29.659999999999997 72.86Q27.56 71.64 26.72 69.3Q25.88 66.96 25.88 63.559999999999995V41.199999999999996H32.96V64.63999999999999Q32.96 65.64 33.120000000000005 66.64Q33.28 67.64 33.82 68.28Q34.36 68.91999999999999 35.48 68.91999999999999Q36.64 68.91999999999999 37.16 68.28Q37.68 67.64 37.82 66.64Q37.96 65.64 37.96 64.63999999999999V41.199999999999996H45.08V63.559999999999995Q45.08 66.96 44.22 69.3Q43.36 71.64 41.28 72.86Q39.2 74.08 35.48 74.08Z M49.839999999999996 73.6V41.199999999999996H57.0V68.75999999999999H64.44V73.6Z M67.76 73.6V41.199999999999996H74.92V68.75999999999999H82.36V73.6Z M85.68 73.6V41.199999999999996H100.24000000000001V46.08H92.84V54.11999999999999H98.48V59.08H92.84V68.75999999999999H100.32V73.6Z M106.68 73.6V46.519999999999996H101.8V41.199999999999996H118.72V46.519999999999996H113.88V73.6Z M130.36 74.08Q127.32 74.08 125.28 73.0Q123.24 71.91999999999999 122.19999999999999 69.66Q121.16 67.39999999999999 121.04 63.8L127.16 62.879999999999995Q127.2 64.96 127.53999999999999 66.24Q127.88 67.52 128.5 68.08Q129.12 68.64 130.0 68.64Q131.12 68.64 131.46 67.88Q131.8 67.11999999999999 131.8 66.28Q131.8 64.28 130.84 62.9Q129.88 61.519999999999996 128.24 60.11999999999999L125.44 57.67999999999999Q123.6 56.11999999999999 122.34 54.13999999999999Q121.08 52.16 121.08 49.239999999999995Q121.08 45.11999999999999 123.52 42.93999999999999Q125.96 40.75999999999999 130.16 40.75999999999999Q132.76 40.75999999999999 134.33999999999997 41.63999999999999Q135.92 42.519999999999996 136.74 43.94Q137.56 45.35999999999999 137.86 46.94Q138.16 48.519999999999996 138.2 49.959999999999994L132.04 50.72Q132.0 49.279999999999994 131.86 48.22Q131.72 47.16 131.28 46.58Q130.84 45.99999999999999 129.92 45.99999999999999Q128.92 45.99999999999999 128.45999999999998 46.83999999999999Q128.0 47.67999999999999 128.0 48.519999999999996Q128.0 50.31999999999999 128.86 51.459999999999994Q129.72 52.599999999999994 131.12 53.83999999999999L133.8 56.19999999999999Q135.92 57.99999999999999 137.38 60.279999999999994Q138.84 62.559999999999995 138.84 65.91999999999999Q138.84 68.19999999999999 137.8 70.05999999999999Q136.76 71.91999999999999 134.86 73.0Q132.96 74.08 130.36 74.08Z",
];

/** Letter block of the brand SVG in its own units (after its translate + skew). */
const SVG_TOP = 7.2;
const SVG_BOTTOM = 74.1;
const SVG_LEFT = 78;
const SVG_RIGHT = 218.1;
/** Logo bar rhythm (SVG units): left bars end this far before the letters, right bars start this far after. */
const LEFT_GAP = [12, 23.9, 12] as const;
const RIGHT_GAP = [0, 10.6, 0] as const;

export const STRIPE_Y = [3.04, 2.88, 2.72] as const;
const STRIPE_R = 0.032;
const STRIPE_GROW = 0.245;
/** Where the sign is centred on the hall plan, and how tall the letters stand. */
export const LOGO_AT = 0.31;
const LETTER_H = 0.66;
const LETTER_GROW = 0.275;
const LETTER_DEPTH = 0.055;

/** Wall angle reached by walking `s` metres along the plan from angle a (positive toward +x). */
function walk(a: number, s: number, grow: number): number {
  const step = 0.0005 * Math.sign(s);
  let run = 0;
  let prev = plan(a, grow);
  while (Math.abs(run) < Math.abs(s)) {
    a += step;
    const p = plan(a, grow);
    run += p.distanceTo(prev) * Math.sign(s);
    prev = p;
  }
  return a;
}

/** The brand SVG's translate(78 0) skewX(-10), applied to a glyph point. */
const SKEW = Math.tan((-10 * Math.PI) / 180);
const place = (x: number, y: number): [number, number] => [
  x + y * SKEW + SVG_LEFT_SHIFT,
  y,
];
const SVG_LEFT_SHIFT = 78;

/** Parse the wordmark's absolute M/L/H/V/Q/Z path data into shapes, without needing a DOM. */
export function glyphShapes(): THREE.Shape[] {
  const path = new THREE.ShapePath();
  for (const d of WORDMARK) {
    const tokens = d.match(/[MLHVQZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
    let i = 0;
    let cmd = "";
    let x = 0;
    let y = 0;
    const num = (): number => Number(tokens[i++]);
    while (i < tokens.length) {
      if (/[A-Z]/i.test(tokens[i])) cmd = tokens[i++];
      if (cmd === "Z") {
        path.currentPath?.closePath();
        continue;
      }
      if (cmd === "M" || cmd === "L") {
        x = num();
        y = num();
        const [px, py] = place(x, y);
        if (cmd === "M") {
          path.moveTo(px, py);
          cmd = "L";
        } else path.lineTo(px, py);
      } else if (cmd === "H" || cmd === "V") {
        if (cmd === "H") x = num();
        else y = num();
        path.lineTo(...place(x, y));
      } else if (cmd === "Q") {
        const [cx, cy] = place(num(), num());
        x = num();
        y = num();
        path.quadraticCurveTo(cx, cy, ...place(x, y));
      } else i++;
    }
  }
  return path.toShapes();
}

function letters(scale: number): THREE.BufferGeometry {
  const shapes = glyphShapes();
  const depth = LETTER_DEPTH / scale;
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: true,
    bevelSize: 0.5,
    bevelThickness: 0.5,
    bevelSegments: 1,
    curveSegments: 3,
  });
  // SVG y points down: flip y and z together so faces keep their winding, then centre on the block.
  g.translate(-(SVG_LEFT + SVG_RIGHT) / 2, -(SVG_TOP + SVG_BOTTOM) / 2, 0);
  g.scale(scale, -scale, -scale);
  g.translate(0, 0, LETTER_DEPTH);
  return g;
}

/** Bend a flat sign (x along the wall, y up, z out) onto the hall plan around angle a, at height y. */
function wrap(
  g: THREE.BufferGeometry,
  a: number,
  grow: number,
  y: number,
): void {
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const p = plan(
      walk(a, pos.getX(i), grow),
      grow + pos.getZ(i),
      y + pos.getY(i),
    );
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
}

export function buildLogo(k: Kit, hall: THREE.Group): void {
  const { tiles, ivoryWear, gold, halo, practical } = k;
  const stripe = enamel(tiles.ivory, null, "#f2bf49", {
    ...ivoryWear,
    edges: 0.4,
    streaks: 0.3,
  });
  const face = enamel(
    tiles.ivory,
    null,
    "#fffaf0",
    { ...ivoryWear, edges: 0.3, grime: 0.25, streaks: 0.2 },
    1.4,
  );
  const scale = LETTER_H / (SVG_BOTTOM - SVG_TOP);
  const centreY = STRIPE_Y[1];
  const g = letters(scale);
  wrap(g, LOGO_AT, LETTER_GROW, centreY);
  // Extrude groups: 0 = caps (cream enamel faces), 1 = sides (brass returns, like channel letters).
  const sign = mesh(g, face, [0, 0, 0], hall);
  sign.material = [face, gold];
  const halfW = ((SVG_RIGHT - SVG_LEFT) / 2) * scale;
  STRIPE_Y.forEach((y: number, i: number): void => {
    // Each stripe runs from just right of the letters, round the back, to just left of them.
    const from = walk(
      LOGO_AT,
      halfW + RIGHT_GAP[i] * scale + 0.02,
      STRIPE_GROW,
    );
    const to =
      walk(LOGO_AT, -(halfW + LEFT_GAP[i] * scale + 0.02), STRIPE_GROW) + TAU;
    tube(loop(from, to, STRIPE_GROW, y, 160), STRIPE_R, stripe, hall, false);
    for (const a of [from, to])
      ball(
        STRIPE_R,
        [...plan(a, STRIPE_GROW, y).toArray()] as [number, number, number],
        stripe,
        hall,
        12,
      );
  });
  // A warm wash from under the fascia lip lifts the letters off the teal at night.
  const c = plan(LOGO_AT, 0.9, centreY);
  const wash = add(new THREE.Group(), hall);
  halo([c.x, c.y, c.z], 2.2, "#ffe2b0", 0.08, wash);
  practical("#fff0dc", [0.8, 2.2], [c.x, c.y - 0.5, c.z], wash);
}
