import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { buildAtmosphere } from "./atmosphere";
import { buildAtom } from "./atom";
import { buildDeck } from "./deck";
import { buildDecals } from "./decals";
import { buildHall } from "./hall";
import { createKit, type Kit } from "./kit";
import { buildMast } from "./mast";
import * as M from "./materials";
import { DECK_Y, mesh, polar } from "./shapes";
import { buildSigns } from "./signs";
import { buildStudio } from "./studio";
import * as T from "./textures";
import { buildWing } from "./wing";
import { buildWorks } from "./works";

export type StationView =
  | "entrance"
  | "hero"
  | "studio"
  | "rear"
  | "atom"
  | "mast"
  | "orbit"
  | "front"
  | "back"
  | "left"
  | "right"
  | "top";

export interface StationController {
  view: (name: StationView) => void;
  motion: (enabled: boolean) => void;
  lights: (enabled: boolean) => void;
  typeface: (family: string) => void;
  dispose: () => void;
}

export interface StationOptions {
  /** Font stack used for painted signage. */
  family?: string;
  /** Fraction of the canvas width to push the model right, leaving room for page copy. */
  shift?: (width: number, height: number) => number;
}

interface Shot {
  target: THREE.Vector3;
  theta: number;
  phi: number;
  radius: number;
  shift: number;
}

const turnaround = (theta: number): Shot => ({
  target: new THREE.Vector3(0, 3.2, 0),
  theta,
  phi: 1.42,
  radius: 24,
  shift: 0,
});

const SHOTS: Record<StationView, Shot> = {
  hero: { target: new THREE.Vector3(-0.1, 3.4, 0), theta: 0.16, phi: 1.37, radius: 21.5, shift: 1 },
  studio: { target: new THREE.Vector3(-0.6, 1.45, -0.35), theta: 0.2, phi: 1.4, radius: 6.2, shift: 0.3 },
  rear: { target: new THREE.Vector3(0.4, 2.2, -2.4), theta: 2.55, phi: 1.24, radius: 13, shift: 0.5 },
  entrance: { target: new THREE.Vector3(2.8, 1.8, 0.9), theta: Math.PI / 4 - 0.1, phi: 1.42, radius: 7.2, shift: 0.3 },
  atom: { target: polar(3.95, -0.98).setY(DECK_Y + 1.5), theta: -0.55, phi: 1.32, radius: 6.5, shift: 0.4 },
  mast: { target: new THREE.Vector3(-0.3, 6.4, 0), theta: 0.45, phi: 1.2, radius: 12.5, shift: 0.5 },
  orbit: { target: new THREE.Vector3(0, 2.8, 0), theta: 0.2, phi: 1.22, radius: 23, shift: 0.7 },
  front: turnaround(0),
  back: turnaround(Math.PI),
  left: turnaround(-Math.PI / 2),
  right: turnaround(Math.PI / 2),
  top: { target: new THREE.Vector3(0, 0, 0), theta: 0, phi: 0.001, radius: 30, shift: 0 },
};

function createRenderer(wrap: HTMLDivElement, compact: boolean): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, compact ? 1.25 : 1.6));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  wrap.appendChild(renderer.domElement);
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute(
    "aria-label",
    "3D model of a round teal and brass radio station with a broadcast mast, steam tanks and a studio inside. Drag to turn it.",
  );
  renderer.domElement.style.touchAction = "pan-y";
  return renderer;
}

/** Image-based lighting: teal sky, warm horizon and a few softboxes so brass has something to reflect. */
function createEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const sky = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      top: { value: new THREE.Color("#4d9a92") },
      mid: { value: new THREE.Color("#9a6a36") },
      low: { value: new THREE.Color("#0b1b1d") },
    },
    vertexShader:
      "varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 low; varying vec3 vP;
      void main(){
        float h = vP.y;
        vec3 c = h > 0.0 ? mix(mid * 0.7, top, smoothstep(0.0, 0.6, h)) : mix(mid * 0.5, low, smoothstep(0.0, -0.35, h));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(20, 32, 16), sky));
  const panels = [
    [-8, 9, 8, "#ffe0a8", 6, 8, 5],
    [9, 4, -6, "#7fd0c8", 4, 6, 6],
    [0, -3, 12, "#ff9a4a", 1.5, 12, 3],
  ] as const;
  for (const [x, y, z, color, strength, w, h] of panels) {
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(strength),
      side: THREE.DoubleSide,
    });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    panel.position.set(x, y, z);
    panel.lookAt(0, 2, 0);
    envScene.add(panel);
  }
  const target = pmrem.fromScene(envScene, 0.02);
  envScene.traverse((o: THREE.Object3D): void => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  pmrem.dispose();
  return target;
}

function addLights(scene: THREE.Scene, compact: boolean): THREE.DirectionalLight {
  scene.add(new THREE.HemisphereLight("#b4c6bb", "#3a2814", 0.95));
  const key = new THREE.DirectionalLight("#ffdcaa", 3.0);
  key.position.set(-7, 12, 9);
  key.castShadow = true;
  const shadowSize = compact ? 1024 : 2048;
  key.shadow.mapSize.set(shadowSize, shadowSize);
  Object.assign(key.shadow.camera, { left: -8, right: 8, top: 9, bottom: -6, near: 1, far: 40 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  scene.add(key);
  const rim = new THREE.DirectionalLight("#9cc8c0", 1.2);
  rim.position.set(8, 10, -7);
  scene.add(rim);
  const fill = new THREE.DirectionalLight("#ff9d5c", 0.45);
  fill.position.set(-8, 2, 6);
  scene.add(fill);
  const shadowCatcher = mesh(
    new THREE.CircleGeometry(9, 48),
    new THREE.ShadowMaterial({ opacity: 0.35 }),
    [0, -0.75, 0],
    scene,
    false,
  );
  shadowCatcher.rotation.x = -Math.PI / 2;
  return key;
}

/** Bloom for the lamps and neon, then a soft vignette and film grain. */
function createPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
  const composer = new EffectComposer(
    renderer,
    new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }),
  );
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.3, 0.25, 1.3);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const finish = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
    vertexShader:
      "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; varying vec2 vUv;
      void main(){
        vec4 c = texture2D(tDiffuse, vUv);
        vec2 d = vUv - vec2(0.5, 0.5);
        float v = smoothstep(0.95, 0.3, length(d * vec2(1.0, 1.25)));
        c.rgb *= mix(0.72, 1.0, v);
        float n = fract(sin(dot(vUv * vec2(1231.7, 977.3) + uTime, vec2(12.9898, 78.233))) * 43758.5453);
        c.rgb += (n - 0.5) * 0.03;
        gl_FragColor = c;
      }`,
  });
  composer.addPass(finish);
  return { composer, bloom, finish };
}

function buildModel(k: Kit, scene: THREE.Scene, station: THREE.Group): THREE.Group {
  buildDeck(k, station);
  const hall = buildHall(k, station);
  buildStudio(k, hall);
  const wing = buildWing(k, station);
  buildDecals(k, station, { hall, wing });
  buildWorks(k, station);
  const tilt = buildMast(k, hall);
  buildSigns(k, station);
  buildAtom(k, station);
  buildAtmosphere(k, scene, station);
  return tilt;
}

/** Camera rig: smooth spherical moves between shots, plus a horizontal view offset for page copy. */
function createRig(camera: THREE.PerspectiveCamera, controls: OrbitControls, shift: StationOptions["shift"]) {
  const spherical = new THREE.Spherical();
  const rig = { goal: SHOTS.hero, current: 1, moving: false, width: 1, height: 1 };
  const applyShift = (): void => {
    const s = (shift ? shift(rig.width, rig.height) : 0) * rig.current;
    if (Math.abs(s) < 1e-4) camera.clearViewOffset();
    else camera.setViewOffset(rig.width, rig.height, -s * rig.width, 0, rig.width, rig.height);
    camera.updateProjectionMatrix();
  };
  const place = (shot: Shot): void => {
    controls.target.copy(shot.target);
    spherical.set(shot.radius, shot.phi, shot.theta);
    camera.position.setFromSpherical(spherical).add(shot.target);
    rig.current = shot.shift;
    applyShift();
  };
  const step = (dt: number): void => {
    const { goal } = rig;
    const k = 1 - Math.exp(-dt * 3.2);
    controls.target.lerp(goal.target, k);
    spherical.setFromVector3(camera.position.clone().sub(controls.target));
    const dTheta = Math.atan2(Math.sin(goal.theta - spherical.theta), Math.cos(goal.theta - spherical.theta));
    spherical.theta += dTheta * k;
    spherical.phi += (goal.phi - spherical.phi) * k;
    spherical.radius += (goal.radius - spherical.radius) * k;
    camera.position.setFromSpherical(spherical).add(controls.target);
    rig.current += (goal.shift - rig.current) * k;
    applyShift();
    const settled =
      Math.abs(dTheta) < 0.002 &&
      Math.abs(goal.radius - spherical.radius) < 0.02 &&
      controls.target.distanceTo(goal.target) < 0.01;
    if (settled) rig.moving = false;
  };
  place(rig.goal);
  return { rig, place, step, applyShift };
}

function createControls(camera: THREE.PerspectiveCamera, element: HTMLElement): OrbitControls {
  const controls = new OrbitControls(camera, element);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.minPolarAngle = 0.45;
  controls.maxPolarAngle = 1.52;
  controls.rotateSpeed = 0.5;
  controls.autoRotateSpeed = 0.7;
  return controls;
}

function disposeScene(scene: THREE.Scene, k: Kit): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  scene.traverse((o: THREE.Object3D): void => {
    const node = o as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    if (node.geometry) geometries.add(node.geometry);
    if (node.material) for (const m of Array.isArray(node.material) ? node.material : [node.material]) materials.add(m);
  });
  for (const m of materials) {
    for (const v of Object.values(m) as unknown[]) if (v instanceof THREE.Texture) textures.add(v);
    if (m instanceof THREE.ShaderMaterial)
      for (const u of Object.values(m.uniforms)) if (u.value instanceof THREE.Texture) textures.add(u.value);
    m.dispose();
  }
  for (const tile of Object.values(k.tiles)) for (const t of [tile.map, tile.normal, tile.rough]) textures.add(t);
  for (const g of geometries) g.dispose();
  for (const t of textures) t.dispose();
  (scene.background as THREE.Texture | null)?.dispose();
}

export function createStation(
  wrap: HTMLDivElement,
  onFailure: () => void,
  options: StationOptions = {},
): StationController {
  const lifecycle = new AbortController();
  const listen = { signal: lifecycle.signal };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const compact = window.matchMedia("(max-width: 700px)").matches;
  const k = createKit(compact, options.family ?? "Oswald, sans-serif");
  const state = {
    playing: !reduced.matches,
    dragging: false,
    dirty: true,
    clock: 0,
    last: performance.now(),
    visible: true,
    view: "hero" as StationView,
  };
  const pointer = new THREE.Vector2();

  const renderer = createRenderer(wrap, compact);
  const scene = new THREE.Scene();
  scene.background = T.backdrop();
  scene.fog = new THREE.Fog("#123a3c", 42, 95);
  const envTarget = createEnvironment(renderer);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.85;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 140);
  const station = new THREE.Group();
  scene.add(station);
  const tilt = buildModel(k, scene, station);
  const key = addLights(scene, compact);
  const { composer, bloom, finish } = createPost(renderer, scene, camera);

  const controls = createControls(camera, renderer.domElement);
  const { rig, place, step, applyShift } = createRig(camera, controls, options.shift);
  controls.addEventListener("start", (): void => {
    state.dragging = true;
    rig.moving = false;
  });
  controls.addEventListener("end", (): void => {
    state.dragging = false;
  });
  controls.addEventListener("change", (): void => {
    state.dirty = true;
  });

  const resize = new ResizeObserver((): void => {
    rig.width = Math.max(1, wrap.clientWidth);
    rig.height = Math.max(1, wrap.clientHeight);
    camera.aspect = rig.width / rig.height;
    camera.fov = THREE.MathUtils.radToDeg(
      2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(15)) * Math.max(1, 1.25 / camera.aspect)),
    );
    renderer.setSize(rig.width, rig.height);
    composer.setSize(rig.width, rig.height);
    bloom.resolution.set(rig.width / 2, rig.height / 2);
    applyShift();
    state.dirty = true;
  });
  resize.observe(wrap);
  const visibility = new IntersectionObserver((entries: IntersectionObserverEntry[]): void => {
    state.visible = entries[0]!.isIntersecting;
  });
  visibility.observe(wrap);
  wrap.addEventListener(
    "pointermove",
    (e: PointerEvent): void => {
      if (e.pointerType !== "mouse" || state.dragging) return;
      const r = wrap.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
    },
    listen,
  );
  wrap.addEventListener("pointerleave", (): void => void pointer.set(0, 0), listen);
  reduced.addEventListener(
    "change",
    (): void => {
      state.playing = !reduced.matches;
      state.dirty = true;
    },
    listen,
  );

  const tiltProbe = new THREE.Vector3();
  let frameId = 0;
  const animate = (now: number): void => {
    frameId = requestAnimationFrame(animate);
    const dt = Math.min((now - state.last) / 1000, 0.05);
    state.last = now;
    if (document.hidden || !state.visible) return;
    if (state.playing) {
      state.clock += dt;
      for (const a of k.animators) a(state.clock, dt);
      finish.uniforms.uTime!.value = state.clock;
    }
    if (rig.moving && !state.dragging) step(dt);
    const swaying = state.playing && state.view === "hero" && !state.dragging && !rig.moving;
    if (swaying || state.view !== "hero")
      station.rotation.y = THREE.MathUtils.lerp(station.rotation.y, swaying ? pointer.x * 0.1 : 0, dt * 3);
    controls.update(dt);
    station.updateMatrixWorld();
    M.frameInverse.value.copy(station.matrixWorld);
    M.frame.value.copy(station.matrixWorld).invert();
    const mp = tilt.getWorldPosition(tiltProbe);
    tilt.rotation.set(
      state.view === "top" ? 0 : 0.3,
      Math.atan2(camera.position.x - mp.x, camera.position.z - mp.z) - station.rotation.y,
      0,
    );
    if (state.playing || state.dirty || rig.moving || state.dragging) {
      composer.render(dt);
      state.dirty = false;
    }
  };
  frameId = requestAnimationFrame(animate);
  renderer.domElement.addEventListener(
    "webglcontextlost",
    (event: Event): void => {
      event.preventDefault();
      cancelAnimationFrame(frameId);
      onFailure();
    },
    listen,
  );

  return {
    view: (name: StationView): void => {
      state.view = name;
      rig.goal = SHOTS[name];
      controls.autoRotate = name === "orbit";
      controls.minPolarAngle = name === "top" ? 0 : 0.45;
      rig.moving = state.playing && !reduced.matches;
      if (!rig.moving) place(rig.goal);
      state.dirty = true;
    },
    motion: (enabled: boolean): void => {
      state.playing = enabled;
      state.dirty = true;
    },
    lights: (on: boolean): void => {
      k.illuminated = on;
      for (const [m, v] of k.emissives) m.emissiveIntensity = on ? v : 0;
      for (const [l, v] of k.practicals) l.intensity = on ? v : 0;
      for (const [s, v] of k.halos) s.material.opacity = on ? v : 0;
      for (const toggle of k.onLights) toggle(on);
      state.dirty = true;
    },
    typeface: (next: string): void => {
      k.family = next;
      for (const paint of k.repaints) paint();
      state.dirty = true;
    },
    dispose: (): void => {
      cancelAnimationFrame(frameId);
      lifecycle.abort();
      resize.disconnect();
      visibility.disconnect();
      controls.dispose();
      disposeScene(scene, k);
      key.shadow.dispose();
      envTarget.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
