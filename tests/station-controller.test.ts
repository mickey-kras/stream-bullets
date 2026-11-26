import { afterEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { installRecordingCanvas } from "./helpers/recording-canvas";
import { createStation, isSoftwareRenderer, type StationView } from "../app/components/station/scene.client";

const gpu = vi.hoisted(() => ({
  render: vi.fn(),
  camera: null as THREE.PerspectiveCamera | null,
  dispose: vi.fn(),
  remove: vi.fn(),
  setSize: vi.fn(),
  canvas: new EventTarget(),
  context: undefined as WebGLRenderingContext | undefined,
  controls: new EventTarget(),
}));
vi.mock("three", async (original) => {
  const actual = await original<typeof import("three")>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = Object.assign(gpu.canvas, { style: {}, setAttribute: vi.fn(), remove: gpu.remove });
      shadowMap = { enabled: false };
      getContext = (): WebGLRenderingContext | undefined => gpu.context;
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
    const onFrame = vi.fn();
    gpu.context = reduced
      ? ({
          RENDERER: 0x1f01,
          getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
          getParameter: () => "ANGLE (Google, SwiftShader)",
        } as unknown as WebGLRenderingContext)
      : undefined;
    const controller = await createStation(
      host as unknown as HTMLDivElement,
      fail,
      reduced ? { onFrame } : { shift: (): number => 0.2, family: "sans-serif", onFrame },
    );
    // The canvas has its size before the first frame; the first frame alone starts the poster fade.
    expect(onFrame).not.toHaveBeenCalled();
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
    expect(onFrame).toHaveBeenCalledOnce();
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
    frame(180);
    gpu.render.mockClear();
    frame(190);
    // Software WebGL stays paused even when motion is allowed.
    expect(gpu.render).toHaveBeenCalledTimes(reduced ? 0 : 1);
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
    expect(onFrame).toHaveBeenCalledOnce();
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

it("detects software WebGL renderers and treats hardware or missing contexts as normal", (): void => {
  const context = (rendererName: unknown, debugExtension: boolean) => ({
    getContext: () =>
      ({
        RENDERER: 0x1f01,
        getExtension: (name: string) =>
          debugExtension && name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null,
        getParameter: () => rendererName,
      }) as unknown as WebGLRenderingContext,
  });
  expect(isSoftwareRenderer({ getContext: () => undefined as unknown as WebGLRenderingContext })).toBe(false);
  expect(isSoftwareRenderer(context("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader)", true))).toBe(
    true,
  );
  expect(isSoftwareRenderer(context("llvmpipe (LLVM 17.0.6, 256 bits)", false))).toBe(true);
  expect(isSoftwareRenderer(context("ANGLE (NVIDIA, NVIDIA GeForce RTX 5090)", true))).toBe(false);
});
