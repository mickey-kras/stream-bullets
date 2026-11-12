import { afterEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { installRecordingCanvas } from "./helpers/recording-canvas";
import { createStation, type StationView } from "../app/components/station/scene.client";

const gpu = vi.hoisted(() => ({
  render: vi.fn(),
  camera: null as THREE.PerspectiveCamera | null,
  dispose: vi.fn(),
  remove: vi.fn(),
  setSize: vi.fn(),
  canvas: new EventTarget(),
  controls: new EventTarget(),
}));
vi.mock("three", async (original) => {
  const actual = await original<typeof import("three")>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = Object.assign(gpu.canvas, { style: {}, setAttribute: vi.fn(), remove: gpu.remove });
      shadowMap = {};
      setPixelRatio = vi.fn();
      setSize = gpu.setSize;
      dispose = gpu.dispose;
    },
    PMREMGenerator: class {
      fromScene(): THREE.WebGLRenderTarget {
        return new actual.WebGLRenderTarget(1, 1);
      }
      dispose(): void {
        /* No GPU resources in this test. */
      }
    },
  };
});
vi.mock("three/addons/controls/OrbitControls.js", async () => {
  const actual = await vi.importActual<typeof import("three")>("three");
  return {
    OrbitControls: class {
      target = new actual.Vector3();
      addEventListener = gpu.controls.addEventListener.bind(gpu.controls);
      update = vi.fn();
      dispose = vi.fn();
    },
  };
});
vi.mock("three/addons/postprocessing/EffectComposer.js", () => ({
  EffectComposer: class {
    addPass = vi.fn();
    setSize = vi.fn();
    render = gpu.render;
    dispose = vi.fn();
  },
}));
vi.mock("three/addons/postprocessing/RenderPass.js", () => ({
  RenderPass: class {
    constructor(_scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
      gpu.camera = camera;
    }
  },
}));
vi.mock("three/addons/postprocessing/OutputPass.js", () => ({ OutputPass: class {} }));
vi.mock("three/addons/postprocessing/UnrealBloomPass.js", () => ({
  UnrealBloomPass: class {
    resolution = { set: vi.fn() };
  },
}));
vi.mock("three/addons/postprocessing/ShaderPass.js", () => ({
  ShaderPass: class {
    uniforms = { uTime: { value: 0 } };
  },
}));

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([true, false])(
  "runs and disposes the station controller (reduced=%s)",
  async (reduced: boolean): Promise<void> => {
    installRecordingCanvas();
    const media = Object.assign(new EventTarget(), { matches: reduced });
    const compact = Object.assign(new EventTarget(), { matches: reduced });
    vi.stubGlobal("matchMedia", (query: string): EventTarget =>
      query === "(max-width: 700px)" ? compact : media,
    );
    // The head script's effective Motion setting (app/lib/prefs.ts), which the scene follows.
    const root = { dataset: { reduced: String(reduced) } };
    Object.assign(document, { documentElement: root });
    let motionChanged: () => void = (): void => {};
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(callback: () => void) {
          motionChanged = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal("devicePixelRatio", 2);
    let frame: FrameRequestCallback = (): void => {
      throw new Error("Animation not scheduled");
    };
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
      frame = callback;
      return 1;
    });
    const cancel = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const disconnect = vi.fn();
    let visible: (entries: Array<{ isIntersecting: boolean }>) => void = (): void => {};
    let resize: () => void = (): void => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: () => void) {
          resize = callback;
        }
        observe(): void {
          this.callback();
        }
        disconnect = disconnect;
      },
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof visible) {
          visible = callback;
        }
        observe(): void {}
        disconnect = disconnect;
      },
    );
    const host = Object.assign(new EventTarget(), {
      clientWidth: 1200,
      clientHeight: 800,
      appendChild: vi.fn(),
      getBoundingClientRect: (): object => ({ left: 0, top: 0, width: 1200, height: 800 }),
    });
    const fail = vi.fn();
    const controller = await createStation(
      host as unknown as HTMLDivElement,
      fail,
      reduced ? {} : { shift: (): number => 0.2, family: "sans-serif" },
    );
    expect(host.appendChild).toHaveBeenCalledOnce();
    expect(gpu.setSize).toHaveBeenCalledWith(1200, 800);
    const initialPosition = gpu.camera!.position.clone();
    compact.matches = !compact.matches;
    host.clientWidth = 390;
    host.clientHeight = 700;
    resize();
    expect(gpu.camera!.position.equals(initialPosition)).toBe(false);
    compact.matches = !compact.matches;
    host.clientWidth = 1200;
    host.clientHeight = 800;
    resize();
    expect(gpu.camera!.position.distanceTo(initialPosition)).toBeLessThan(0.00001);
    const pointer = (pointerType: string): Event =>
      Object.assign(new Event("pointermove"), { pointerType, clientX: 900, clientY: 200 });
    host.dispatchEvent(pointer("touch"));
    host.dispatchEvent(pointer("mouse"));
    frame(100);
    expect(gpu.render).toHaveBeenCalled();
    gpu.render.mockClear();
    visible([{ isIntersecting: false }]);
    frame(120);
    expect(gpu.render).not.toHaveBeenCalled();
    visible([{ isIntersecting: true }]);
    controller.motion(false);
    frame(140);
    gpu.render.mockClear();
    frame(160);
    expect(gpu.render).not.toHaveBeenCalled();
    controller.motion(true);
    for (const view of [
      "entrance",
      "hero",
      "studio",
      "rear",
      "atom",
      "mast",
      "orbit",
      "front",
      "back",
      "left",
      "right",
      "top",
    ] satisfies StationView[]) {
      controller.view(view);
      for (let t = 200; t < 2000; t += 50) frame(t);
    }
    gpu.controls.dispatchEvent(new Event("start"));
    host.dispatchEvent(pointer("mouse"));
    frame(2100);
    gpu.controls.dispatchEvent(new Event("end"));
    gpu.controls.dispatchEvent(new Event("change"));
    host.dispatchEvent(new Event("pointerleave"));
    root.dataset.reduced = String(!reduced);
    motionChanged();
    controller.view("hero");
    frame(2150);
    controller.lights(false);
    controller.lights(true);
    controller.typeface("serif");
    const lost = new Event("webglcontextlost", { cancelable: true });
    gpu.canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(fail).toHaveBeenCalledOnce();
    controller.dispose();
    expect(cancel).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(gpu.dispose).toHaveBeenCalledOnce();
    expect(gpu.remove).toHaveBeenCalledOnce();
    gpu.canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(fail).toHaveBeenCalledOnce();
  },
  120_000,
);
