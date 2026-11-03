import * as THREE from "three";
import * as T from "./textures";
import type { Kit } from "./kit";
import { add, TAU } from "./shapes";

export function buildAtmosphere(k: Kit, scene: THREE.Scene, station: THREE.Group): void {
  const { neon, signRed, animators, vents } = k;
  const atmosphere = add(new THREE.Group(), scene);
  const cloudTexture = T.cloud(77);
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
  const steamMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: cloudTexture },
      uScale: { value: 1 },
      uColor: { value: new THREE.Color("#d8e4de") },
    },
    vertexShader: `attribute float aSeed; uniform float uTime; uniform float uScale; varying float vAlpha; varying float vSpin;
            void main(){
                float t = fract(uTime * 0.16 + aSeed);
                vec3 p = position;
                p.y += t * 2.4;
                p.x += t * t * 0.9 + sin(aSeed * 40.0 + t * 4.0) * 0.18 * t;
                p.z += cos(aSeed * 23.0 + t * 3.0) * 0.18 * t;
                vec4 mv = modelViewMatrix * vec4(p, 1.0);
                gl_Position = projectionMatrix * mv;
                gl_PointSize = uScale * (0.25 + t * 1.5) * 260.0 / -mv.z;
                vAlpha = smoothstep(0.0, 0.1, t) * pow(1.0 - t, 1.4);
                vSpin = aSeed * 6.28 + t;
            }`,
    fragmentShader: `uniform sampler2D uMap; uniform vec3 uColor; varying float vAlpha; varying float vSpin;
            void main(){
                vec2 c = gl_PointCoord - 0.5; float s = sin(vSpin), k = cos(vSpin);
                vec2 uv = vec2(c.x * k - c.y * s, c.x * s + c.y * k) + 0.5;
                float a = texture2D(uMap, uv).a * vAlpha * 0.55;
                gl_FragColor = vec4(uColor, a);
            }`,
  });
  {
    const perVent = k.compact ? 16 : 28;
    const pos: number[] = [],
      seeds: number[] = [];
    const rnd = T.random(55);
    for (const v of vents)
      for (let i = 0; i < perVent; i++) {
        pos.push(v.x, v.y, v.z);
        seeds.push(rnd());
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.Float32BufferAttribute(seeds, 1));
    const steam = new THREE.Points(g, steamMaterial);
    steam.frustumCulled = false;
    steam.renderOrder = 4;
    station.add(steam);
    animators.push((t: number): void => {
      steamMaterial.uniforms.uTime!.value = t;
    });
  }
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
  // ON AIR neon flicker and marquee chase.
  animators.push((t: number): void => {
    if (!k.illuminated) return;
    const flick = Math.sin(t * 50) > 0.985 ? 0.55 : 1;
    neon.emissiveIntensity = 2.6 * flick;
    signRed.emissiveIntensity = 1.0 * flick;
  });
}
