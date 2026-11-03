import * as THREE from "three";
import * as T from "./textures";
import type { Kit } from "./kit";
import { add, TAU } from "./shapes";

function buildFog(k: Kit, atmosphere: THREE.Group, cloudTexture: THREE.Texture): void {
  const { animators } = k;
  const fogRandom = T.random(4);
  const fogSprites: Array<{
    sprite: THREE.Sprite;
    angle: number;
    radius: number;
    speed: number;
    y: number;
    spin: number;
  }> = [];
  for (let i = 0; i < (k.compact ? 14 : 26); i++) {
    const back = i % 3 === 0;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: cloudTexture,
        color: back ? "#2f6964" : "#4b8780",
        transparent: true,
        opacity: back ? 0.32 : 0.2 + fogRandom() * 0.12,
        depthWrite: false,
      }),
    );
    const size = back ? 9 + fogRandom() * 7 : 4 + fogRandom() * 5;
    sprite.scale.set(size, size * 0.55, 1);
    const entry = {
      sprite,
      angle: fogRandom() * TAU,
      radius: back ? 9 + fogRandom() * 6 : 4.8 + fogRandom() * 3.5,
      speed: (fogRandom() - 0.5) * 0.04,
      y: back ? 1 + fogRandom() * 4 : -0.9 + fogRandom() * 1.1,
      spin: (fogRandom() - 0.5) * 0.05,
    };
    sprite.material.rotation = fogRandom() * TAU;
    atmosphere.add(sprite);
    fogSprites.push(entry);
  }
  animators.push((t: number): void => {
    for (const f of fogSprites) {
      const a = f.angle + t * f.speed;
      f.sprite.position.set(
        Math.sin(a) * f.radius,
        f.y + Math.sin(t * 0.2 + f.angle) * 0.15,
        Math.cos(a) * f.radius * 0.8 - (f.radius > 8 ? 4 : 0),
      );
      f.sprite.material.rotation += f.spin * 0.016;
    }
  });
}

export function buildAtmosphere(k: Kit, scene: THREE.Scene): void {
  const { animators } = k;
  const atmosphere = add(new THREE.Group(), scene);
  const cloudTexture = T.cloud(77);
  buildFog(k, atmosphere, cloudTexture);
  {
    const pos: number[] = [];
    const rnd = T.random(8);
    for (let i = 0; i < 160; i++) pos.push((rnd() - 0.5) * 11, 0.5 + rnd() * 6.5, (rnd() - 0.5) * 9);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const dust = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: new THREE.Color("#ffd89a").multiplyScalar(1.4),
        size: 0.03,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    atmosphere.add(dust);
    animators.push((t: number): void => {
      dust.rotation.y = t * 0.012;
      dust.position.y = Math.sin(t * 0.15) * 0.1;
    });
  }
}
