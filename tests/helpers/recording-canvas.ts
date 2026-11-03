import { createHash, type Hash } from "node:crypto";
import { vi } from "vitest";

/** Record canvas commands and pixel bytes without replacing the texture algorithms. */
export class RecordingCanvas {
  width = 0;
  height = 0;
  private readonly hash: Hash = createHash("sha256");
  private readonly context: Record<string, unknown> = {};

  digest(): string {
    return this.hash.copy().digest("hex");
  }

  getContext(): object {
    const record = (name: string, args: unknown[]): void => {
      this.hash.update(JSON.stringify([name, args]));
    };
    return new Proxy(this.context, {
      set: (target: Record<string, unknown>, key: string, value: unknown): boolean => {
        record(key, [value]);
        target[key] = value;
        return true;
      },
      get: (target: Record<string, unknown>, key: string): unknown => {
        if (key in target) return target[key];
        if (key === "createImageData") {
          return (width: number, height: number): Pick<ImageData, "data" | "width" | "height"> => ({
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4),
          });
        }
        if (key === "putImageData") {
          return (image: ImageData, x: number, y: number): void => {
            record(key, [image.width, image.height, x, y]);
            this.hash.update(image.data);
          };
        }
        if (key === "createLinearGradient" || key === "createRadialGradient") {
          return (...args: number[]): object => {
            record(key, args);
            return {
              addColorStop: (offset: number, color: string): void => record("addColorStop", [offset, color]),
            };
          };
        }
        return (...args: unknown[]): void => record(key, args);
      },
    });
  }
}

export function installRecordingCanvas(): void {
  vi.stubGlobal("document", {
    createElement: (tag: string): RecordingCanvas => {
      if (tag !== "canvas") throw new Error(`Unexpected element: ${tag}`);
      return new RecordingCanvas();
    },
  });
}
