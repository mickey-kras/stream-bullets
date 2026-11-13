import { z } from "zod";

// Overlay layers share one fixed 1920x1080 design space. Rects use whole design pixels.
export const DESIGN_W = 1920;
export const DESIGN_H = 1080;

export const OVERLAY_LAYERS = ["content", "chat", "characters"] as const;
export type OverlayLayer = (typeof OVERLAY_LAYERS)[number];

// Integers. `x + w <= DESIGN_W` and `y + h <= DESIGN_H`.
export interface LayerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChatLayer {
  enabled: boolean;
  rect: LayerRect;
  hideCommands: boolean;
}

export interface CharactersLayer {
  enabled: boolean;
  rect: LayerRect;
}

// The content layer keeps its `position` and `size` settings and has no rect.
export interface OverlayLayers {
  chat: ChatLayer;
  characters: CharactersLayer;
}

export interface LayersPatch {
  chat?: Partial<ChatLayer>;
  characters?: Partial<CharactersLayer>;
}

export const MIN_RECT: Record<"chat" | "characters", { w: number; h: number }> = {
  chat: { w: 280, h: 160 },
  characters: { w: 640, h: 160 },
};

// Chat stays off by default, so existing OBS scenes do not change.
export const DEFAULT_LAYERS: OverlayLayers = {
  chat: { enabled: false, rect: { x: 1460, y: 280, w: 420, h: 640 }, hideCommands: true },
  characters: { enabled: false, rect: { x: 0, y: 760, w: 1920, h: 320 } },
};

const coordinate = z.number().int().nonnegative();
const size = z.number().int().positive();

// A rect inside the design space.
export const layerRectSchema = z
  .object({ x: coordinate, y: coordinate, w: size, h: size })
  .strict()
  .refine((rect: LayerRect): boolean => rect.x + rect.w <= DESIGN_W && rect.y + rect.h <= DESIGN_H, {
    message: "Keep the layer inside the 1920x1080 frame.",
  });

function minimumRect(layer: "chat" | "characters"): z.ZodType<LayerRect> {
  const min = MIN_RECT[layer];
  return layerRectSchema.refine((rect: LayerRect): boolean => rect.w >= min.w && rect.h >= min.h, {
    message: `Make the layer at least ${min.w}x${min.h}.`,
  });
}

const chatRectSchema = minimumRect("chat");
const charactersRectSchema = minimumRect("characters");

function copyRect(rect: LayerRect): LayerRect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

function defaultChat(): ChatLayer {
  return { ...DEFAULT_LAYERS.chat, rect: copyRect(DEFAULT_LAYERS.chat.rect) };
}

function defaultCharacters(): CharactersLayer {
  return { ...DEFAULT_LAYERS.characters, rect: copyRect(DEFAULT_LAYERS.characters.rect) };
}

// Stored and broadcast layers. Missing keys take defaults, so `{}` reads as DEFAULT_LAYERS. Invalid values throw.
export const storedLayersSchema: z.ZodType<OverlayLayers, unknown> = z.object({
  chat: z
    .object({
      enabled: z.boolean().default(DEFAULT_LAYERS.chat.enabled),
      rect: chatRectSchema.default(() => copyRect(DEFAULT_LAYERS.chat.rect)),
      hideCommands: z.boolean().default(DEFAULT_LAYERS.chat.hideCommands),
    })
    .default(defaultChat),
  characters: z
    .object({
      enabled: z.boolean().default(DEFAULT_LAYERS.characters.enabled),
      rect: charactersRectSchema.default(() => copyRect(DEFAULT_LAYERS.characters.rect)),
    })
    .default(defaultCharacters),
});

export const chatPatchSchema = z
  .object({ enabled: z.boolean().optional(), rect: chatRectSchema.optional(), hideCommands: z.boolean().optional() })
  .strict();

export const charactersPatchSchema = z
  .object({ enabled: z.boolean().optional(), rect: charactersRectSchema.optional() })
  .strict();

export const layersPatchSchema = z
  .object({ chat: chatPatchSchema.optional(), characters: charactersPatchSchema.optional() })
  .strict();

export function mergeLayers(current: OverlayLayers, patch: LayersPatch): OverlayLayers {
  const chat: Partial<ChatLayer> = patch.chat ?? {};
  const characters: Partial<CharactersLayer> = patch.characters ?? {};
  return {
    chat: {
      enabled: chat.enabled ?? current.chat.enabled,
      rect: copyRect(chat.rect ?? current.chat.rect),
      hideCommands: chat.hideCommands ?? current.chat.hideCommands,
    },
    characters: {
      enabled: characters.enabled ?? current.characters.enabled,
      rect: copyRect(characters.rect ?? current.characters.rect),
    },
  };
}

// `?layer=`: null renders the whole composition; "unknown" renders an empty page.
export function parseLayerParam(value: string | null): OverlayLayer | null | "unknown" {
  if (value === null) return null;
  const layer: OverlayLayer | undefined = OVERLAY_LAYERS.find((name: OverlayLayer): boolean => name === value);
  return layer ?? "unknown";
}

// Adds, replaces, or (for null) removes `layer` and keeps the other query parameters, such as `key`.
export function layerUrl(overlayUrl: string, layer: OverlayLayer | null): string {
  const absolute: boolean = /^[a-z][a-z\d+.-]*:/i.test(overlayUrl);
  const base = "https://overlay.invalid";
  const url = new URL(overlayUrl, base);
  if (layer === null) url.searchParams.delete("layer");
  else url.searchParams.set("layer", layer);
  return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}
