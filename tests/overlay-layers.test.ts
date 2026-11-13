import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_LAYERS,
  DESIGN_H,
  DESIGN_W,
  MIN_RECT,
  OVERLAY_LAYERS,
  layerRectSchema,
  layerUrl,
  layersPatchSchema,
  mergeLayers,
  parseLayerParam,
  parseStoredLayers,
  storedLayersSchema,
  type LayerRect,
  type OverlayLayers,
} from "../app/lib/overlay-layers";

// Pure rules for overlay layers: rects, stored values, patches and layer URLs.

const inside = (rect: LayerRect): boolean => rect.x + rect.w <= DESIGN_W && rect.y + rect.h <= DESIGN_H;

describe("layer defaults", (): void => {
  it("keeps chat and characters off, inside the frame and above their minimum size", (): void => {
    expect(OVERLAY_LAYERS).toEqual(["content", "chat", "characters"]);
    expect([DESIGN_W, DESIGN_H]).toEqual([1920, 1080]);
    expect(DEFAULT_LAYERS).toEqual({
      chat: { enabled: false, rect: { x: 1240, y: 372, w: 640, h: 660 }, hideCommands: true },
      characters: { enabled: false, rect: { x: 0, y: 760, w: 1920, h: 320 } },
    });
    expect(MIN_RECT).toEqual({ chat: { w: 280, h: 160 }, characters: { w: 640, h: 160 } });
    // The A1 mockup place: 40 px from the right edge and 48 px from the bottom edge.
    expect(DESIGN_W - DEFAULT_LAYERS.chat.rect.x - DEFAULT_LAYERS.chat.rect.w).toBe(40);
    expect(DESIGN_H - DEFAULT_LAYERS.chat.rect.y - DEFAULT_LAYERS.chat.rect.h).toBe(48);
    for (const layer of ["chat", "characters"] as const) {
      const rect: LayerRect = DEFAULT_LAYERS[layer].rect;
      expect(inside(rect)).toBe(true);
      expect(rect.w).toBeGreaterThanOrEqual(MIN_RECT[layer].w);
      expect(rect.h).toBeGreaterThanOrEqual(MIN_RECT[layer].h);
    }
  });
});

describe("layer rects", (): void => {
  it("accepts whole design pixels inside the frame, up to the edges", (): void => {
    expect(layerRectSchema.parse({ x: 0, y: 0, w: 1920, h: 1080 })).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(layerRectSchema.parse({ x: 1919, y: 1079, w: 1, h: 1 })).toEqual({ x: 1919, y: 1079, w: 1, h: 1 });
  });

  it.each([
    ["past the right edge", { x: 1, y: 0, w: 1920, h: 10 }],
    ["past the bottom edge", { x: 0, y: 1, w: 10, h: 1080 }],
    ["negative x", { x: -1, y: 0, w: 10, h: 10 }],
    ["zero width", { x: 0, y: 0, w: 0, h: 10 }],
    ["fractions", { x: 0.5, y: 0, w: 10, h: 10 }],
    ["text", { x: "0", y: 0, w: 10, h: 10 }],
    ["a missing field", { x: 0, y: 0, w: 10 }],
    ["an unknown field", { x: 0, y: 0, w: 10, h: 10, z: 1 }],
  ])("refuses %s", (_name: string, rect: Record<string, unknown>): void => {
    expect(layerRectSchema.safeParse(rect).success).toBe(false);
  });
});

describe("stored layers", (): void => {
  it("reads {} and missing keys as the defaults", (): void => {
    expect(storedLayersSchema.parse({})).toEqual(DEFAULT_LAYERS);
    expect(storedLayersSchema.parse({ chat: { enabled: true } })).toEqual({
      ...DEFAULT_LAYERS,
      chat: { ...DEFAULT_LAYERS.chat, enabled: true },
    });
    expect(storedLayersSchema.parse({ characters: {} })).toEqual(DEFAULT_LAYERS);
  });

  it("returns fresh defaults, so editing one result never changes another", (): void => {
    const first: OverlayLayers = storedLayersSchema.parse({});
    first.chat.rect.x = 0;
    expect(storedLayersSchema.parse({}).chat.rect.x).toBe(1240);
    expect(DEFAULT_LAYERS.chat.rect.x).toBe(1240);
  });

  it("reads a missing value, also as a missing key of an enclosing object, as fresh defaults", (): void => {
    expect(storedLayersSchema.parse(undefined)).toEqual(DEFAULT_LAYERS);
    const message = z.object({ layers: storedLayersSchema });
    const first: OverlayLayers = message.parse({}).layers;
    expect(first).toEqual(DEFAULT_LAYERS);
    first.chat.rect.x = 0;
    expect(message.parse({}).layers).toEqual(DEFAULT_LAYERS);
    expect(DEFAULT_LAYERS.chat.rect.x).toBe(1240);
  });

  it("drops unknown keys from older or newer versions", (): void => {
    expect(storedLayersSchema.parse({ future: { enabled: true }, chat: { theme: "neon" } })).toEqual(DEFAULT_LAYERS);
  });

  it("drops unknown keys inside a layer and inside a rect", (): void => {
    const rect: LayerRect = { x: 0, y: 0, w: 280, h: 160 };
    expect(storedLayersSchema.parse({ chat: { enabled: true, rect: { ...rect, z: 1, radius: 4 } } })).toEqual({
      ...DEFAULT_LAYERS,
      chat: { ...DEFAULT_LAYERS.chat, enabled: true, rect },
    });
  });

  it.each([
    ["past the right edge", { x: 1800, y: 0, w: 280, h: 160 }],
    ["past the bottom edge", { x: 0, y: 1000, w: 280, h: 160 }],
    ["negative", { x: -1, y: 0, w: 280, h: 160 }],
    ["below the minimum width", { x: 0, y: 0, w: 279, h: 160 }],
    ["below the minimum height", { x: 0, y: 0, w: 280, h: 159 }],
    ["fractions", { x: 0.5, y: 0, w: 280, h: 160 }],
    ["text", { x: "0", y: 0, w: 280, h: 160 }],
    ["partial", { x: 0, y: 0, w: 280 }],
    ["not an object", "full"],
  ])("reads a chat rect %s as the default rect and keeps the other fields", (_name: string, rect: unknown): void => {
    expect(storedLayersSchema.parse({ chat: { enabled: true, hideCommands: false, rect } })).toEqual({
      ...DEFAULT_LAYERS,
      chat: { enabled: true, rect: DEFAULT_LAYERS.chat.rect, hideCommands: false },
    });
  });

  it("applies the minimum size of each layer", (): void => {
    const rect: LayerRect = { x: 0, y: 0, w: 639, h: 160 };
    expect(storedLayersSchema.parse({ chat: { rect }, characters: { enabled: true, rect } })).toEqual({
      chat: { ...DEFAULT_LAYERS.chat, rect },
      characters: { ...DEFAULT_LAYERS.characters, enabled: true },
    });
  });

  it("reads each field of the wrong type as its default", (): void => {
    expect(
      storedLayersSchema.parse({
        chat: { enabled: "yes", hideCommands: 0, rect: { x: 0, y: 0, w: 280, h: 160 } },
        characters: { enabled: null },
      }),
    ).toEqual({ ...DEFAULT_LAYERS, chat: { ...DEFAULT_LAYERS.chat, rect: { x: 0, y: 0, w: 280, h: 160 } } });
  });

  it.each([
    ["null", null],
    ["a string", "layers"],
    ["an array", []],
    ["layers of the wrong type", { chat: "on", characters: 1 }],
  ])("reads %s as the default layers and never throws", (_name: string, value: unknown): void => {
    expect(storedLayersSchema.parse(value)).toEqual(DEFAULT_LAYERS);
  });

  it("reads one bad layer as its defaults and keeps the other layer", (): void => {
    expect(storedLayersSchema.parse({ chat: [], characters: { enabled: true } })).toEqual({
      ...DEFAULT_LAYERS,
      characters: { ...DEFAULT_LAYERS.characters, enabled: true },
    });
  });

  it("reads stored JSON text and reads invalid JSON as the defaults", (): void => {
    expect(parseStoredLayers('{"chat":{"enabled":true}}')).toEqual({
      ...DEFAULT_LAYERS,
      chat: { ...DEFAULT_LAYERS.chat, enabled: true },
    });
    expect(parseStoredLayers("{")).toEqual(DEFAULT_LAYERS);
    expect(parseStoredLayers("")).toEqual(DEFAULT_LAYERS);
    const fallback: OverlayLayers = parseStoredLayers("null");
    fallback.chat.rect.x = 0;
    expect(DEFAULT_LAYERS.chat.rect.x).toBe(1240);
  });
});

describe("layer patches", (): void => {
  it("accepts any subset of the known fields", (): void => {
    expect(layersPatchSchema.parse({})).toEqual({});
    expect(layersPatchSchema.parse({ chat: { hideCommands: false } })).toEqual({ chat: { hideCommands: false } });
    const rect: LayerRect = { x: 0, y: 0, w: 640, h: 160 };
    expect(layersPatchSchema.parse({ characters: { enabled: true, rect } })).toEqual({
      characters: { enabled: true, rect },
    });
  });

  it.each([
    ["an unknown layer", { content: { enabled: true } }],
    ["an unknown chat field", { chat: { color: "red" } }],
    ["an unknown characters field", { characters: { hideCommands: true } }],
    ["a chat rect below the minimum", { chat: { rect: { x: 0, y: 0, w: 280, h: 159 } } }],
    ["a characters rect below the minimum", { characters: { rect: { x: 0, y: 0, w: 639, h: 320 } } }],
    ["a rect outside the frame", { chat: { rect: { x: 1700, y: 0, w: 280, h: 160 } } }],
    ["a partial rect", { chat: { rect: { x: 0, y: 0 } } }],
    ["a null value", { chat: { enabled: null } }],
  ])("refuses %s", (_name: string, patch: Record<string, unknown>): void => {
    expect(layersPatchSchema.safeParse(patch).success).toBe(false);
  });

  it("changes only the given fields and replaces the whole rect", (): void => {
    const rect: LayerRect = { x: 10, y: 20, w: 300, h: 200 };
    const next: OverlayLayers = mergeLayers(DEFAULT_LAYERS, { chat: { enabled: true, rect } });
    expect(next).toEqual({ ...DEFAULT_LAYERS, chat: { enabled: true, rect, hideCommands: true } });
    expect(next.chat.rect).not.toBe(rect);
    expect(next.characters.rect).not.toBe(DEFAULT_LAYERS.characters.rect);
    expect(mergeLayers(next, { characters: { enabled: true } })).toEqual({
      chat: next.chat,
      characters: { ...DEFAULT_LAYERS.characters, enabled: true },
    });
    expect(mergeLayers(next, {})).toEqual(next);
    expect(DEFAULT_LAYERS.chat.enabled).toBe(false);
  });
});

describe("layer URLs", (): void => {
  it("reads the layer parameter: none, a known layer or unknown", (): void => {
    expect(parseLayerParam(null)).toBeNull();
    expect(parseLayerParam("chat")).toBe("chat");
    expect(parseLayerParam("content")).toBe("content");
    expect(parseLayerParam("characters")).toBe("characters");
    for (const value of ["", "Chat", "chat ", "all", "__proto__", "toString"])
      expect(parseLayerParam(value)).toBe("unknown");
  });

  it("adds, replaces or removes the layer and keeps the key", (): void => {
    const url = "https://sb.example/@host/overlay?key=abc-_123";
    expect(layerUrl(url, "chat")).toBe("https://sb.example/@host/overlay?key=abc-_123&layer=chat");
    expect(layerUrl(`${url}&layer=chat`, "characters")).toBe(
      "https://sb.example/@host/overlay?key=abc-_123&layer=characters",
    );
    expect(layerUrl(`${url}&layer=chat`, null)).toBe(url);
    expect(layerUrl(url, null)).toBe(url);
    expect(parseLayerParam(new URL(layerUrl(url, "content")).searchParams.get("layer"))).toBe("content");
  });

  it("keeps a relative URL relative", (): void => {
    expect(layerUrl("/@host/overlay?key=k", "chat")).toBe("/@host/overlay?key=k&layer=chat");
    expect(layerUrl("/@host/overlay", "chat")).toBe("/@host/overlay?layer=chat");
  });
});
