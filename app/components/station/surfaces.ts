import * as THREE from 'three';
export function agedSurface(color: string, metalness: number, roughness: number, painted: boolean): THREE.MeshStandardMaterial {
    const size: number = 512;
    const albedo = document.createElement('canvas');
    albedo.width = size;
    albedo.height = size;
    const relief = document.createElement('canvas');
    relief.width = size;
    relief.height = size;
    const a = albedo.getContext('2d')!;
    const b = relief.getContext('2d')!;
    let seed: number = 76123;
    const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    a.fillStyle = '#eeeeea';
    a.fillRect(0, 0, size, size);
    b.fillStyle = '#888888';
    b.fillRect(0, 0, size, size);
    for (let i = 0; i < 22000; i++) {
        const x = random() * size, y = random() * size, v = Math.floor(170 + random() * 80);
        a.fillStyle = `rgba(${v},${v},${v},${random() * .24})`;
        a.fillRect(x, y, 1, 1);
        b.fillStyle = `rgb(${v},${v},${v})`;
        b.fillRect(x, y, 1, 1);
    }
    for (let i = 0; i < 45; i++) {
        const x = random() * size, y = random() * size, r = .3 + Math.pow(random(), 4) * 5;
        a.fillStyle = painted ? 'rgba(68,43,22,.65)' : 'rgba(64,52,32,.36)';
        a.beginPath();
        a.ellipse(x, y, r, r * .65, random() * 6.28, 0, Math.PI * 2);
        a.fill();
        b.fillStyle = '#444';
        b.beginPath();
        b.ellipse(x, y, r, r * .65, 0, 0, Math.PI * 2);
        b.fill();
        if (i % 12 === 0) {
            a.fillStyle = 'rgba(244,215,160,.6)';
            a.fillRect(x - r, y + r * .4, r * 1.5, .6);
        }
    }
    for (let i = 0; i < 65; i++) {
        const x = random() * size, y = random() * size;
        a.strokeStyle = 'rgba(255,244,210,.23)';
        a.lineWidth = .4;
        a.beginPath();
        a.moveTo(x, y);
        a.lineTo(x + 2 + random() * 18, y + random() * 2);
        a.stroke();
    }
    const texture = new THREE.CanvasTexture(albedo);
    texture.colorSpace = THREE.SRGBColorSpace;
    const bump = new THREE.CanvasTexture(relief);
    for (const map of [texture, bump]) {
        map.wrapS = map.wrapT = THREE.RepeatWrapping;
        map.anisotropy = 4;
    }
    const material = new THREE.MeshStandardMaterial({ color, metalness, roughness, map: texture, bumpMap: bump, bumpScale: painted ? .004 : .003 });
    material.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
        shader.uniforms.sbWearColor = { value: new THREE.Color(painted ? '#806044' : '#594326') };
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vSbPosition;\nvarying vec3 vSbNormal;');
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSbPosition = position;\nvSbNormal = normal;');
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vSbPosition;
      varying vec3 vSbNormal;
      uniform vec3 sbWearColor;
      float sbHash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
      float sbNoise(vec3 p){vec3 i=floor(p);vec3 f=fract(p);f=f*f*(3.0-2.0*f);
        return mix(mix(mix(sbHash(i),sbHash(i+vec3(1,0,0)),f.x),mix(sbHash(i+vec3(0,1,0)),sbHash(i+vec3(1,1,0)),f.x),f.y),mix(mix(sbHash(i+vec3(0,0,1)),sbHash(i+vec3(1,0,1)),f.x),mix(sbHash(i+vec3(0,1,1)),sbHash(i+vec3(1,1,1)),f.x),f.y),f.z);}
    `);
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      vec3 sbN=abs(normalize(vSbNormal));
      float sbEdge=1.0-max(max(sbN.x,sbN.y),sbN.z);
      float sbSpeckle=sbNoise(vSbPosition*31.0);
      float sbPatch=sbNoise(vSbPosition*5.0);
      float sbWear=smoothstep(0.07,0.22,sbEdge)*smoothstep(0.48,0.66,sbPatch+sbSpeckle*0.16);
      diffuseColor.rgb=mix(diffuseColor.rgb,sbWearColor,sbWear*0.75);
      diffuseColor.rgb*=0.88+0.12*sbNoise(vSbPosition*3.2);
    `);
    };
    material.customProgramCacheKey = (): string => 'sb-aged-surface-v3';
    return material;
}
