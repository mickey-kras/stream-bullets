import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createFlips } from "../app/components/station/flips";
import { createLook } from "../app/components/station/look";
import { askForTilt, onFirstMotion, tiltNeedsAsking } from "../app/components/station/tilt";
import { batchStatic } from "../app/components/station/merge";

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A stand-in for the station wrapper: an event target with a fixed 1000 x 500 box. */
function host(): HTMLElement {
  return Object.assign(new EventTarget(), {
    getBoundingClientRect: (): object => ({ left: 0, top: 0, width: 1000, height: 500 }),
    style: {} as CSSStyleDeclaration,
  }) as unknown as HTMLElement;
}

function pointer(type: string, pointerType: string, x: number, y: number, timeStamp = 0): Event {
  const e = new Event(type);
  Object.defineProperties(e, {
    pointerType: { value: pointerType },
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
    timeStamp: { value: timeStamp },
  });
  return e;
}

function camera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(30, 2, 0.1, 100);
  c.position.set(0, 0, 10);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld();
  return c;
}

describe("look-around", (): void => {
  it("leans toward the mouse, lets go when it leaves and undoes the lean after each frame", (): void => {
    const wrap = host();
    const lifecycle = new AbortController();
    const look = createLook(wrap, lifecycle.signal);
    const cam = camera();
    const target = new THREE.Vector3();
    wrap.dispatchEvent(pointer("pointermove", "touch", 1000, 500));
    expect(look.step(0.016, true)).toBe(false);
    wrap.dispatchEvent(pointer("pointermove", "mouse", 1000, 500));
    for (let i = 0; i < 60; i++) look.step(0.016, true);
    look.apply(cam, target);
    // Mouse to the right moves the camera right; mouse down moves it lower.
    expect(cam.position.x).toBeGreaterThan(0.5);
    expect(cam.position.y).toBeLessThan(-0.2);
    expect(cam.position.length()).toBeCloseTo(10, 5);
    look.restore(cam, target);
    expect(cam.position.toArray()).toEqual([0, 0, 10]);
    wrap.dispatchEvent(new Event("pointerleave"));
    for (let i = 0; i < 120; i++) look.step(0.016, true);
    look.apply(cam, target);
    expect(Math.abs(cam.position.x)).toBeLessThan(0.01);
    look.restore(cam, target);
    lifecycle.abort();
  });

  it("drops the lean at once when motion is off", (): void => {
    const wrap = host();
    const look = createLook(wrap, new AbortController().signal);
    wrap.dispatchEvent(pointer("pointermove", "mouse", 0, 0));
    look.step(0.5, true);
    expect(look.step(0.016, false)).toBe(true);
    expect(look.step(0.016, false)).toBe(false);
  });

  it.each([0, 90, -90])(
    "follows the gyroscope relative to the resting grip (screen angle %s)",
    (angle: number): void => {
      const page = new EventTarget();
      vi.stubGlobal("addEventListener", page.addEventListener.bind(page));
      vi.stubGlobal("screen", { orientation: { angle } });
      const wrap = host();
      const look = createLook(wrap, new AbortController().signal);
      const tilt = (beta: number | null, gamma: number | null): void => {
        page.dispatchEvent(Object.assign(new Event("deviceorientation"), { beta, gamma }));
      };
      tilt(null, null);
      tilt(40, 0);
      look.step(0.016, true);
      // With a gyroscope the mouse no longer steers the lean.
      wrap.dispatchEvent(pointer("pointermove", "mouse", 1000, 500));
      wrap.dispatchEvent(new Event("pointerleave"));
      tilt(40 + 25, 25);
      for (let i = 0; i < 30; i++) look.step(0.016, true);
      const cam = camera();
      look.apply(cam, new THREE.Vector3());
      expect(cam.position.distanceTo(new THREE.Vector3(0, 0, 10))).toBeGreaterThan(1);
      look.restore(cam, new THREE.Vector3());
    },
  );
  it("turns the view with the phone one to one, well past a small lean, without tipping over the top", (): void => {
    const page = new EventTarget();
    vi.stubGlobal("addEventListener", page.addEventListener.bind(page));
    vi.stubGlobal("screen", { orientation: { angle: 0 } });
    const look = createLook(host(), new AbortController().signal);
    const tilt = (beta: number, gamma: number): void => {
      page.dispatchEvent(Object.assign(new Event("deviceorientation"), { beta, gamma }));
    };
    tilt(40, 0);
    look.step(0.016, true);
    tilt(40, 45);
    for (let i = 0; i < 60; i++) look.step(0.016, true);
    const cam = camera();
    const target = new THREE.Vector3();
    look.apply(cam, target);
    const swing = Math.abs(Math.atan2(cam.position.x, cam.position.z)) / (Math.PI / 180);
    expect(swing).toBeGreaterThan(35);
    expect(swing).toBeLessThan(46);
    look.restore(cam, target);
    // Tipping the phone right over cannot carry the camera past the pole.
    tilt(40 - 170, 0);
    for (let i = 0; i < 60; i++) look.step(0.016, true);
    look.apply(cam, target);
    expect(cam.position.length()).toBeCloseTo(10, 3);
    expect(Number.isFinite(cam.position.y)).toBe(true);
    look.restore(cam, target);
  });

  it("leaves an overhead view where it is when there is no lean", (): void => {
    const look = createLook(host(), new AbortController().signal);
    look.step(0.016, true);
    const cam = camera();
    cam.position.setFromSphericalCoords(10, 0.001, 0);
    const before = cam.position.clone();
    look.apply(cam, new THREE.Vector3());
    expect(cam.position.distanceTo(before)).toBeLessThan(1e-6);
    look.restore(cam, new THREE.Vector3());
  });
});

describe("sign flips", (): void => {
  function scene(onActivate?: (index: number) => void) {
    const pivots = [0, 1].map((i: number): THREE.Group => {
      const pivot = new THREE.Group();
      pivot.position.x = i === 0 ? -2 : 2;
      const face = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1, 0.1), new THREE.MeshBasicMaterial());
      pivot.add(face);
      pivot.updateMatrixWorld(true);
      return pivot;
    });
    const wrap = host();
    const canvas = host();
    const lifecycle = new AbortController();
    const flips = createFlips(pivots, wrap, canvas, lifecycle.signal, onActivate);
    return { pivots, wrap, canvas, flips, cam: camera(), lifecycle };
  }
  // Screen positions of the two signs in a 1000 x 500 view from z = 10.
  const LEFT: [number, number] = [349, 250];
  const MISS: [number, number] = [500, 40];

  it("turns a sign once as the mouse moves onto it, and again only after it leaves and returns", (): void => {
    const { pivots, wrap, canvas, flips, cam, lifecycle } = scene();
    wrap.dispatchEvent(pointer("pointermove", "mouse", ...LEFT));
    expect(flips.update(cam, 0.016, true)).toBe(true);
    expect(canvas.style.cursor).toBe("pointer");
    flips.update(cam, 0.5, true);
    expect(pivots[0].rotation.x).toBeGreaterThan(1);
    expect(pivots[1].rotation.x).toBe(0);
    for (let i = 0; i < 20; i++) flips.update(cam, 0.05, true);
    expect(pivots[0].rotation.x).toBe(0);
    // Still hovering: no second turn.
    expect(flips.update(cam, 0.016, true)).toBe(false);
    wrap.dispatchEvent(pointer("pointermove", "mouse", ...MISS));
    flips.update(cam, 0.016, true);
    expect(canvas.style.cursor).toBe("");
    wrap.dispatchEvent(pointer("pointermove", "mouse", ...LEFT));
    expect(flips.update(cam, 0.016, true)).toBe(true);
    wrap.dispatchEvent(new Event("pointerleave"));
    flips.update(cam, 0.016, true);
    lifecycle.abort();
  });

  it("turns a sign on a tap but not at the end of a drag, and never with motion off", (): void => {
    const activated: number[] = [];
    const { pivots, wrap, flips, cam } = scene((index: number) => activated.push(index));
    wrap.dispatchEvent(pointer("pointerdown", "touch", ...LEFT, 0));
    wrap.dispatchEvent(pointer("pointerup", "touch", LEFT[0] + 60, LEFT[1], 100));
    expect(flips.update(cam, 0.016, true)).toBe(false);
    wrap.dispatchEvent(pointer("pointerdown", "touch", ...LEFT, 0));
    wrap.dispatchEvent(pointer("pointerup", "touch", ...LEFT, 900));
    expect(flips.update(cam, 0.016, true)).toBe(false);
    wrap.dispatchEvent(pointer("pointerdown", "touch", ...MISS, 0));
    wrap.dispatchEvent(pointer("pointerup", "touch", ...MISS, 120));
    expect(flips.update(cam, 0.016, true)).toBe(false);
    expect(activated).toEqual([]);
    wrap.dispatchEvent(pointer("pointerdown", "touch", ...LEFT, 0));
    wrap.dispatchEvent(pointer("pointerup", "touch", ...LEFT, 120));
    expect(flips.update(cam, 0.016, true)).toBe(true);
    expect(pivots[0].rotation.x).toBeGreaterThan(0);
    // The sign activates once its turn is over, not before.
    expect(activated).toEqual([]);
    for (let i = 0; i < 30; i++) flips.update(cam, 0.05, true);
    expect(activated).toEqual([0]);
  });

  it("activates a clicked sign after it turns, and at once with motion off (item 4)", (): void => {
    const activated: number[] = [];
    const { flips, wrap, cam, pivots } = scene((index: number) => activated.push(index));
    wrap.dispatchEvent(pointer("pointerdown", "mouse", ...LEFT, 0));
    wrap.dispatchEvent(pointer("pointerup", "mouse", ...LEFT, 10));
    expect(flips.update(cam, 0.016, true)).toBe(true);
    for (let i = 0; i < 30; i++) flips.update(cam, 0.05, true);
    expect(activated).toEqual([0]);
    // Motion off: no turn, straight on.
    wrap.dispatchEvent(pointer("pointerdown", "touch", ...LEFT, 0));
    wrap.dispatchEvent(pointer("pointerup", "touch", ...LEFT, 120));
    expect(flips.update(cam, 0.016, false)).toBe(false);
    expect(pivots[0].rotation.x).toBe(0);
    expect(activated).toEqual([0, 0]);
  });
});

describe("static batching", (): void => {
  it("merges static meshes per material, keeps moving and pinned parts, and leaves the scene as built", (): void => {
    const station = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color: "#336655" });
    const glow = new THREE.MeshBasicMaterial({ color: "#ffcc66" });
    const decal = new THREE.MeshStandardMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
    });
    const glass = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.3 });
    const shared = new THREE.BoxGeometry(1, 1, 1);
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number): THREE.Mesh => {
      const m = new THREE.Mesh(geometry, material);
      m.position.x = x;
      station.add(m);
      return m;
    };
    add(shared, paint, 0);
    const mirrored = add(new THREE.BoxGeometry(1, 1, 1), paint, 2);
    mirrored.scale.x = -1;
    // Non-indexed geometry is batched separately from indexed geometry and mirrored the same way.
    const flat = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    add(flat, paint, 4);
    add(flat.clone(), paint, 6).scale.x = -1;
    const keeper = add(shared, glow, 8);
    add(new THREE.PlaneGeometry(1, 1), decal, 10);
    add(new THREE.PlaneGeometry(1, 1), decal, 11);
    add(new THREE.PlaneGeometry(1, 1), glass, 12);
    add(new THREE.PlaneGeometry(1, 1), glass, 13);
    const hidden = add(new THREE.BoxGeometry(1, 1, 1), paint, 14);
    hidden.visible = false;
    const multi = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [paint, glow]);
    station.add(multi);
    const spinner = add(new THREE.BoxGeometry(1, 1, 1), paint, 16);
    const blinker = add(new THREE.BoxGeometry(1, 1, 1), paint, 18);
    const pinned = new THREE.Group();
    station.add(pinned);
    pinned.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), paint));
    const rivet = new THREE.SphereGeometry(1, 5, 3);
    for (const x of [20, 22]) {
      const set = new THREE.InstancedMesh(rivet, paint, 2);
      set.position.x = x;
      set.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 1, 0));
      set.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 2, 0));
      station.add(set);
    }
    const lamp = new THREE.PointLight("#ffffff", 3);
    station.add(lamp);
    const animators = [
      (t: number): void => {
        spinner.rotation.y = t;
        blinker.visible = t < 5;
        glow.color.setScalar(t);
        lamp.intensity = t;
      },
    ];
    const before = new THREE.Box3().setFromObject(station);
    const moving = batchStatic(station, animators, [pinned]);
    expect([...moving]).toEqual(expect.arrayContaining([spinner, blinker]));
    // Sampling the animators leaves every value as it was built.
    expect(spinner.rotation.y).toBe(0);
    expect(blinker.visible).toBe(true);
    expect(glow.color.getHexString()).toBe("ffcc66");
    expect(lamp.intensity).toBe(3);
    const batches = station.children.filter((o: THREE.Object3D): boolean => o.name === "static-batch");
    // Indexed paint, non-indexed paint, the decals, and the two rivet sets.
    expect(batches).toHaveLength(4);
    expect(batches.some((o: THREE.Object3D): boolean => o instanceof THREE.InstancedMesh)).toBe(true);
    expect(station.children).toContain(keeper);
    expect(station.children).toContain(multi);
    expect(station.children).toContain(hidden);
    expect(pinned.children).toHaveLength(1);
    expect(station.children.filter((o: THREE.Object3D): boolean => (o as THREE.Mesh).material === glass)).toHaveLength(
      2,
    );
    // The shared geometry is still in use by the unmerged glow mesh, so it was not disposed.
    expect(keeper.geometry.attributes.position.count).toBeGreaterThan(0);
    const after = new THREE.Box3().setFromObject(station);
    expect(after.min.distanceTo(before.min)).toBeLessThan(1e-6);
    expect(after.max.distanceTo(before.max)).toBeLessThan(1e-6);
  });
});

describe("phone framing", (): void => {
  it("pulls the camera back and aims higher as more of the stage is covered by the copy", async (): Promise<void> => {
    const { fitPhone } = await import("../app/components/station/scene.client");
    const open = fitPhone(40, 0);
    const covered = fitPhone(40, 0.4);
    expect(covered.radius).toBeGreaterThan(open.radius);
    expect(covered.target.y).toBeGreaterThan(open.target.y);
    // A wide field of view never brings the camera closer than the hero distance.
    expect(fitPhone(90, 0).radius).toBe(17.5);
    // Coverage is clamped, so a broken measurement cannot push the model off the stage.
    expect(fitPhone(40, 5).radius).toBe(fitPhone(40, 0.6).radius);
    expect(fitPhone(40, -1).radius).toBe(open.radius);
  });
});

describe("tilt access", (): void => {
  function storage(initial: Record<string, string> = {}): Storage {
    const data = new Map<string, string>(Object.entries(initial));
    return {
      getItem: (k: string): string | null => data.get(k) ?? null,
      setItem: (k: string, v: string): void => void data.set(k, v),
    } as unknown as Storage;
  }

  it("needs no tap where the browser reports motion freely", async (): Promise<void> => {
    vi.stubGlobal("DeviceOrientationEvent", {});
    expect(tiltNeedsAsking()).toBe(false);
    await expect(askForTilt()).resolves.toBe("granted");
  });

  it("asks on iOS, and remembers a refusal on this device", async (): Promise<void> => {
    const answers: PermissionState[] = ["granted", "denied"];
    const requestPermission = vi.fn((): Promise<PermissionState> => Promise.resolve(answers.shift() ?? "prompt"));
    vi.stubGlobal("DeviceOrientationEvent", { requestPermission });
    vi.stubGlobal("localStorage", storage());
    expect(tiltNeedsAsking()).toBe(true);
    await expect(askForTilt()).resolves.toBe("granted");
    expect(tiltNeedsAsking()).toBe(true);
    await expect(askForTilt()).resolves.toBe("denied");
    expect(tiltNeedsAsking()).toBe(false);
  });

  it("still offers the tap when storage is blocked", async (): Promise<void> => {
    vi.stubGlobal("DeviceOrientationEvent", {
      requestPermission: (): Promise<PermissionState> => Promise.resolve("denied"),
    });
    const blocked = {
      getItem: (): never => {
        throw new Error("blocked");
      },
      setItem: (): never => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("localStorage", blocked);
    expect(tiltNeedsAsking()).toBe(true);
    await expect(askForTilt()).resolves.toBe("denied");
  });

  it("reports the first real orientation reading once, and can be cancelled", (): void => {
    const page = new EventTarget();
    vi.stubGlobal("addEventListener", page.addEventListener.bind(page));
    vi.stubGlobal("removeEventListener", page.removeEventListener.bind(page));
    const seen = vi.fn();
    onFirstMotion(seen);
    const tilt = (beta: number | null): void => {
      page.dispatchEvent(Object.assign(new Event("deviceorientation"), { beta, gamma: beta }));
    };
    tilt(null);
    expect(seen).not.toHaveBeenCalled();
    tilt(10);
    tilt(20);
    expect(seen).toHaveBeenCalledOnce();
    const later = vi.fn();
    onFirstMotion(later)();
    tilt(30);
    expect(later).not.toHaveBeenCalled();
  });
});
