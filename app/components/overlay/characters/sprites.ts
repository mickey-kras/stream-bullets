import type { PlaygroundTheme, Rect } from "../wasteland/playground-theme";

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
  /** The strips of viewer flags, with the cloth tinted per platform. */
  flags: SheetCache<HTMLCanvasElement>;
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
 * A base picture with tints: each mask is multiplied by its colour, cut to the mask shape (destination-in) and drawn
 * over the base. The mask alpha is the tint strength. All rectangles have the size of the base.
 */
function tinted(image: HTMLImageElement, base: Rect, masks: readonly (readonly [Rect, string])[]): HTMLCanvasElement {
  const [bx, by, w, h] = base;
  const [sheet, context] = canvas(w, h);
  context.drawImage(image, bx, by, w, h, 0, 0, w, h);
  for (const [[x, y], color] of masks) {
    const [layer, paint] = canvas(w, h);
    paint.drawImage(image, x, y, w, h, 0, 0, w, h);
    paint.globalCompositeOperation = "multiply";
    paint.fillStyle = color;
    paint.fillRect(0, 0, w, h);
    paint.globalCompositeOperation = "destination-in";
    paint.drawImage(image, x, y, w, h, 0, 0, w, h);
    context.drawImage(layer, 0, 0);
  }
  return sheet;
}

/** One character sheet: the base region with the helmet and the scarf in their colours. */
function tintSheet(theme: PlaygroundTheme, courier: HTMLImageElement, helmet: string): HTMLCanvasElement {
  const { regionWidth: w, regionHeight: h, regions } = theme.courier;
  return tinted(
    courier,
    [regions.base, 0, w, h],
    [
      [[regions.helmet, 0, w, h], helmet],
      [[regions.scarf, 0, w, h], theme.scarfColor],
    ],
  );
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
  const { strip, mask } = theme.builds.viewerFlag;
  return {
    terrain,
    sheets: new SheetCache(theme, (helmet: string) => tintSheet(theme, courier, helmet)),
    flags: new SheetCache(theme, (color: string) => tinted(terrain, strip, [[mask, color]])),
  };
}
