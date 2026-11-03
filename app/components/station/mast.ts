import * as THREE from "three";
import * as M from "./materials";
import * as T from "./textures";
import type { Kit } from "./kit";
import { add, mesh, box, ball, torus, rod, tube, lathe, rivets, TAU, profile } from "./shapes";

/** Half-width of the tower at height y: splayed feet, tapering to the spire. */
const half = (y: number): number => 0.06 + 0.6 * Math.pow(1 - Math.min(y, 2.95) / 3.0, 1.45);
const corner = (i: number, y: number): THREE.Vector3 => {
  const a = (i / 4) * TAU + Math.PI / 4,
    r = half(y) * Math.SQRT2;
  return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
};
/** Radius of the brass ring around the tower at height y; the sign arms leave from it. */
export const ringRadius = (y: number): number => half(y) * Math.SQRT2 + 0.1;

function buildTower(k: Kit, mast: THREE.Group): void {
  const { brass, gold, beacon } = k;
  const legSteel = M.wear(new THREE.MeshStandardMaterial({ color: "#cfcbc0", metalness: 0.85, roughness: 0.42 }), {
    exposed: "#7a4a24",
    edges: 0.35,
    grime: 0,
    streaks: 0,
    exposedMetal: 0.3,
    exposedRough: 0.85,
  });
  const levels = [0, 0.5, 0.95, 1.35, 1.7, 2.02, 2.3, 2.55, 2.78];
  for (let i = 0; i < 4; i++) {
    tube(
      Array.from({ length: 12 }, (_: unknown, k: number): THREE.Vector3 => corner(i, (k / 11) * 2.92)),
      0.038,
      legSteel,
      mast,
      false,
      0.5,
    );
    const foot = corner(i, 0);
    box([0.22, 0.04, 0.22], [foot.x * 1.05, 0.02, foot.z * 1.05], brass, mast, 0.01);
    rivets(
      [
        [-0.07, -0.07],
        [0.07, -0.07],
        [-0.07, 0.07],
        [0.07, 0.07],
      ].map(([dx, dz]: number[]): THREE.Vector3 => new THREE.Vector3(foot.x * 1.05 + dx!, 0.045, foot.z * 1.05 + dz!)),
      0.015,
      gold,
      mast,
    );
  }
  for (let k = 0; k < levels.length - 1; k++) {
    const ya = levels[k]!,
      yb = levels[k + 1]!;
    for (let i = 0; i < 4; i++) {
      rod(corner(i, ya), corner((i + 1) % 4, yb), 0.011, gold, mast, 5);
      rod(corner((i + 1) % 4, ya), corner(i, yb), 0.011, gold, mast, 5);
      if (k > 0) rod(corner(i, ya), corner((i + 1) % 4, ya), 0.014, gold, mast, 5);
    }
  }
  const ringHeights = [1.25, 1.75, 2.2];
  for (const y of ringHeights) {
    torus([ringRadius(y), 0.034], [0, y, 0], gold, mast);
    for (let i = 0; i < 4; i++) rod(corner(i, y), corner(i, y).setLength(ringRadius(y)).setY(y), 0.012, brass, mast, 5);
  }
  for (const y of [1.0, 1.95])
    for (const i of [0, 2]) {
      const p = corner(i, y);
      ball(0.03, [p.x * 1.12, y, p.z * 1.12], beacon, mast, 10);
    }
  lathe(profile(0, 0, 0.07, 0, 0.05, 0.1, 0.025, 0.35, 0.015, 0.42, 0, 0.42), gold, [0, 2.86, 0], mast, 20);
}

/** Brass orb, the glowing signal rings that lean toward the viewer, the outward ripple, a pulsing shell and arcs. */
function buildSignal(k: Kit, mast: THREE.Group, mastTop: number): THREE.Group {
  const { tiles, animators, onLights, halo, practical } = k;
  const orbMaterial = new THREE.MeshStandardMaterial({
    map: tiles.brass.map,
    color: "#ffe3a8",
    metalness: 1,
    roughness: 0.3,
    emissive: "#ffb050",
    emissiveIntensity: 0.35,
  });
  ball(0.16, [0, mastTop + 0.45, 0], orbMaterial, mast, 32);
  halo([0, mastTop + 0.45, 0], 1.0, "#ffd08a", 0.35, mast);
  const orbLight = practical("#ffcf86", [5, 6], [0, mastTop + 0.45, 0], mast);
  // Radio waves: a shader disc of rings that ripple outward and fade, plus a pulsing shell.
  const waveMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color("#ffc36a") }, uOn: { value: 1 } },
    vertexShader:
      "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform float uTime; uniform vec3 uColor; uniform float uOn; varying vec2 vUv;
            void main(){
                vec2 p = vUv * 2.0 - 1.0; float d = length(p); float a = atan(p.y, p.x);
                float sum = 0.0;
                for (int i = 0; i < 4; i++) {
                    float r = fract(uTime * 0.22 + float(i) * 0.25);
                    float wobble = 0.012 * sin(a * 6.0 + uTime * 2.0 + float(i));
                    float band = exp(-pow((d - r - wobble) * 55.0, 2.0));
                    float soft = exp(-pow((d - r) * 12.0, 2.0)) * 0.25;
                    sum += (band + soft) * pow(1.0 - r, 1.6) * smoothstep(0.0, 0.08, r);
                }
                float dash = 0.75 + 0.25 * sin(a * 24.0 - uTime * 3.0);
                gl_FragColor = vec4(uColor * sum * dash * 1.1 * uOn, 1.0);
            }`,
  });
  // The ring set leans toward whoever is looking, so it always reads as open ellipses.
  const tilt = add(new THREE.Group(), mast);
  tilt.position.set(0, mastTop + 0.45, 0);
  tilt.rotation.order = "YXZ";
  const waves = mesh(new THREE.PlaneGeometry(9, 9), waveMaterial, [0, 0, 0], tilt, false);
  waves.rotation.x = -Math.PI / 2;
  waves.receiveShadow = false;
  waves.renderOrder = 3;
  const ringGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color("#ffc865").multiplyScalar(2.2), fog: false });
  const signalRings: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const ring = torus([0.7 + i * 0.62, 0.02], [0, 0, 0], ringGlow, tilt);
    ring.castShadow = false;
    signalRings.push(ring);
  }
  animators.push((t: number): void =>
    signalRings.forEach((ring: THREE.Mesh, i: number): void => {
      const pulse = Math.max(0, Math.sin(t * 2.4 - i * 0.9));
      ring.scale.setScalar(1 + pulse * 0.04);
      ring.position.y = Math.sin(t * 1.1 + i) * 0.03;
    }),
  );
  const shellMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uFade: { value: 0 }, uColor: { value: new THREE.Color("#ffcf86") } },
    vertexShader:
      "varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }",
    fragmentShader:
      "uniform float uFade; uniform vec3 uColor; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 3.0); gl_FragColor = vec4(uColor * f * uFade * 1.5, 1.0); }",
  });
  const shell = mesh(new THREE.SphereGeometry(1, 40, 24), shellMaterial, [0, mastTop + 0.45, 0], mast, false);
  shell.receiveShadow = false;
  // Electric arcs flicking off the orb.
  const arcGeometry = new THREE.BufferGeometry();
  const arcPositions = new Float32Array(3 * 2 * 3 * 8);
  arcGeometry.setAttribute("position", new THREE.BufferAttribute(arcPositions, 3));
  const arcs = new THREE.LineSegments(
    arcGeometry,
    new THREE.LineBasicMaterial({
      color: new THREE.Color("#ffe6b0").multiplyScalar(4),
      transparent: true,
      opacity: 0.9,
      fog: false,
    }),
  );
  arcs.position.set(0, mastTop + 0.45, 0);
  mast.add(arcs);
  const arcRandom = T.random(99);
  let arcTimer = 0;
  animators.push((t: number, dt: number): void => {
    waveMaterial.uniforms.uTime!.value = t;
    const cycle = (t * 0.42) % 1;
    shell.scale.setScalar(0.25 + cycle * 3.2);
    shellMaterial.uniforms.uFade!.value = Math.pow(1 - cycle, 2) * (k.illuminated ? 0.55 : 0);
    const flicker = 0.85 + Math.sin(t * 13) * 0.08 + Math.sin(t * 31) * 0.07;
    orbMaterial.emissiveIntensity = k.illuminated ? 0.35 * flicker : 0;
    orbLight.intensity = k.illuminated ? 5 * flicker : 0;
    arcTimer -= dt;
    if (arcTimer <= 0) {
      arcTimer = 0.05 + arcRandom() * 0.12;
      let slot = 0;
      const show = arcRandom() > 0.35 && k.illuminated;
      for (let s = 0; s < 3; s++) {
        const dir = new THREE.Vector3(arcRandom() - 0.5, arcRandom() * 0.8 - 0.2, arcRandom() - 0.5).normalize();
        let prev = dir.clone().multiplyScalar(0.2);
        for (let j = 1; j <= 3; j++) {
          const next = dir
            .clone()
            .multiplyScalar(0.2 + j * 0.16)
            .add(new THREE.Vector3(arcRandom() - 0.5, arcRandom() - 0.5, arcRandom() - 0.5).multiplyScalar(0.12));
          arcPositions.set([prev.x, prev.y, prev.z, next.x, next.y, next.z], slot);
          slot += 6;
          prev = next;
        }
      }
      arcGeometry.attributes.position!.needsUpdate = true;
      arcs.visible = show;
    }
  });
  onLights.push((on: boolean): void => {
    waveMaterial.uniforms.uOn!.value = on ? 1 : 0;
    ringGlow.color.set(on ? "#ffc865" : "#6d5a35").multiplyScalar(on ? 2.2 : 1);
    arcs.visible = false;
  });
  return tilt;
}

export function buildMast(k: Kit, hall: THREE.Group): THREE.Group {
  // Four splayed steel legs on bolted brass feet, brass X-bracing, three brass rings that carry the
  // sign arms, and a spire capped with a brass ball inside the signal rings.
  const mast = add(new THREE.Group(), hall);
  mast.position.set(0, 3.98, 0);
  mast.scale.setScalar(1.12);
  const mastTop = 3.0;
  buildTower(k, mast);
  return buildSignal(k, mast, mastTop);
}
