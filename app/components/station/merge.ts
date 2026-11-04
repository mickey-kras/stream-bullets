import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Animator } from "./kit";

/* Static batching. Most of the station never moves, so its ~1,000 meshes are merged into one mesh per
   material, which cuts draw calls (and shadow-pass draw calls) by an order of magnitude. Anything that
   moves, blinks or is driven from outside is left alone: it is found by running every animator at a
   few sample times and watching which meshes change, plus the roots the caller names. */

const SAMPLE_TIMES = [0.37, 1.9, 4.3, 7.7, 13.1, 21.4];

interface Pose {
  matrix: THREE.Matrix4;
  visible: boolean;
}

function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

type Restore = () => void;

/** Everything an animator might touch, so sampling them leaves the station exactly as it was built. */
function snapshot(root: THREE.Object3D): Restore {
  const undo: Restore[] = [];
  const seen = new Set<object>();
  const keepMaterial = (m: THREE.Material): void => {
    if (seen.has(m)) return;
    seen.add(m);
    const any = m as THREE.Material & {
      color?: THREE.Color;
      emissive?: THREE.Color;
      emissiveIntensity?: number;
      map?: THREE.Texture | null;
    };
    const color = any.color?.clone();
    const emissive = any.emissive?.clone();
    const { emissiveIntensity, opacity } = any;
    const offset = any.map?.offset.clone();
    const rotation = any.map?.rotation;
    undo.push((): void => {
      if (color) any.color?.copy(color);
      if (emissive) any.emissive?.copy(emissive);
      if (emissiveIntensity !== undefined) any.emissiveIntensity = emissiveIntensity;
      any.opacity = opacity;
      if (offset && any.map) {
        any.map.offset.copy(offset);
        any.map.rotation = rotation ?? 0;
      }
    });
  };
  root.traverse((o: THREE.Object3D): void => {
    const position = o.position.clone();
    const quaternion = o.quaternion.clone();
    const scale = o.scale.clone();
    const { visible } = o;
    undo.push((): void => {
      o.position.copy(position);
      o.quaternion.copy(quaternion);
      o.scale.copy(scale);
      o.visible = visible;
    });
    if (o instanceof THREE.Light) {
      const { intensity } = o;
      undo.push((): void => {
        o.intensity = intensity;
      });
    }
    const material = (o as THREE.Object3D & { material?: THREE.Material | THREE.Material[] }).material;
    if (material) for (const m of Array.isArray(material) ? material : [material]) keepMaterial(m);
  });
  return (): void => {
    for (const u of undo) u();
  };
}

/** Meshes whose world transform or visibility any animator changes. */
function movingMeshes(root: THREE.Object3D, animators: readonly Animator[]): Set<THREE.Mesh> {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o: THREE.Object3D): void => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });
  root.updateMatrixWorld(true);
  const rest = new Map<THREE.Mesh, Pose>(
    meshes.map((m: THREE.Mesh): [THREE.Mesh, Pose] => [m, { matrix: m.matrixWorld.clone(), visible: shown(m) }]),
  );
  const moving = new Set<THREE.Mesh>();
  const restore = snapshot(root);
  for (const t of SAMPLE_TIMES) {
    for (const animate of animators) animate(t, 0.016);
    root.updateMatrixWorld(true);
    for (const m of meshes) {
      const pose = rest.get(m) as Pose;
      if (!m.matrixWorld.equals(pose.matrix) || shown(m) !== pose.visible) moving.add(m);
    }
  }
  restore();
  root.updateMatrixWorld(true);
  return moving;
}

function eligible(m: THREE.Mesh, moving: Set<THREE.Mesh>, pinned: Set<THREE.Object3D>): boolean {
  if (m instanceof THREE.InstancedMesh || m instanceof THREE.SkinnedMesh) return false;
  if (moving.has(m) || Array.isArray(m.material) || !shown(m) || m.geometry.morphAttributes.position) return false;
  // Transparent parts are sorted back to front, so only decals (flat, offset onto a surface, no depth
  // writes) may share a draw; glass and glows keep their own.
  if (m.material.transparent && !(m.material.polygonOffset && !m.material.depthWrite)) return false;
  for (let p: THREE.Object3D | null = m; p; p = p.parent) if (pinned.has(p)) return false;
  return true;
}

/** Baking a mirrored transform turns faces inside out; swap two corners of every triangle to undo it. */
function flipWinding(g: THREE.BufferGeometry): void {
  if (g.index) {
    const index = g.index;
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, b);
    }
    index.needsUpdate = true;
    return;
  }
  for (const attribute of Object.values(g.attributes)) {
    const a = attribute as THREE.BufferAttribute;
    for (let i = 0; i < a.count; i += 3)
      for (let c = 0; c < a.itemSize; c++) {
        const b = a.getComponent(i + 1, c);
        a.setComponent(i + 1, c, a.getComponent(i + 2, c));
        a.setComponent(i + 2, c, b);
      }
    a.needsUpdate = true;
  }
}

function batchKey(m: THREE.Mesh): string {
  const g = m.geometry;
  const attributes = Object.keys(g.attributes)
    .sort((a: string, b: string): number => a.localeCompare(b))
    .join(",");
  const material = m.material as THREE.Material;
  return [material.uuid, m.castShadow, m.receiveShadow, m.renderOrder, g.index ? "i" : "n", attributes].join("|");
}

/** Fold instanced sets that share a material and a template shape (rivets, mostly) into one set each. */
function batchInstances(station: THREE.Object3D, moving: Set<THREE.Mesh>, pins: Set<THREE.Object3D>): void {
  const groups = new Map<string, THREE.InstancedMesh[]>();
  station.traverse((o: THREE.Object3D): void => {
    if (!(o instanceof THREE.InstancedMesh) || moving.has(o) || Array.isArray(o.material) || !shown(o)) return;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (pins.has(p)) return;
    const shape = JSON.stringify(o.geometry.parameters ?? o.geometry.uuid);
    const key = [o.material.uuid, o.geometry.type, shape, o.castShadow, o.receiveShadow, o.renderOrder].join("|");
    const list = groups.get(key) ?? [];
    list.push(o);
    groups.set(key, list);
  });
  const toStation = station.matrixWorld.clone().invert();
  const local = new THREE.Matrix4();
  const each = new THREE.Matrix4();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const first = list[0];
    const total = list.reduce((n: number, m: THREE.InstancedMesh): number => n + m.count, 0);
    const batch = new THREE.InstancedMesh(first.geometry, first.material, total);
    let i = 0;
    for (const m of list) {
      local.copy(toStation).multiply(m.matrixWorld);
      for (let j = 0; j < m.count; j++) {
        m.getMatrixAt(j, each);
        batch.setMatrixAt(i++, each.premultiply(local));
      }
    }
    batch.name = "static-batch";
    batch.castShadow = first.castShadow;
    batch.receiveShadow = first.receiveShadow;
    batch.renderOrder = first.renderOrder;
    batch.instanceMatrix.needsUpdate = true;
    batch.computeBoundingSphere();
    station.add(batch);
    for (const m of list) {
      m.removeFromParent();
      if (m.geometry !== first.geometry) m.geometry.dispose();
      m.dispose();
    }
  }
}

/**
 * Merge every static mesh under `station` into one mesh per material. `pinned` roots (and everything
 * under them) are never merged. Returns the meshes the animators move, which stay separate.
 */
export function batchStatic(
  station: THREE.Object3D,
  animators: readonly Animator[],
  pinned: readonly THREE.Object3D[],
): Set<THREE.Mesh> {
  const moving = movingMeshes(station, animators);
  const pins = new Set<THREE.Object3D>(pinned);
  const groups = new Map<string, THREE.Mesh[]>();
  station.traverse((o: THREE.Object3D): void => {
    if (!(o instanceof THREE.Mesh) || !eligible(o, moving, pins)) return;
    const key = batchKey(o);
    const list = groups.get(key) ?? [];
    list.push(o);
    groups.set(key, list);
  });
  station.updateMatrixWorld(true);
  const toStation = station.matrixWorld.clone().invert();
  const removed = new Set<THREE.BufferGeometry>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const parts = list.map((m: THREE.Mesh): THREE.BufferGeometry => {
      const g = m.geometry.clone();
      g.clearGroups();
      const bake = toStation.clone().multiply(m.matrixWorld);
      g.applyMatrix4(bake);
      if (bake.determinant() < 0) flipWinding(g);
      return g;
    });
    const merged = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    if (!merged) continue;
    const first = list[0];
    const batch = new THREE.Mesh(merged, first.material);
    batch.name = "static-batch";
    batch.castShadow = first.castShadow;
    batch.receiveShadow = first.receiveShadow;
    batch.renderOrder = first.renderOrder;
    station.add(batch);
    for (const m of list) {
      m.removeFromParent();
      removed.add(m.geometry);
    }
  }
  batchInstances(station, moving, pins);
  // Clones can share a geometry with meshes that stay; only free the ones nothing uses any more.
  station.traverse((o: THREE.Object3D): void => {
    if (o instanceof THREE.Mesh) removed.delete(o.geometry);
  });
  for (const g of removed) g.dispose();
  return moving;
}
