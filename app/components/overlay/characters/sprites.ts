import type { PlaygroundTheme } from "../wasteland/playground-theme";

/** The helmet colour of a platform; platforms without a colour get the fallback. */
export function helmetColor(theme: PlaygroundTheme, platform: string): string {
  return (
    Object.hasOwn(theme.helmetColors, platform) ? theme.helmetColors[platform] : theme.helmetFallback
  ).toLowerCase();
}

/** Builds one sheet per helmet colour, on first use, and keeps it. Platforms with the same colour share a sheet. */
export class SheetCache<T> {
  private readonly sheets = new Map<string, T>();

  constructor(
    private readonly theme: PlaygroundTheme,
    private readonly build: (helmet: string) => T,
  ) {}

  get(platform: string): T {
    const key: string = helmetColor(this.theme, platform);
    let sheet: T | undefined = this.sheets.get(key);
    if (sheet === undefined) {
      sheet = this.build(key);
      this.sheets.set(key, sheet);
    }
    return sheet;
  }

  get size(): number {
    return this.sheets.size;
  }
}

export interface Atlas {
  terrain: HTMLImageElement;
  /** Character sheets (base region size), tinted per platform. */
  sheets: SheetCache<HTMLCanvasElement>;
}

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element: HTMLCanvasElement = document.createElement("canvas");
  element.width = width;
  element.height = height;
  const context: CanvasRenderingContext2D | null = element.getContext("2d");
  if (!context) throw new Error("The browser gave no 2D canvas context for the character sheet.");
  return [element, context];
}

/**
 * One character sheet: the base region, then each mask region multiplied by its colour, cut to the mask shape
 * (destination-in) and drawn over the base. The mask alpha is the tint strength.
 */
function tintSheet(theme: PlaygroundTheme, courier: HTMLImageElement, helmet: string): HTMLCanvasElement {
  const { regionWidth: w, regionHeight: h, regions } = theme.courier;
  const [sheet, context] = canvas(w, h);
  context.drawImage(courier, regions.base, 0, w, h, 0, 0, w, h);
  for (const [x, color] of [
    [regions.helmet, helmet],
    [regions.scarf, theme.scarfColor],
  ] as const) {
    const [layer, paint] = canvas(w, h);
    paint.drawImage(courier, x, 0, w, h, 0, 0, w, h);
    paint.globalCompositeOperation = "multiply";
    paint.fillStyle = color;
    paint.fillRect(0, 0, w, h);
    paint.globalCompositeOperation = "destination-in";
    paint.drawImage(courier, x, 0, w, h, 0, 0, w, h);
    context.drawImage(layer, 0, 0);
  }
  return sheet;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  return image.decode().then(
    (): HTMLImageElement => image,
    (error_: unknown): never => {
      throw new Error(`The playground picture ${url} did not load.`, { cause: error_ });
    },
  );
}

/** Loads both atlas files. The promise rejects if a file does not load. */
export async function loadAtlas(theme: PlaygroundTheme): Promise<Atlas> {
  const [courier, terrain] = await Promise.all([loadImage(theme.courier.url), loadImage(theme.terrain.url)]);
  return {
    terrain,
    sheets: new SheetCache(theme, (helmet: string) => tintSheet(theme, courier, helmet)),
  };
}
