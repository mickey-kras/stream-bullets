import * as THREE from 'three';
import { agedSurface } from './surfaces';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
export interface StationController {
    view: (name: 'hero' | 'rear' | 'studio' | 'orbit') => void;
    motion: (enabled: boolean) => void;
    lights: (enabled: boolean) => void;
    dispose: () => void;
}
export function createStation(wrap: HTMLDivElement, onFailure: () => void): StationController {
    const lifecycle = new AbortController();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const mobile = window.matchMedia('(max-width: 700px)');
    let playing: boolean = !reduced.matches;
    let illuminated: boolean = true;
    let currentView: 'hero' | 'rear' | 'studio' | 'orbit' = 'hero';
    let dragging: boolean = false;
    let idleOrbit: boolean = false;
    let phase: number = 0;
    let lastTime: number = 0;
    const pointer = new THREE.Vector2();
    const scene = new THREE.Scene();
    // Transparent scene preserves the continuous page background.
    const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 100);
    const gpu: boolean = true;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    let environmentTarget: THREE.WebGLRenderTarget;
    {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile.matches ? 1.25 : 1.75));
        renderer.shadowMap.enabled = !mobile.matches;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.setClearColor('#0a2025', 0);
        const env = new RoomEnvironment();
        const pmrem = new THREE.PMREMGenerator(renderer);
        environmentTarget = pmrem.fromScene(env, 0.04);
        scene.environment = environmentTarget.texture;
        scene.environmentIntensity = 0.28;
        env.dispose();
        pmrem.dispose();
    }
    wrap.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', '3D model of a teal and brass broadcast station. Drag horizontally to turn it.');
    renderer.domElement.setAttribute('role', 'img');
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.minPolarAngle = 0.8;
    controls.maxPolarAngle = 1.5;
    controls.rotateSpeed = 0.45;
    controls.touches.ONE = THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
    controls.addEventListener('start', (): void => { dragging = true; idleOrbit = false; });
    controls.addEventListener('end', (): void => { dragging = false; });
    // Restore vertical page scrolling on touch; horizontal drag still turns the model.
    renderer.domElement.style.touchAction = 'pan-y';
    const station = new THREE.Group();
    scene.add(station);
    const building = new THREE.Group();
    building.name = "broadcast-building";
    building.scale.set(.83, .92, .83);
    building.position.y = .032;
    station.add(building);
    const teal = agedSurface('#286669', .08, .68, true);
    const darkTeal = agedSurface('#20484a', .06, .76, true);
    const cream = agedSurface('#d5c6a1', .03, .79, true);
    const gold = agedSurface('#b79155', .82, .44, false);
    const brass = agedSurface('#826039', .8, .82, false);
    const dark = new THREE.MeshStandardMaterial({ color: '#0c2428', roughness: 0.58 });
    const wood = new THREE.MeshStandardMaterial({ color: '#80533a', roughness: 0.55 });
    const leather = new THREE.MeshStandardMaterial({ color: '#9c5235', roughness: 0.48 });
    const warm = new THREE.MeshStandardMaterial({ color: '#ffe7ac', emissive: '#ffc75a', emissiveIntensity: 1.2 });
    const red = new THREE.MeshStandardMaterial({ color: '#4a100b', emissive: '#cb481c', emissiveIntensity: 0.4, metalness: 0.25, roughness: 0.28 });
    const screen = new THREE.MeshStandardMaterial({ color: '#77643c', emissive: '#f5bd65', emissiveIntensity: 0.8, roughness: 0.2 });
    function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = building): THREE.Mesh {
        const obj = new THREE.Mesh(geo, mat);
        obj.position.set(x, y, z);
        obj.castShadow = true;
        obj.receiveShadow = true;
        parent.add(obj);
        return obj;
    }
    function box(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, radius: number = 0.05, parent: THREE.Object3D = building): THREE.Mesh {
        return mesh(new RoundedBoxGeometry(w, h, d, gpu ? 3 : 1, Math.min(radius, w / 2, h / 2, d / 2)), mat, x, y, z, parent);
    }
    function slab(w: number, d: number, h: number, r: number, x: number, y: number, z: number, mat: THREE.Material, parent: THREE.Object3D = building): THREE.Mesh {
        const shape = new THREE.Shape();
        const l = -w / 2, t = -d / 2;
        shape.moveTo(l + r, t);
        shape.lineTo(l + w - r, t);
        shape.quadraticCurveTo(l + w, t, l + w, t + r);
        shape.lineTo(l + w, t + d - r);
        shape.quadraticCurveTo(l + w, t + d, l + w - r, t + d);
        shape.lineTo(l + r, t + d);
        shape.quadraticCurveTo(l, t + d, l, t + d - r);
        shape.lineTo(l, t + r);
        shape.quadraticCurveTo(l, t, l + r, t);
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: true, bevelThickness: .035, bevelSize: .035, bevelSegments: 2, steps: 1, curveSegments: gpu ? 20 : 6 });
        geometry.rotateX(-Math.PI / 2);
        geometry.translate(0, -h / 2, 0);
        return mesh(geometry, mat, x, y, z, parent);
    }
    function arch(w: number, h: number, depth: number, x: number, y: number, z: number, mat: THREE.Material): THREE.Mesh {
        const shape = new THREE.Shape();
        shape.moveTo(-w / 2, 0);
        shape.lineTo(w / 2, 0);
        shape.lineTo(w / 2, h - w / 2);
        shape.absarc(0, h - w / 2, w / 2, 0, Math.PI, false);
        shape.lineTo(-w / 2, 0);
        return mesh(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: .04, bevelThickness: .035, bevelSegments: 3, curveSegments: 24 }), mat, x, y, z);
    }
    function plaque(w: number, h: number, d: number, r: number, x: number, y: number, z: number, mat: THREE.Material, parent: THREE.Object3D = building): THREE.Mesh {
        const shape = new THREE.Shape();
        const l = -w / 2, b = -h / 2;
        shape.moveTo(l + r, b);
        shape.lineTo(l + w - r, b);
        shape.quadraticCurveTo(l + w, b, l + w, b + r);
        shape.lineTo(l + w, b + h - r);
        shape.quadraticCurveTo(l + w, b + h, l + w - r, b + h);
        shape.lineTo(l + r, b + h);
        shape.quadraticCurveTo(l, b + h, l, b + h - r);
        shape.lineTo(l, b + r);
        shape.quadraticCurveTo(l, b, l + r, b);
        return mesh(new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: true, bevelSize: .015, bevelThickness: .015, bevelSegments: 2, curveSegments: 12 }), mat, x, y, z, parent);
    }
    function roundedShape(w: number, h: number, r: number): THREE.Shape {
        const shape = new THREE.Shape();
        const l = -w / 2, b = -h / 2;
        shape.moveTo(l + r, b);
        shape.lineTo(l + w - r, b);
        shape.quadraticCurveTo(l + w, b, l + w, b + r);
        shape.lineTo(l + w, b + h - r);
        shape.quadraticCurveTo(l + w, b + h, l + w - r, b + h);
        shape.lineTo(l + r, b + h);
        shape.quadraticCurveTo(l, b + h, l, b + h - r);
        shape.lineTo(l, b + r);
        shape.quadraticCurveTo(l, b, l + r, b);
        return shape;
    }
    function frame(w: number, h: number, r: number, border: number, depth: number, x: number, y: number, z: number, mat: THREE.Material, parent: THREE.Object3D = building): THREE.Mesh {
        const shape = roundedShape(w, h, r);
        shape.holes.push(roundedShape(w - border * 2, h - border * 2, Math.max(.025, r - border)));
        return mesh(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: .012, bevelThickness: .012, bevelSegments: 2, curveSegments: 20 }), mat, x, y, z, parent);
    }
    function cyl(r: number, h: number, x: number, y: number, z: number, mat: THREE.Material, top: number = r, parent: THREE.Object3D = building): THREE.Mesh {
        return mesh(new THREE.CylinderGeometry(top, r, h, gpu ? 48 : 16), mat, x, y, z, parent);
    }
    function ball(r: number, x: number, y: number, z: number, mat: THREE.Material, parent: THREE.Object3D = building): THREE.Mesh {
        return mesh(new THREE.SphereGeometry(r, gpu ? 24 : 8, gpu ? 16 : 6), mat, x, y, z, parent);
    }
    function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, parent: THREE.Object3D = building): THREE.Mesh {
        const middle = a.clone().add(b).multiplyScalar(.5);
        const obj = mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 12), mat, middle.x, middle.y, middle.z, parent);
        obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        return obj;
    }
    function ring(radius: number, tube: number, x: number, y: number, z: number, mat: THREE.Material, parent: THREE.Object3D = building): THREE.Mesh {
        const obj = mesh(new THREE.TorusGeometry(radius, tube, gpu ? 12 : 5, gpu ? 96 : 32), mat, x, y, z, parent);
        obj.rotation.x = Math.PI / 2;
        return obj;
    }
    function label(text: string, w: number, h: number, x: number, y: number, z: number, color: string, bg: string, parent: THREE.Object3D = building): THREE.Mesh {
        const canvas = document.createElement('canvas');
        canvas.width = 1024;
        canvas.height = Math.round(1024 * h / w);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lines = text.split('\n');
        ctx.font = `400 ${Math.round(canvas.height * (text === 'ON AIR' ? 1.04 : lines.length > 1 ? .34 : .75))}px Anton, sans-serif`;
        ctx.fillStyle = color;
        if (text === 'ON AIR') {
            const glyphs = [...text];
            const widths = glyphs.map((glyph: string): number => ctx.measureText(glyph).width);
            const spacing = (860 - widths.reduce((a: number, b: number): number => a + b, 0)) / (glyphs.length - 1);
            let cursor = 82;
            ctx.textAlign = 'left';
            glyphs.forEach((glyph: string, i: number): void => { ctx.fillText(glyph, cursor, canvas.height * .53); cursor += widths[i]! + spacing; });
        }
        else
            lines.forEach((line: string, i: number): void => ctx.fillText(line, 512, canvas.height * (lines.length > 1 ? .3 + i * .4 : .52), 940));
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        const plane = mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 0.28, roughness: .5, transparent: text === 'ON AIR' }), x, y, z, parent);
        plane.visible = gpu;
        return plane;
    }
    // Wider deck leaves an accessible walkway around the smaller building.
    cyl(4.20, .24, 0, .15, 0, brass, 4.20, station);
    cyl(4.12, .07, 0, .30, 0, gold, 4.12, station);
    cyl(4.03, .08, 0, .36, 0, darkTeal, 4.03, station);
    ring(3.98, .025, 0, .41, 0, gold, station);
    ring(3.79, .012, 0, .41, 0, brass, station);
    for (let i = 0; i < 56; i++) {
        const a = i / 56 * Math.PI * 2;
        ball(.025, Math.sin(a) * 4.13, .24, Math.cos(a) * 4.13, gold, station);
    }
    // Streamline Moderne shell: broad rounded facade with wraparound glazing.
    slab(4.9, 3.0, .48, .85, -.4, .72, 0, teal);
    slab(4.92, 3.02, .06, .86, -.4, .48, 0, gold);
    slab(4.95, 3.04, .07, .87, -.4, .97, 0, gold);
    slab(4.75, 2.85, .075, .83, -.4, 1.03, 0, wood);
    box(3.65, 1.65, .22, -.4, 1.87, -1.34, darkTeal, .1);
    slab(4.98, 3.08, .57, .88, -.4, 3.27, 0, teal);
    for (const y of [3.02, 3.17, 3.42])
        slab(5.04, 3.13, .055, .9, -.4, y, 0, gold);
    slab(4.82, 2.9, .13, .85, -.4, 3.61, 0, darkTeal);
    const glass = new THREE.MeshPhysicalMaterial({ color: '#9aa59a', transparent: true, opacity: .23, metalness: .1, roughness: .09, side: THREE.DoubleSide, depthWrite: false });
    const windowPoints: THREE.Vector3[] = [];
    for (let i = 0; i <= 18; i++) {
        const a = Math.PI - i / 18 * Math.PI / 2;
        windowPoints.push(new THREE.Vector3(-1.97 + Math.cos(a) * .82, 0, .62 + Math.sin(a) * .82));
    }
    windowPoints.push(new THREE.Vector3(1.17, 0, 1.44));
    for (let i = 1; i <= 18; i++) {
        const a = Math.PI / 2 - i / 18 * Math.PI / 2;
        windowPoints.push(new THREE.Vector3(1.17 + Math.cos(a) * .82, 0, .62 + Math.sin(a) * .82));
    }
    const vertices: number[] = [];
    for (let i = 0; i < windowPoints.length - 1; i++) {
        const a = windowPoints[i]!, b = windowPoints[i + 1]!;
        vertices.push(a.x, 1.08, a.z, b.x, 1.08, b.z, a.x, 2.97, a.z, b.x, 1.08, b.z, b.x, 2.97, b.z, a.x, 2.97, a.z);
    }
    const glazing = new THREE.BufferGeometry();
    glazing.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    glazing.computeVertexNormals();
    const panes = mesh(glazing, glass, 0, 0, 0);
    panes.castShadow = false;
    panes.visible = gpu;
    for (const i of [0, 10, 18, 19, 28, 37]) {
        const v = windowPoints[i]!;
        rod(new THREE.Vector3(v.x, 1.03, v.z), new THREE.Vector3(v.x, 3.01, v.z), .028, brass);
    }
    for (const y of [1.07, 2.96]) {
        const curve = new THREE.CatmullRomCurve3(windowPoints.map((v: THREE.Vector3): THREE.Vector3 => new THREE.Vector3(v.x, y, v.z)));
        mesh(new THREE.TubeGeometry(curve, 80, .025, 8, false), gold, 0, 0, 0);
    }
    const backPoints: THREE.Vector3[] = [new THREE.Vector3(-2.79, 0, .62), new THREE.Vector3(-2.79, 0, -.62)];
    for (let i = 1; i <= 16; i++) {
        const a = Math.PI + i / 16 * Math.PI / 2;
        backPoints.push(new THREE.Vector3(-1.97 + Math.cos(a) * .82, 0, -.62 + Math.sin(a) * .82));
    }
    backPoints.push(new THREE.Vector3(1.17, 0, -1.44));
    for (let i = 1; i <= 16; i++) {
        const a = Math.PI * 1.5 + i / 16 * Math.PI / 2;
        backPoints.push(new THREE.Vector3(1.17 + Math.cos(a) * .82, 0, -.62 + Math.sin(a) * .82));
    }
    backPoints.push(new THREE.Vector3(1.99, 0, .62));
    const rearVertices: number[] = [];
    for (let i = 0; i < backPoints.length - 1; i++) {
        const a = backPoints[i]!, b = backPoints[i + 1]!;
        rearVertices.push(a.x, 1.04, a.z, b.x, 1.04, b.z, a.x, 3.0, a.z, b.x, 1.04, b.z, b.x, 3.0, b.z, a.x, 3.0, a.z);
    }
    const rearGeometry = new THREE.BufferGeometry();
    rearGeometry.setAttribute('position', new THREE.Float32BufferAttribute(rearVertices, 3));
    rearGeometry.computeVertexNormals();
    const rearMaterial = agedSurface('#174346', .4, .86, true);
    rearMaterial.side = THREE.DoubleSide;
    mesh(rearGeometry, rearMaterial, 0, 0, 0);
    // Visible fasteners, sheet joins and service panels.
    for (let i = 0; i < 18; i++)
        ball(.022, -2.15 + i * .205, .76, 1.515, brass);
    for (const x of [-1.65, -.5, .65])
        box(.008, .35, .015, x, .72, 1.52, brass, .003);
    // Acoustic panels on the back wall.
    for (let i = 0; i < 14; i++) {
        box(.13, 1.25, .13, -2.1 + i * .28, 1.85, -1.08, i % 2 ? darkTeal : brass, .04);
    }
    // Broad studio desk with microphone, console, radio and chair.
    slab(3.65, 1.05, .13, .35, -.45, 1.54, .23, wood);
    slab(3.68, 1.08, .035, .35, -.45, 1.62, .23, wood);
    for (const x of [-1.8, 1])
        box(.12, .55, .65, x, 1.04, .3, darkTeal, .03);
    const mic = new THREE.Group();
    mic.name = 'microphone';
    mic.position.set(-.65, 1.64, .52);
    mic.scale.setScalar(.72);
    building.add(mic);
    cyl(.22, .045, 0, .025, 0, gold, .19, mic);
    cyl(.15, .06, 0, .07, 0, brass, .07, mic);
    cyl(.027, .28, 0, .24, 0, gold, .027, mic);
    const capsule = ball(.16, 0, .61, 0, brass, mic);
    capsule.scale.set(1, 1.65, .78);
    box(.25, .32, .025, 0, .62, .12, dark, .012, mic);
    for (let i = 0; i < 7; i++) {
        const y = .47 + i * .047;
        const width = .25 - Math.abs(i - 3) * .012;
        box(width, .014, .035, 0, y, .139, gold, .006, mic);
    }
    for (const x of [-.07, 0, .07])
        box(.012, .08, .02, x, .82, .09, dark, .005, mic);
    const yoke = new THREE.CatmullRomCurve3([new THREE.Vector3(-.22, .64, 0), new THREE.Vector3(-.22, .43, 0), new THREE.Vector3(-.14, .34, 0), new THREE.Vector3(.14, .34, 0), new THREE.Vector3(.22, .43, 0), new THREE.Vector3(.22, .64, 0)]);
    mesh(new THREE.TubeGeometry(yoke, 32, .022, 8, false), gold, 0, 0, 0, mic);
    for (const x of [-.21, .21])
        ball(.038, x, .61, 0, gold, mic);
    box(.96, .73, .58, .68, 1.99, -.04, brass, .15);
    box(.76, .54, .04, .62, 2.03, .265, dark, .1);
    box(.64, .41, .045, .62, 2.03, .295, screen, .09);
    for (let i = 0; i < 3; i++) {
        const dial = cyl(.037, .04, 1.06, 1.77 + i * .13, .31, gold);
        dial.rotation.x = Math.PI / 2;
    }
    box(.85, .10, .55, -1.55, 1.68, .38, darkTeal, .05);
    for (let i = 0; i < 5; i++) {
        box(.025, .014, .3, -1.83 + i * .14, 1.739, .35, brass, .006);
        box(.07, .035, .06, -1.83 + i * .14, 1.76, .25 + (i % 3) * .08, cream, .01);
    }
    box(.72, .16, .65, -1.05, 1.37, -.6, leather, .14);
    box(.76, .68, .2, -1.05, 1.72, -.9, leather, .15);
    cyl(.04, .35, -1.05, 1.19, -.6, gold);
    cyl(.3, .04, -1.05, 1.04, -.6, dark);
    // Deep bezel with an open center and a red face set behind its lip.
    frame(2.35, .83, .26, .105, .14, -.6, 3.34, 1.59, brass);
    frame(2.22, .70, .21, .035, .035, -.6, 3.34, 1.735, gold);
    plaque(2.17, .65, .018, .19, -.6, 3.34, 1.585, red);
    const sign = label('ON AIR', 1.94, .53, -.6, 3.34, 1.625, '#fff0be', 'rgba(0,0,0,0)');
    (sign.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.2;
    // Side wing: the fluted crown stands beside the entry, not above the door.
    arch(1.05, 3.8, .32, 1.40, .48, 1.57, teal);
    for (let i = 0; i < 5; i++) {
        const height = 2.75 - i * .10;
        box(.11, height, .11, 1.03 + i * .17, 2.62 - i * .05, 1.95, gold, .05);
    }
    const entrance = new THREE.Group();
    entrance.name = 'side-entrance';
    entrance.position.set(2.18, 0, .66);
    entrance.rotation.y = .30;
    building.add(entrance);
    slab(1.55, 1.94, 2.55, .55, 0, 1.76, -.66, teal, entrance);
    // Door backing is flush with the wall; the perimeter frame creates the recess.
    plaque(.92, 1.89, .025, .17, 0, 1.63, .34, brass, entrance);
    frame(1.07, 2.04, .22, .08, .12, 0, 1.63, .36, gold, entrance);
    frame(.95, 1.92, .17, .035, .035, 0, 1.63, .405, dark, entrance);
    plaque(.14, .62, .018, .07, 0, 1.75, .386, screen, entrance);
    frame(.22, .70, .10, .035, .025, 0, 1.75, .41, gold, entrance);
    box(.025, .23, .045, -.30, 1.38, .43, gold, .012, entrance);
    // One continuous cream surround rises on the LEFT, then sweeps over the entry.
    const porchSurround = new THREE.Shape();
    porchSurround.moveTo(-.88, .68);
    porchSurround.lineTo(-.88, 2.12);
    porchSurround.quadraticCurveTo(-.88, 2.98, -.10, 2.98);
    porchSurround.lineTo(.69, 2.98);
    porchSurround.quadraticCurveTo(.96, 2.98, .98, 2.77);
    porchSurround.lineTo(.79, 2.69);
    porchSurround.lineTo(-.08, 2.69);
    porchSurround.quadraticCurveTo(-.61, 2.69, -.61, 2.10);
    porchSurround.lineTo(-.61, .68);
    porchSurround.closePath();
    mesh(new THREE.ExtrudeGeometry(porchSurround, { depth: .58, bevelEnabled: true, bevelThickness: .025, bevelSize: .025, bevelSegments: 3, curveSegments: 24 }), cream, 0, 0, .10, entrance);
    for (const x of [-.80, -.70])
        box(.017, 1.02, .025, x, 1.39, .715, brass, .008, entrance);
    cyl(.19, .07, 0, 2.72, .17, gold, .19, entrance);
    const porchBulb = ball(.14, 0, 2.66, .17, warm, entrance);
    porchBulb.scale.y = .6;
    for (let i = 0; i < 3; i++) {
        slab(1.76 - i * .18, 1.24 - i * .22, .11, .42, 0, .46 + i * .115, 1.10 - i * .11, brass, entrance);
        slab(1.78 - i * .18, 1.26 - i * .22, .025, .43, 0, .52 + i * .115, 1.10 - i * .11, gold, entrance);
    }
    for (const x of [-.69, .69]) {
        rod(new THREE.Vector3(x, .55, 1.40), new THREE.Vector3(x, 1.22, 1.40), .023, gold, entrance);
        rod(new THREE.Vector3(x, .78, .57), new THREE.Vector3(x, 1.42, .57), .023, gold, entrance);
        const handrail = new THREE.CatmullRomCurve3([new THREE.Vector3(x, 1.22, 1.43), new THREE.Vector3(x, 1.30, 1.27), new THREE.Vector3(x, 1.42, .73), new THREE.Vector3(x, 1.42, .57)]);
        mesh(new THREE.TubeGeometry(handrail, 18, .025, 8, false), gold, 0, 0, 0, entrance);
    }
    // Roof tanks, vents and brass pipework.
    cyl(.43, .85, 1.85, 3.4, -.77, cream);
    ball(.43, 1.85, 3.825, -.77, cream);
    ring(.438, .035, 1.85, 3.62, -.77, red);
    ring(.438, .035, 1.85, 3.5, -.77, red);
    cyl(.27, .7, 2.4, 2.7, -.7, darkTeal);
    ball(.27, 2.4, 3.05, -.7, gold);
    rod(new THREE.Vector3(2.65, 1, -.8), new THREE.Vector3(2.65, 2.6, -.8), .08, brass);
    rod(new THREE.Vector3(2.65, 2.6, -.8), new THREE.Vector3(2.25, 2.6, -.8), .08, brass);
    for (let i = 0; i < 6; i++)
        box(.42, .035, .12, -1.85, 3.70, -.6 + i * .18, brass, .015);
    // Triangular broadcast mast with bracing.
    const mast = new THREE.Group();
    mast.position.set(-.35, 3.72, -.3);
    mast.scale.set(.82, .82, .82);
    building.add(mast);
    const corners = [new THREE.Vector3(-.53, 0, .37), new THREE.Vector3(.53, 0, .37), new THREE.Vector3(0, 0, -.5)];
    const apex = new THREE.Vector3(0, 2.22, 0);
    for (const c of corners) {
        rod(c, apex, .045, gold, mast);
    }
    for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
            const a = corners[i]!.clone().lerp(apex, j * .27);
            const b = corners[(i + 1) % 3]!.clone().lerp(apex, (j + 1) * .27);
            rod(a, b, .014, brass, mast);
            const c = corners[(i + 1) % 3]!.clone().lerp(apex, j * .27);
            rod(a, c, .018, gold, mast);
        }
    }
    cyl(.065, 2.5, 0, 1.25, 0, brass, .024, mast);
    ring(.48, .032, 0, .91, 0, gold, mast);
    ring(.37, .028, 0, 1.58, 0, gold, mast);
    for (const [height, radius] of [[.91, .48], [1.58, .37]] as const) {
        for (const corner of corners) {
            const direction = new THREE.Vector3(corner.x, 0, corner.z).normalize();
            rod(new THREE.Vector3(0, height, 0), new THREE.Vector3(direction.x * radius, height, direction.z * radius), .017, gold, mast);
        }
    }
    cyl(.028, .25, 0, 2.47, 0, gold, .028, mast);
    ball(.145, 0, 2.65, 0, gold, mast);
    const signals: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++)
        signals.push(ring(.78 + i * .73, .013, 0, 2.65, 0, warm, mast));
    const ornaments = new THREE.Group();
    building.add(ornaments);
    const atom = new THREE.Group();
    atom.name = 'atomic-sculpture';
    atom.position.set(-2.90, 1.82, 1.80);
    station.add(atom);
    cyl(.30, .12, 0, -1.34, 0, brass, .30, atom);
    cyl(.28, .20, 0, -1.18, 0, gold, .23, atom);
    ring(.26, .025, 0, -1.13, 0, red, atom);
    cyl(.23, .72, 0, -.72, 0, gold, .055, atom);
    for (let i = 0; i < 3; i++) {
        const fin = mesh(new THREE.ConeGeometry(.10, .52, 3), brass, Math.sin(i * Math.PI * 2 / 3) * .14, -.80, Math.cos(i * Math.PI * 2 / 3) * .14, atom);
        fin.rotation.y = i * Math.PI * 2 / 3;
    }
    ball(.17, 0, 0, 0, gold, atom);
    for (let i = 0; i < 3; i++) {
        const orbitGroup = new THREE.Group();
        orbitGroup.rotation.set(.25, i * .22, (i - 1) * Math.PI / 3);
        atom.add(orbitGroup);
        const points: THREE.Vector3[] = [];
        for (let j = 0; j < 96; j++) {
            const a = j / 96 * Math.PI * 2;
            points.push(new THREE.Vector3(Math.cos(a) * .62, Math.sin(a) * .27, 0));
        }
        const curve = new THREE.CatmullRomCurve3(points, true);
        mesh(new THREE.TubeGeometry(curve, 96, .013, 8, true), gold, 0, 0, 0, orbitGroup);
        const angle = .5 + i * 1.7;
        ball(.045, Math.cos(angle) * .62, Math.sin(angle) * .27, 0, gold, orbitGroup);
    }
    const boards: THREE.Group[] = [];
    const boardSpecs: ReadonlyArray<readonly [
        string,
        number,
        number,
        number,
        number
    ]> = [['SUGGEST A\nTOPIC', -2.25, 4.7, .1, -.14], ['VOTE IN A\nPOLL', -2.65, 3.91, .65, .1], ['DISCUSS THE\nSTREAM', 2.1, 4.75, -.4, .12]];
    for (const [text, x, y, z, angle] of boardSpecs) {
        const board = new THREE.Group();
        board.position.set(x, y, z);
        board.rotation.y = angle;
        ornaments.add(board);
        boards.push(board);
        plaque(1.85, .81, .1, .16, 0, 0, -.08, brass, board);
        plaque(1.77, .73, .07, .14, 0, 0, .03, cream, board);
        label(text, 1.38, .49, 0, 0, .135, '#18383a', '#d5c6a1', board);
        for (const bx of [-.69, .69])
            for (const by of [-.21, .21])
                ball(.025, bx, by, .14, brass, board);
        const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-.35, 3.9, -.3), new THREE.Vector3(x * .55, y - .15, z - .3), new THREE.Vector3(x, y - .25, z - .09)]);
        mesh(new THREE.TubeGeometry(curve, 20, .025, 8, false), brass, 0, 0, 0, ornaments);
    }
    // Analog instrumentation and an amber scan-line display.
    const crt = label('~ 104.8 FM ~', .53, .28, .62, 2.03, .323, '#edcc7a', '#1a261b');
    (crt.material as THREE.MeshStandardMaterial).emissiveIntensity = .85;
    for (let i = 0; i < 10; i++)
        box(.59, .006, .005, .62, 1.86 + i * .035, .329, dark, .001);
    for (let i = 0; i < 4; i++) {
        const lamp = cyl(.035, .025, .35 + i * .16, 1.73, .28, warm);
        lamp.rotation.x = Math.PI / 2;
    }
    label('CIVIL BROADCAST SERVICE', 1.65, .12, -.7, .73, 1.543, '#c7b782', '#1d575b');
    // Perimeter rail follows the enlarged deck; the front entry remains open.
    for (let i = 0; i < 25; i++) {
        const a = -2.15 + i * 4.30 / 24;
        const x = Math.sin(a) * 3.91, z = -Math.cos(a) * 3.91;
        rod(new THREE.Vector3(x, .4, z), new THREE.Vector3(x, 1.03, z), .025, gold, station);
        if (i < 24) {
            const b = -2.15 + (i + 1) * 4.30 / 24;
            for (const y of [.7, 1.03])
                rod(new THREE.Vector3(x, y, z), new THREE.Vector3(Math.sin(b) * 3.91, y, -Math.cos(b) * 3.91), .018, brass, station);
        }
    }
    // Equilateral triangle: identical radius and exactly 120 degrees between lamps.
    const practicals: THREE.PointLight[] = [];
    const globePositions: THREE.Vector3[] = [];
    for (let i = 0; i < 3; i++) {
        const angle = i * Math.PI * 2 / 3;
        const x = Math.sin(angle) * 3.65, z = Math.cos(angle) * 3.65;
        globePositions.push(new THREE.Vector3(x, .44, z));
        cyl(.17, .07, x, .44, z, brass, .17, station);
        cyl(.14, .16, x, .55, z, gold, .075, station);
        cyl(.055, .40, x, .81, z, gold, .055, station);
        cyl(.09, .08, x, 1.04, z, brass, .09, station);
        ball(.16, x, 1.23, z, warm, station);
        ring(.185, .018, x, 1.22, z, gold, station);
        const light = new THREE.PointLight('#ffcc78', 2, 2, 2);
        light.position.set(x, 1.35, z);
        station.add(light);
        practicals.push(light);
    }
    // Warm hanging lamps inside the studio.
    for (const x of [-1.4, .55]) {
        cyl(.015, .52, x, 2.70, .1, gold);
        cyl(.22, .14, x, 2.37, .1, gold, .07);
        ball(.075, x, 2.29, .1, warm);
        const light = new THREE.PointLight('#ffc37a', 4, 3, 2);
        light.position.set(x, 2.25, .4);
        building.add(light);
        practicals.push(light);
    }
    // Built-in planting beds share the facade plinth and brass footing.
    const leafMaterial = new THREE.MeshStandardMaterial({ color: '#758d4c', roughness: .68, side: THREE.DoubleSide });
    slab(4.72, 2.98, .12, .84, -.4, .46, .09, gold);
    plaque(1.38, .36, .07, .16, .52, .65, 1.51, cream);
    const beds: ReadonlyArray<readonly [
        number,
        number,
        number
    ]> = [[-1.65, 1.80, 1.20], [.20, 2.20, 1.00]];
    for (const [x, z, width] of beds) {
        slab(width, .86, .36, .32, x, .68, z, cream);
        slab(width + .025, .88, .08, .33, x, .48, z, gold);
        slab(width - .12, .70, .025, .27, x, .875, z, wood);
        for (let plant = 0; plant < 3; plant++) {
            const px = x + (plant - 1) * width * .25;
            const pz = z + (plant % 2) * .07;
            for (let i = 0; i < 7; i++) {
                const angle = -1.1 + i * 2.2 / 6 + plant * .04;
                const length = (x > 0 ? .46 : .35) + (i % 3) * .06;
                const positions: number[] = [];
                const indices: number[] = [];
                for (let j = 0; j <= 10; j++) {
                    const t = j / 10;
                    const distance = t * length;
                    const height = .89 + Math.sin(t * Math.PI * .8) * length * .8;
                    const halfWidth = Math.sin(t * Math.PI) * .075;
                    for (const side of [-1, 1])
                        positions.push(px + Math.sin(angle) * distance + Math.cos(angle) * halfWidth * side, height - Math.abs(side) * halfWidth * .25, pz + Math.cos(angle) * distance - Math.sin(angle) * halfWidth * side);
                    if (j < 10) {
                        const n = j * 2;
                        indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);
                    }
                }
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                geometry.setIndex(indices);
                geometry.computeVertexNormals();
                mesh(geometry, leafMaterial, 0, 0, 0);
            }
        }
    }
    // Rear service elevation, oriented outward for orbit inspection.
    const rear = new THREE.Group();
    rear.name = 'rear-service';
    rear.position.set(-.40, 0, -1.52);
    rear.rotation.y = Math.PI;
    building.add(rear);
    // Round-corner observation window into the station, with a modeled shutter frame.
    plaque(1.35, .76, .04, .17, -.84, 2.25, .03, dark, rear);
    frame(1.49, .90, .21, .075, .08, -.84, 2.25, .045, brass, rear);
    plaque(1.29, .70, .02, .14, -.84, 2.25, .095, screen, rear);
    box(.035, .68, .035, -.84, 2.25, .135, gold, .012, rear);
    label('STATION SB—01', 1.28, .18, -.84, 2.91, .08, '#edbd53', '#174346', rear);
    // Radio transmitter with analog meter, bank of cooling louvers and inspection latch.
    box(1.28, 1.40, .38, .82, 1.69, .20, cream, .10, rear);
    frame(.54, .36, .06, .035, .025, .82, 2.08, .407, brass, rear);
    label('MHz 104.8', .45, .25, .82, 2.08, .447, '#edcc7a', '#1a261b', rear);
    for (let i = 0; i < 7; i++)
        box(.94, .04, .055, .82, 1.15 + i * .08, .425, dark, .012, rear);
    for (const x of [.38, 1.26])
        box(.05, .17, .07, x, 1.93, .42, gold, .018, rear);
    label('TRANSMITTER', .94, .14, .82, 2.53, .07, '#edbd53', '#174346', rear);
    // Exposed conduit links the equipment into the roof and a circular valve.
    const conduit = new THREE.CatmullRomCurve3([new THREE.Vector3(1.57, .78, .22), new THREE.Vector3(1.57, 2.64, .22), new THREE.Vector3(1.37, 2.82, .22), new THREE.Vector3(.42, 2.82, .22), new THREE.Vector3(.25, 3.36, .05)]);
    mesh(new THREE.TubeGeometry(conduit, 40, .045, 10, false), brass, 0, 0, 0, rear);
    mesh(new THREE.TorusGeometry(.17, .022, 8, 32), red, 1.57, 1.43, .32, rear);
    for (let i = 0; i < 3; i++) {
        const a = i * Math.PI * 2 / 3;
        rod(new THREE.Vector3(1.57, 1.43, .32), new THREE.Vector3(1.57 + Math.cos(a) * .17, 1.43 + Math.sin(a) * .17, .32), .012, gold, rear);
    }
    // Roof-access ladder on the rear corner, secured at both ends.
    for (const x of [-1.90, -1.52])
        rod(new THREE.Vector3(x, .53, .18), new THREE.Vector3(x, 3.69, .18), .027, gold, rear);
    for (let i = 0; i < 11; i++)
        rod(new THREE.Vector3(-1.90, .69 + i * .27, .18), new THREE.Vector3(-1.52, .69 + i * .27, .18), .022, brass, rear);
    for (const y of [.62, 3.10])
        for (const x of [-1.90, -1.52])
            rod(new THREE.Vector3(x, y, .02), new THREE.Vector3(x, y, .18), .025, brass, rear);
    // Rear walkway grating and a roof exhaust give the service side depth.
    slab(3.8, .70, .06, .10, -.4, .46, -1.97, darkTeal);
    for (let i = 0; i < 24; i++)
        box(.025, .025, .62, -2.12 + i * .15, .51, -1.97, brass, .008);
    cyl(.23, .54, -1.45, 3.94, -.86, brass);
    cyl(.33, .09, -1.45, 4.24, -.86, gold, .33);
    for (let i = 0; i < 5; i++)
        ring(.238, .012, -1.45, 3.75 + i * .09, -.86, gold);
    // Sign backs have access covers and mounting bolts instead of blank slabs.
    for (let i = 0; i < boards.length; i++) {
        const back = new THREE.Group();
        back.name = "sign-back";
        back.rotation.y = Math.PI;
        back.position.z = -.10;
        boards[i]!.add(back);
        plaque(1.28, .43, .018, .08, 0, 0, .012, darkTeal, back);
        label('SB—01 / ' + String(i + 1).padStart(2, '0'), .93, .16, 0, 0, .05, '#d5c6a1', '#20484a', back);
        for (const x of [-.70, .70])
            for (const y of [-.23, .23])
                ball(.023, x, y, .025, brass, back);
    }
    const atmosphere = new THREE.Group();
    scene.add(atmosphere);
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = glowCanvas.height = 128;
    const glowContext = glowCanvas.getContext('2d')!;
    const glowGradient = glowContext.createRadialGradient(64, 64, 0, 64, 64, 64);
    glowGradient.addColorStop(0, 'rgba(255,221,154,.8)');
    glowGradient.addColorStop(.25, 'rgba(255,183,76,.17)');
    glowGradient.addColorStop(1, 'rgba(255,170,60,0)');
    glowContext.fillStyle = glowGradient;
    glowContext.fillRect(0, 0, 128, 128);
    const glowTexture = new THREE.CanvasTexture(glowCanvas);
    glowTexture.colorSpace = THREE.SRGBColorSpace;
    const halos: THREE.Sprite[] = [];
    for (const light of practicals) {
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, transparent: true, opacity: .12, blending: THREE.AdditiveBlending, depthWrite: false }));
        halo.position.copy(light.position);
        halo.scale.set(.38, .38, 1);
        halo.visible = gpu;
        light.parent!.add(halo);
        halos.push(halo);
    }
    const dustPositions: number[] = [];
    for (let i = 0; i < 80; i++)
        dustPositions.push(Math.sin(i * 12.9) * 4, .5 + (i * 1.618 % 5), Math.cos(i * 7.7) * 3);
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute('position', new THREE.Float32BufferAttribute(dustPositions, 3));
    const dust = new THREE.Points(dustGeometry, new THREE.PointsMaterial({ color: '#d4bc7e', size: .018, transparent: true, opacity: .32, depthWrite: false, blending: THREE.AdditiveBlending }));
    atmosphere.add(dust);
    atmosphere.visible = gpu && !mobile.matches;
    const ambient = new THREE.HemisphereLight('#88b7b7', '#271b0d', .7);
    scene.add(ambient);
    const key = new THREE.DirectionalLight('#ffe4b0', 2.4);
    key.position.set(-4, 9, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -6;
    key.shadow.camera.right = 6;
    key.shadow.camera.top = 7;
    key.shadow.camera.bottom = -6;
    key.shadow.normalBias = .03;
    scene.add(key);
    const rim = new THREE.DirectionalLight('#72b7bd', 1.7);
    rim.position.set(5, 5, -4);
    scene.add(rim);
    const floor = mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: .24 }), 0, -.02, 0, scene);
    floor.rotation.x = -Math.PI / 2;
    floor.castShadow = false;
    floor.visible = gpu;
    const targetPosition = new THREE.Vector3();
    const targetLook = new THREE.Vector3();
    let transitioning: boolean = true;
    let needsRender: boolean = true;
    function view(name: 'hero' | 'rear' | 'studio' | 'orbit'): void {
        const cutToView: boolean = name === 'rear' || currentView === 'rear';
        currentView = name;
        idleOrbit = name === 'orbit';
        transitioning = true;
        needsRender = true;
        station.rotation.set(0, 0, 0);
        pointer.set(0, 0);
        if (name === 'rear') {
            targetPosition.set(-6.35, 4.7, -15.1);
            targetLook.set(0, 2.65, 0);
        }
        else if (name === 'studio') {
            targetPosition.set(3.1, 3.1, 8.1);
            targetLook.set(0, 1.95, .2);
        }
        else {
            targetPosition.set(6.35, 4.7, 15.1);
            targetLook.set(0, 2.65, 0);
        }
        if (reduced.matches || cutToView) {
            camera.position.copy(targetPosition);
            controls.target.copy(targetLook);
            transitioning = false;
            needsRender = true;
        }
    }
    view('hero');
    camera.position.copy(targetPosition);
    controls.target.copy(targetLook);
    controls.update();
    ornaments.visible = !mobile.matches;
    const resize = new ResizeObserver((): void => {
        needsRender = true;
        const w = wrap.clientWidth, h = wrap.clientHeight;
        if (w === 0 || h === 0)
            return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        ornaments.visible = !mobile.matches;
        atmosphere.visible = gpu && !mobile.matches;
        if (renderer instanceof THREE.WebGLRenderer) {
            renderer.setPixelRatio(Math.min(devicePixelRatio, mobile.matches ? 1.25 : 1.75));
            renderer.shadowMap.enabled = !mobile.matches;
        }
    });
    resize.observe(wrap);
    wrap.addEventListener('pointermove', (e: PointerEvent): void => { if (e.pointerType === 'mouse' && !dragging) {
        const r = wrap.getBoundingClientRect();
        pointer.set((e.clientX - r.left) / r.width * 2 - 1, (e.clientY - r.top) / r.height * 2 - 1);
    } }, { signal: lifecycle.signal });
    wrap.addEventListener('pointerleave', (): void => { pointer.set(0, 0); }, { signal: lifecycle.signal });
    reduced.addEventListener('change', (): void => { playing = !reduced.matches; if (reduced.matches && transitioning) {
        camera.position.copy(targetPosition);
        controls.target.copy(targetLook);
        transitioning = false;
        needsRender = true;
    } }, { signal: lifecycle.signal });
    function lights(enabled: boolean): void {
        illuminated = enabled;
        needsRender = true;
        warm.emissiveIntensity = illuminated ? 1.2 : 0;
        red.emissiveIntensity = illuminated ? .4 : 0;
        screen.emissiveIntensity = illuminated ? .8 : 0;
        practicals.forEach((light: THREE.PointLight): void => { light.visible = illuminated; });
        halos.forEach((halo: THREE.Sprite): void => { halo.visible = illuminated; });
        (sign.material as THREE.MeshStandardMaterial).emissiveIntensity = illuminated ? 1.2 : 0;
    }
    let visible: boolean = true;
    const visibilityObserver = new IntersectionObserver((entries: IntersectionObserverEntry[]): void => { visible = entries[0]!.isIntersecting; });
    visibilityObserver.observe(wrap);
    let frameId: number = 0;
    controls.addEventListener('change', (): void => { needsRender = true; });
    window.addEventListener('resize', (): void => { needsRender = true; }, { signal: lifecycle.signal });
    function animate(time: number): void {
        frameId = requestAnimationFrame(animate);
        const dt = Math.min((time - lastTime) / 1000, .05);
        lastTime = time;
        if (document.hidden || !visible)
            return;
        if (playing) {
            phase += dt;
            dust.rotation.y = phase * .015;
            dust.position.y = Math.sin(phase * .15) * .08;
            signals.forEach((s: THREE.Mesh, i: number): void => { const scale = 1 + Math.sin(phase * 1.5 - i * .9) * .035; s.scale.setScalar(scale); s.rotation.z = Math.sin(phase * .5) * .025; });
        }
        if (transitioning && !dragging) {
            camera.position.lerp(targetPosition, Math.min(1, dt * 5));
            controls.target.lerp(targetLook, Math.min(1, dt * 5));
            if (camera.position.distanceTo(targetPosition) < .02)
                transitioning = false;
        }
        if (playing && !dragging && !transitioning) {
            if (idleOrbit)
                station.rotation.y += dt * .12;
            else {
                station.rotation.y = THREE.MathUtils.lerp(station.rotation.y, pointer.x * .12, dt * 4);
                station.rotation.x = THREE.MathUtils.lerp(station.rotation.x, pointer.y * .025, dt * 4);
            }
        }
        controls.update();
        if (playing || needsRender || transitioning) {
            scene.updateMatrixWorld(true);
            camera.updateMatrixWorld(true);
            renderer.render(scene, camera);
            needsRender = false;
        }
    }
    frameId = requestAnimationFrame(animate);
    renderer.domElement.addEventListener('webglcontextlost', (event: Event): void => { event.preventDefault(); cancelAnimationFrame(frameId); onFailure(); }, { signal: lifecycle.signal });
    return {
        view,
        motion: (enabled: boolean): void => { playing = enabled; needsRender = true; },
        lights,
        dispose: (): void => {
            cancelAnimationFrame(frameId);
            lifecycle.abort();
            resize.disconnect();
            visibilityObserver.disconnect();
            controls.dispose();
            const geometries = new Set<THREE.BufferGeometry>();
            const materials = new Set<THREE.Material>();
            const textures = new Set<THREE.Texture>();
            scene.traverse((object: THREE.Object3D): void => {
                if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Sprite) {
                    if ('geometry' in object)
                        geometries.add(object.geometry);
                    const assigned: THREE.Material[] = Array.isArray(object.material) ? object.material : [object.material];
                    for (const material of assigned) {
                        materials.add(material);
                        for (const value of Object.values(material) as unknown[]) {
                            if (value instanceof THREE.Texture)
                                textures.add(value);
                        }
                    }
                }
            });
            geometries.forEach((geometry: THREE.BufferGeometry): void => geometry.dispose());
            materials.forEach((material: THREE.Material): void => material.dispose());
            textures.forEach((texture: THREE.Texture): void => texture.dispose());
            key.shadow.dispose();
            environmentTarget.dispose();
            renderer.dispose();
            renderer.domElement.remove();
        }
    };
}
