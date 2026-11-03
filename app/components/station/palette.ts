import * as THREE from "three";
import * as M from "./materials";
import * as T from "./textures";

/* Every material the station uses. Layer 1 (base tiles) and layer 2 (geometry-driven wear) come together
   here; layer 3 (decals) is placed on the finished model in decals.ts. */

const paintWear: M.WearOptions = {
  exposed: "#5b3b24",
  edges: 0.85,
  grime: 0.7,
  streaks: 0.6,
  exposedMetal: 0.35,
  exposedRough: 0.8,
};
const ivoryWear: M.WearOptions = {
  exposed: "#4f3d2c",
  edges: 0.65,
  grime: 0.65,
  streaks: 0.5,
  exposedMetal: 0.3,
  exposedRough: 0.8,
};
const brassWear: M.WearOptions = {
  exposed: "#ffe2a6",
  edges: 0.55,
  grime: 0.55,
  streaks: 0.2,
  exposedMetal: 1,
  exposedRough: 0.18,
};

export type Tiles = Record<"teal" | "steel" | "brass" | "ivory", M.Tile>;

/** Enamel over steel: base tile colour and roughness, panel seams and rivets from the UV bump map. */
export function enamel(
  tile: M.Tile,
  seams: T.Surface | null,
  tint: string,
  wearing: M.WearOptions,
  scale = 0.85,
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 1,
    metalness: 0.05,
    bumpMap: seams?.bump ?? null,
    bumpScale: 1.3,
  });
  return M.wear(m, { ...wearing, tile, scale });
}

function seamMaps(): Record<"teal" | "cream" | "dark", T.Surface> {
  const seamOptions = { base: "#808080", rust: 0, chips: 0 };
  return {
    teal: T.paintedMetal({ ...seamOptions, seed: 11, seamsX: 8, seamsY: 2 }),
    cream: T.paintedMetal({ ...seamOptions, seed: 23, seamsX: 3, seamsY: 1 }),
    dark: T.paintedMetal({ ...seamOptions, seed: 37, seamsX: 6, seamsY: 1 }),
  };
}

function metals(tiles: Tiles) {
  const brassMat = (color: string, roughness: number, extra: Partial<M.WearOptions>) =>
    M.wear(new THREE.MeshStandardMaterial({ color, metalness: 1, roughness }), {
      ...brassWear,
      tile: tiles.brass,
      ...extra,
    });
  return {
    brass: brassMat("#ffffff", 1, { scale: 1.1, detail: 0.35 }),
    gold: brassMat("#fff1d0", 0.75, { edges: 0.4, grime: 0.35, scale: 1.4, detail: 0.25 }),
    copper: brassMat("#f0a07c", 1, { exposed: "#ffc29a", scale: 1.1, detail: 0.3 }),
    chrome: new THREE.MeshStandardMaterial({ color: "#e6e6e2", metalness: 1, roughness: 0.16 }),
    iron: new THREE.MeshStandardMaterial({ color: "#232b2c", metalness: 0.7, roughness: 0.55 }),
  };
}

function paints(tiles: Tiles, steelSurface: T.Surface) {
  const seams = seamMaps();
  const redSurface = T.paintedMetal({
    base: "#a5352a",
    seed: 41,
    rust: 0.4,
    chips: 0.5,
    seamsX: 4,
    seamsY: 1,
    rivets: false,
  });
  return {
    teal: enamel(tiles.teal, T.repeat(seams.teal, 3, 1), "#ffffff", paintWear),
    tealDark: enamel(tiles.teal, T.repeat(seams.dark, 4, 1), "#9fb4ae", paintWear),
    cream: enamel(tiles.ivory, T.repeat(seams.cream, 2, 1), "#ffffff", ivoryWear),
    hallTeal: enamel(tiles.teal, seams.teal, "#ffffff", paintWear),
    hallCream: enamel(tiles.ivory, seams.cream, "#ffffff", ivoryWear),
    hallDark: enamel(tiles.teal, seams.dark, "#9fb4ae", paintWear),
    signCream: enamel(tiles.ivory, null, "#fff8ea", { ...ivoryWear, edges: 0.35, grime: 0, streaks: 0.2 }, 1.4),
    steel: M.wear(
      new THREE.MeshStandardMaterial({
        map: T.repeat(steelSurface, 2, 1).map,
        bumpMap: steelSurface.bump,
        bumpScale: 1.3,
        roughnessMap: steelSurface.rough,
        roughness: 1,
        metalness: 0.5,
      }),
      { ...paintWear, exposed: "#3b2a1e", edges: 0.5 },
    ),
    red: M.wear(
      new THREE.MeshStandardMaterial({
        map: redSurface.map,
        bumpMap: redSurface.bump,
        bumpScale: 0.8,
        roughnessMap: redSurface.rough,
        roughness: 1,
        metalness: 0.2,
      }),
      { ...paintWear, edges: 0.6 },
    ),
  };
}

function lamps() {
  return {
    warm: new THREE.MeshStandardMaterial({ color: "#fff0c8", emissive: "#ffbe62", emissiveIntensity: 2.2 }),
    warmSoft: new THREE.MeshStandardMaterial({ color: "#ffe4b0", emissive: "#ff9f45", emissiveIntensity: 1.1 }),
    neon: new THREE.MeshStandardMaterial({ color: "#ff8a64", emissive: "#ff3d1e", emissiveIntensity: 3.2 }),
    signRed: new THREE.MeshStandardMaterial({
      color: "#5e0f09",
      emissive: "#c42a17",
      emissiveIntensity: 1.2,
      roughness: 0.35,
      metalness: 0.1,
    }),
    beacon: new THREE.MeshStandardMaterial({ color: "#ff6a50", emissive: "#ff2a12", emissiveIntensity: 3 }),
  };
}

function furnishings() {
  return {
    rubber: new THREE.MeshStandardMaterial({ color: "#141617", roughness: 0.8 }),
    wood: new THREE.MeshStandardMaterial({ map: T.woodPlanks(7, "#6a3520", 3).map, roughness: 0.3, metalness: 0.05 }),
    leather: new THREE.MeshStandardMaterial({ map: T.tufted(8, "#b4502c").map, roughness: 0.42, metalness: 0.05 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: "#b9d6cf",
      metalness: 0,
      roughness: 0.04,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      envMapIntensity: 1.6,
      clearcoat: 1,
    }),
    plantGreen: new THREE.MeshStandardMaterial({ color: "#5f8a3e", roughness: 0.6, side: THREE.DoubleSide }),
    plantDark: new THREE.MeshStandardMaterial({ color: "#3f6a34", roughness: 0.6, side: THREE.DoubleSide }),
    soil: new THREE.MeshStandardMaterial({ color: "#2b1d12", roughness: 1 }),
  };
}

export function createPalette(compact: boolean) {
  M.setTileResolution(compact ? 512 : 1024);
  const tiles: Tiles = {
    teal: M.tealPaint(11),
    steel: M.platformSteel(12),
    brass: M.agedBrass(13),
    ivory: M.ivoryEnamel(14),
  };
  const steelSurface = T.paintedMetal({
    base: "#8d9290",
    seed: 61,
    rust: 0.7,
    chips: 0.3,
    seamsX: 3,
    seamsY: 2,
    roughness: 0.45,
  });
  const lit = lamps();
  return {
    tiles,
    steelSurface,
    brassSurface: { map: tiles.brass.map, rough: tiles.brass.rough },
    paintWear,
    ivoryWear,
    brassWear,
    ...metals(tiles),
    ...paints(tiles, steelSurface),
    ...lit,
    ...furnishings(),
    /** Emissive materials and their lit intensity, for the lights switch. */
    lit: [
      [lit.warm, 2.2],
      [lit.warmSoft, 1.1],
      [lit.neon, 2.6],
      [lit.signRed, 1.0],
      [lit.beacon, 2.5],
    ] as Array<[THREE.MeshStandardMaterial, number]>,
  };
}

export type Palette = ReturnType<typeof createPalette>;
