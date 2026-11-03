import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import * as M from "../app/components/station/materials";
import * as T from "../app/components/station/textures";
import { createKit } from "../app/components/station/kit";
import { buildDeck } from "../app/components/station/deck";
import { buildHall } from "../app/components/station/hall";
import { buildStudio } from "../app/components/station/studio";
import { buildWing } from "../app/components/station/wing";
import { buildDecals } from "../app/components/station/decals";
import { buildWorks } from "../app/components/station/works";
import { buildMast } from "../app/components/station/mast";
import { buildSigns } from "../app/components/station/signs";
import { buildAtom } from "../app/components/station/atom";
import { buildAtmosphere } from "../app/components/station/atmosphere";
import { installRecordingCanvas, RecordingCanvas } from "./helpers/recording-canvas";

beforeEach((): void => {
  installRecordingCanvas();
});
afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function textureRecord(texture: THREE.Texture): object {
  const canvas: RecordingCanvas = texture.image as RecordingCanvas;
  return {
    width: canvas.width,
    height: canvas.height,
    digest: canvas.digest(),
    colorSpace: texture.colorSpace,
    wrapS: texture.wrapS,
    wrapT: texture.wrapT,
  };
}

function surfaceRecord(surface: T.Surface | M.Tile): object {
  return Object.fromEntries(
    Object.entries(surface).map(([name, texture]: [string, THREE.Texture]) => [name, textureRecord(texture)]),
  );
}

describe("station surface regression", (): void => {
  it.each([
    "chip",
    "bolts1",
    "bolts2",
    "bolts3",
    "scratches",
    "gouge",
    "scuff",
    "crossed",
    "rust",
    "verdigris",
    "grime",
  ] as const)("preserves %s decal pixels", (kind: M.DecalKind): void => {
    expect(textureRecord(M.decalTexture(kind, 41))).toMatchSnapshot();
  });
  it.each(["tealPaint", "platformSteel", "agedBrass", "ivoryEnamel"] as const)(
    "preserves %s colour, normal and roughness pixels",
    (name): void => {
      M.setTileResolution(64);
      expect(surfaceRecord(M[name](7))).toMatchSnapshot();
    },
  );
  it("preserves painted panels with and without rivets", (): void => {
    for (const rivets of [true, false]) {
      expect(surfaceRecord(T.paintedMetal({ seed: 4, base: "#24655c", rivets }))).toMatchSnapshot();
    }
    expect(surfaceRecord(T.paintedMetal({ seed: 4, base: "#24655c", seamsX: 0, seamsY: 0 }))).toMatchSnapshot();
  });
  it("preserves the deck plates and equipment faces", (): void => {
    expect(surfaceRecord(T.deckPlates(9))).toMatchSnapshot();
    const rack = T.rackFace();
    expect([textureRecord(rack.map), textureRecord(rack.glow)]).toMatchSnapshot();
  });
  it("clones repeats without changing the source", (): void => {
    const source = T.agedBrass(3);
    const repeated = T.repeat(source, 3, 5);
    for (const key of ["map", "bump", "rough"] as const) {
      expect(repeated[key]).not.toBe(source[key]);
      expect(repeated[key].image).toBe(source[key].image);
      expect(repeated[key].repeat.toArray()).toEqual([3, 5]);
      expect(source[key].repeat.toArray()).toEqual([1, 1]);
    }
  });
});

it.each([true, false])(
  "preserves model geometry and animations (compact=%s)",
  (compact: boolean): void => {
    vi.spyOn(Math, "random").mockImplementation(T.random(42));
    const kit = createKit(compact, "sans-serif");
    const scene = new THREE.Scene();
    const station = new THREE.Group();
    scene.add(station);
    buildDeck(kit, station);
    const hall = buildHall(kit, station);
    buildStudio(kit, hall);
    const wing = buildWing(kit, station);
    buildDecals(kit, station, { hall, wing });
    buildWorks(kit, station);
    buildMast(kit, hall);
    buildSigns(kit, station);
    buildAtom(kit, station);
    buildAtmosphere(kit, scene, station);
    const hash = createHash("sha256");
    let meshes = 0;
    scene.traverse((object: THREE.Object3D): void => {
      hash.update(
        JSON.stringify([object.type, object.position.toArray(), object.rotation.toArray(), object.scale.toArray()]),
      );
      if (object instanceof THREE.Mesh) {
        meshes++;
        const positions = object.geometry.getAttribute("position");
        expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
        hash.update(Buffer.from(positions.array.buffer, positions.array.byteOffset, positions.array.byteLength));
      }
    });
    expect({
      meshes,
      geometry: hash.digest("hex"),
      animators: kit.animators.length,
      vents: kit.vents.length,
    }).toMatchSnapshot();
    for (const animate of kit.animators) animate(1, 0.016);
    expect(kit.neon.emissiveIntensity).toBeGreaterThan(0);
    kit.illuminated = false;
    kit.neon.emissiveIntensity = 0;
    for (const animate of kit.animators) animate(2, 0.016);
    expect(kit.neon.emissiveIntensity).toBe(0);
    for (const toggle of kit.onLights) {
      toggle(false);
      toggle(true);
    }
    kit.family = "serif";
    for (const repaint of kit.repaints) repaint();
    scene.traverse((object: THREE.Object3D): void => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials: THREE.Material[] = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
  },
  120_000,
);

it("paints the clock, poster and backdrop", (): void => {
  expect(textureRecord(T.clockFace())).toMatchSnapshot();
  expect((T.poster("sans-serif") as unknown as RecordingCanvas).digest()).toMatchSnapshot();
  expect(textureRecord(T.backdrop())).toMatchSnapshot();
});

it.each([true, false])("injects wear uniforms and shader hooks (tiled=%s)", (tiled: boolean): void => {
  M.setTileResolution(32);
  const tile = tiled ? M.tealPaint() : undefined;
  const material = M.wear(new THREE.MeshStandardMaterial(), {
    exposed: "#5b3b24",
    edges: 0.85,
    grime: 0.7,
    exposedMetal: 0.35,
    exposedRough: 0.8,
    tile,
    ...(tiled ? { ground: 1, streaks: 0.2, scale: 2, detail: 0.3 } : {}),
  });
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  expect(shader.uniforms.sbFrame).toBe(M.frame);
  expect(shader.uniforms.sbFrameInverse).toBe(M.frameInverse);
  expect(shader.uniforms.sbTile.value).toBe(tile?.map ?? null);
  expect(shader.vertexShader).toContain("sbFrame * modelMatrix * sbP");
  expect(shader.fragmentShader.includes("normal = normalize(normal + delta")).toBe(tiled);
  expect(material.customProgramCacheKey()).toContain(String(tiled));
  material.dispose();
});
