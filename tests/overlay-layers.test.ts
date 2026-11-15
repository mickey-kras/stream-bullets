import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CELL_PX,
  CHARACTERS_TIMEOUT,
  DEFAULT_LAYERS,
  GRID,
  GRID_LAYERS,
  MIN_CELLS,
  ORIENTATIONS,
  OVERLAY_LAYERS,
  cellFits,
  cellPixels,
  frameSize,
  layerPixels,
  layerUrl,
  layersPatchSchema,
  mergeLayers,
  overlappingPair,
  parseLayerParam,
  parseStoredLayers,
  storedLayersSchema,
  type CellRect,
  type OverlayLayers,
} from "../app/lib/overlay-layers";

// Pure rules for overlay layers: the grid, stored values, patches and layer URLs.

const chatCell: CellRect = { c: 10, r: 0, w: 6, h: 5 };

describe("grid and defaults", (): void => {
  it("has a 16 x 9 horizontal and a 9 x 16 vertical grid of 120 px cells", (): void => {
    expect(OVERLAY_LAYERS).toEqual(["content", "chat", "characters"]);
    expect(CELL_PX).toBe(120);
    expect(frameSize("horizontal")).toEqual({ w: 1920, h: 1080 });
    expect(frameSize("vertical")).toEqual({ w: 1080, h: 1920 });
    expect(MIN_CELLS).toEqual({ chat: { w: 3, h: 2 }, characters: { w: 6, h: 2 }, content: { w: 4, h: 2 } });
  });

  it("keeps chat and characters off, content without a cell, and valid default cells that do not overlap", (): void => {
    expect(DEFAULT_LAYERS).toEqual({
      orientation: "horizontal",
      chat: { enabled: false, hideCommands: true },
      characters: { enabled: false, timeout: 60 },
      cells: {
        horizontal: { chat: { c: 0, r: 0, w: 5, h: 7 }, characters: { c: 0, r: 7, w: 16, h: 2 }, content: null },
        vertical: { chat: { c: 0, r: 8, w: 9, h: 5 }, characters: { c: 0, r: 13, w: 9, h: 3 }, content: null },
      },
    });
    for (const orientation of ORIENTATIONS) {
      const cells = DEFAULT_LAYERS.cells[orientation];
      expect(cellFits(orientation, "chat", cells.chat)).toBe(true);
      expect(cellFits(orientation, "characters", cells.characters)).toBe(true);
      expect(overlappingPair(cells)).toBeNull();
    }
  });

  it("converts cells to design pixels and finds the place of a layer in the selected orientation", (): void => {
    expect(cellPixels({ c: 1, r: 2, w: 3, h: 4 })).toEqual({ x: 120, y: 240, w: 360, h: 480 });
    expect(layerPixels(DEFAULT_LAYERS, "chat")).toEqual({ x: 0, y: 0, w: 600, h: 840 });
    expect(layerPixels({ ...DEFAULT_LAYERS, orientation: "vertical" }, "characters")).toEqual({
      x: 0,
      y: 1560,
      w: 1080,
      h: 360,
    });
    expect(layerPixels(DEFAULT_LAYERS, "content")).toBeNull();
  });

  it("checks the grid edges and minimum sizes per orientation", (): void => {
    expect(cellFits("horizontal", "chat", { c: 13, r: 7, w: 3, h: 2 })).toBe(true);
    expect(cellFits("horizontal", "chat", { c: 14, r: 7, w: 3, h: 2 })).toBe(false);
    expect(cellFits("horizontal", "chat", { c: 0, r: 8, w: 3, h: 2 })).toBe(false);
    expect(cellFits("vertical", "characters", { c: 0, r: 0, w: 9, h: 2 })).toBe(true);
    expect(cellFits("vertical", "characters", { c: 0, r: 0, w: 10, h: 2 })).toBe(false);
    expect(cellFits("horizontal", "content", { c: 0, r: 0, w: 3, h: 2 })).toBe(false);
    expect(cellFits("horizontal", "characters", { c: 0, r: 0, w: 6, h: 1 })).toBe(false);
  });

  it("finds overlapping layers and ignores content without a cell and shared edges", (): void => {
    const cells = DEFAULT_LAYERS.cells.horizontal;
    expect(overlappingPair({ ...cells, content: { c: 5, r: 0, w: 4, h: 2 } })).toBeNull();
    expect(overlappingPair({ ...cells, content: { c: 4, r: 0, w: 4, h: 2 } })).toEqual(["chat", "content"]);
    expect(overlappingPair({ ...cells, characters: { c: 0, r: 6, w: 16, h: 2 } })).toEqual(["chat", "characters"]);
    expect(overlappingPair({})).toBeNull();
  });
});

describe("stored layers", (): void => {
  it("reads {} and missing keys as the defaults", (): void => {
    expect(storedLayersSchema.parse({})).toEqual(DEFAULT_LAYERS);
    expect(storedLayersSchema.parse({ chat: { enabled: true } })).toEqual({
      ...DEFAULT_LAYERS,
      chat: { ...DEFAULT_LAYERS.chat, enabled: true },
    });
    expect(storedLayersSchema.parse({ characters: {}, cells: {} })).toEqual(DEFAULT_LAYERS);
  });

  it("returns fresh defaults, so editing one result never changes another", (): void => {
    const first: OverlayLayers = storedLayersSchema.parse({});
    first.cells.horizontal.chat.c = 3;
    first.chat.enabled = true;
    expect(storedLayersSchema.parse({})).toEqual(DEFAULT_LAYERS);
    expect(DEFAULT_LAYERS.cells.horizontal.chat.c).toBe(0);
    const fallback: OverlayLayers = parseStoredLayers("null");
    fallback.cells.vertical.chat.r = 0;
    expect(DEFAULT_LAYERS.cells.vertical.chat.r).toBe(8);
  });

  it("reads a missing value, also as a missing key of an enclosing object, as fresh defaults", (): void => {
    expect(storedLayersSchema.parse(undefined)).toEqual(DEFAULT_LAYERS);
    const message = z.object({ layers: storedLayersSchema });
    expect(message.parse({}).layers).toEqual(DEFAULT_LAYERS);
  });

  it("keeps valid cells of both orientations and the selected orientation", (): void => {
    const stored = {
      orientation: "vertical",
      chat: { enabled: true, hideCommands: false },
      characters: { enabled: true, timeout: 60 },
      cells: {
        horizontal: { chat: chatCell, characters: { c: 0, r: 7, w: 16, h: 2 }, content: { c: 0, r: 0, w: 6, h: 4 } },
        vertical: { chat: { c: 0, r: 0, w: 9, h: 4 }, characters: { c: 0, r: 14, w: 9, h: 2 }, content: null },
      },
    };
    expect(storedLayersSchema.parse(stored)).toEqual(stored);
  });

  it("drops unknown keys from older or newer versions, also the old pixel rects", (): void => {
    expect(
      storedLayersSchema.parse({
        future: { enabled: true },
        chat: { theme: "neon", rect: { x: 0, y: 0, w: 280, h: 160 } },
        cells: { horizontal: { chat: { ...chatCell, z: 1 }, extra: chatCell }, diagonal: {} },
      }),
    ).toEqual({
      ...DEFAULT_LAYERS,
      cells: { ...DEFAULT_LAYERS.cells, horizontal: { ...DEFAULT_LAYERS.cells.horizontal, chat: chatCell } },
    });
  });

  it.each([
    ["past the right edge", { c: 14, r: 0, w: 3, h: 2 }],
    ["past the bottom edge", { c: 0, r: 8, w: 3, h: 2 }],
    ["negative", { c: -1, r: 0, w: 3, h: 2 }],
    ["below the minimum", { c: 0, r: 0, w: 2, h: 2 }],
    ["fractions", { c: 0.5, r: 0, w: 3, h: 2 }],
    ["text", { c: "0", r: 0, w: 3, h: 2 }],
    ["partial", { c: 0, r: 0, w: 3 }],
    ["not an object", "full"],
  ])("reads a chat cell %s as the default cell and keeps the other fields", (_name: string, cell: unknown): void => {
    const layers = storedLayersSchema.parse({ chat: { enabled: true }, cells: { horizontal: { chat: cell } } });
    expect(layers).toEqual({ ...DEFAULT_LAYERS, chat: { ...DEFAULT_LAYERS.chat, enabled: true } });
  });

  it("reads overlapping chat and characters cells as both defaults", (): void => {
    const cells = { chat: { c: 0, r: 5, w: 16, h: 4 }, characters: { c: 0, r: 7, w: 16, h: 2 } };
    expect(storedLayersSchema.parse({ cells: { horizontal: cells } })).toEqual(DEFAULT_LAYERS);
  });

  it("reads an invalid or overlapping content cell as no cell", (): void => {
    const read = (content: unknown) =>
      storedLayersSchema.parse({ cells: { horizontal: { content } } }).cells.horizontal.content;
    expect(read({ c: 6, r: 0, w: 4, h: 2 })).toEqual({ c: 6, r: 0, w: 4, h: 2 });
    expect(read({ c: 4, r: 0, w: 4, h: 2 })).toBeNull();
    expect(read({ c: 6, r: 6, w: 4, h: 2 })).toBeNull();
    expect(read({ c: 6, r: 0, w: 3, h: 2 })).toBeNull();
    expect(read("cell")).toBeNull();
  });

  it("reads each field of the wrong type as its default", (): void => {
    expect(
      storedLayersSchema.parse({
        orientation: "diagonal",
        chat: { enabled: "yes", hideCommands: 0 },
        characters: { enabled: null },
        cells: { horizontal: [], vertical: 3 },
      }),
    ).toEqual(DEFAULT_LAYERS);
  });

  it.each([
    ["null", null],
    ["a string", "layers"],
    ["an array", []],
    ["layers of the wrong type", { chat: "on", characters: 1, cells: "none" }],
  ])("reads %s as the default layers and never throws", (_name: string, value: unknown): void => {
    expect(storedLayersSchema.parse(value)).toEqual(DEFAULT_LAYERS);
  });

  it("reads stored JSON text and reads invalid JSON as the defaults", (): void => {
    expect(parseStoredLayers('{"chat":{"enabled":true}}')).toEqual({
      ...DEFAULT_LAYERS,
      chat: { ...DEFAULT_LAYERS.chat, enabled: true },
    });
    expect(parseStoredLayers("{")).toEqual(DEFAULT_LAYERS);
    expect(parseStoredLayers("")).toEqual(DEFAULT_LAYERS);
  });

  it("stays short enough for the 1000-character column limit with every cell set", (): void => {
    const full: OverlayLayers = {
      ...DEFAULT_LAYERS,
      orientation: "horizontal",
      chat: { enabled: false, hideCommands: false },
      characters: { enabled: false, timeout: 600 },
      cells: {
        horizontal: { ...DEFAULT_LAYERS.cells.horizontal, content: { c: 10, r: 0, w: 6, h: 7 } },
        vertical: { ...DEFAULT_LAYERS.cells.vertical, content: { c: 0, r: 0, w: 9, h: 8 } },
      },
    };
    expect(JSON.stringify(full).length).toBeLessThan(1000);
  });
});

describe("layer patches", (): void => {
  it("accepts any subset of the known fields", (): void => {
    expect(layersPatchSchema.parse({})).toEqual({});
    expect(layersPatchSchema.parse({ chat: { hideCommands: false } })).toEqual({ chat: { hideCommands: false } });
    expect(layersPatchSchema.parse({ orientation: "vertical", characters: { enabled: true } })).toEqual({
      orientation: "vertical",
      characters: { enabled: true },
    });
    expect(layersPatchSchema.parse({ cells: { horizontal: { chat: chatCell, content: null }, vertical: {} } })).toEqual(
      { cells: { horizontal: { chat: chatCell, content: null }, vertical: {} } },
    );
  });

  it.each([
    ["an unknown layer", { content: { enabled: true } }],
    ["an unknown chat field", { chat: { color: "red" } }],
    ["an old pixel rect", { chat: { rect: { x: 0, y: 0, w: 280, h: 160 } } }],
    ["an unknown orientation", { orientation: "square" }],
    ["an unknown grid", { cells: { square: {} } }],
    ["an unknown cell key", { cells: { horizontal: { chat: { ...chatCell, z: 1 } } } }],
    ["a chat cell below the minimum", { cells: { horizontal: { chat: { c: 0, r: 0, w: 2, h: 2 } } } }],
    ["a characters cell below the minimum", { cells: { vertical: { characters: { c: 0, r: 0, w: 5, h: 2 } } } }],
    ["a cell outside the grid", { cells: { vertical: { chat: { c: 7, r: 0, w: 3, h: 2 } } } }],
    ["a null chat cell", { cells: { horizontal: { chat: null } } }],
    ["fractions", { cells: { horizontal: { content: { c: 0.5, r: 0, w: 4, h: 2 } } } }],
    [
      "overlapping cells",
      { cells: { horizontal: { chat: { c: 0, r: 0, w: 4, h: 4 }, content: { c: 3, r: 3, w: 4, h: 2 } } } },
    ],
    ["a null value", { chat: { enabled: null } }],
  ])("refuses %s", (_name: string, patch: Record<string, unknown>): void => {
    expect(layersPatchSchema.safeParse(patch).success).toBe(false);
  });

  it("changes only the given fields, copies each cell whole and removes a content cell with null", (): void => {
    const next: OverlayLayers = mergeLayers(DEFAULT_LAYERS, {
      orientation: "vertical",
      chat: { enabled: true },
      cells: { horizontal: { chat: chatCell, content: { c: 0, r: 0, w: 4, h: 2 } } },
    });
    expect(next).toEqual({
      ...DEFAULT_LAYERS,
      orientation: "vertical",
      chat: { enabled: true, hideCommands: true },
      cells: {
        horizontal: { ...DEFAULT_LAYERS.cells.horizontal, chat: chatCell, content: { c: 0, r: 0, w: 4, h: 2 } },
        vertical: DEFAULT_LAYERS.cells.vertical,
      },
    });
    expect(next.cells.horizontal.chat).not.toBe(chatCell);
    expect(next.cells.vertical.chat).not.toBe(DEFAULT_LAYERS.cells.vertical.chat);
    const removed: OverlayLayers = mergeLayers(next, { cells: { horizontal: { content: null } } });
    expect(removed.cells.horizontal.content).toBeNull();
    expect(mergeLayers(next, { characters: { enabled: true } }).characters).toEqual({ enabled: true, timeout: 60 });
    expect(mergeLayers(next, {})).toEqual(next);
    expect(DEFAULT_LAYERS.chat.enabled).toBe(false);
    for (const orientation of ORIENTATIONS) expect(GRID[orientation].cols * GRID[orientation].rows).toBe(144);
    expect(GRID_LAYERS).toEqual(["chat", "characters", "content"]);
  });
});

describe("characters timeout", (): void => {
  it("allows 10 to 600 seconds and defaults to 60 seconds", (): void => {
    expect(CHARACTERS_TIMEOUT).toEqual({ min: 10, max: 600, default: 60 });
    expect(DEFAULT_LAYERS.characters.timeout).toBe(60);
  });

  it("reads a stored timeout leniently: a missing or invalid one is the default", (): void => {
    const read = (timeout: unknown): number => storedLayersSchema.parse({ characters: { timeout } }).characters.timeout;
    expect(read(120)).toBe(120);
    expect(read(10)).toBe(10);
    expect(read(600)).toBe(600);
    for (const value of [undefined, 9, 601, 30.5, "60", null]) expect(read(value)).toBe(60);
    expect(storedLayersSchema.parse({ characters: { enabled: true, timeout: 5 } }).characters).toEqual({
      enabled: true,
      timeout: 60,
    });
  });

  it("accepts only whole seconds from 10 to 600 in a patch, and merges them", (): void => {
    for (const timeout of [10, 90, 600])
      expect(layersPatchSchema.parse({ characters: { timeout } })).toEqual({ characters: { timeout } });
    for (const timeout of [9, 601, 30.5, "60", null, Number.NaN])
      expect(layersPatchSchema.safeParse({ characters: { timeout } }).success).toBe(false);
    const enabled: OverlayLayers = mergeLayers(DEFAULT_LAYERS, { characters: { enabled: true } });
    expect(mergeLayers(enabled, { characters: { timeout: 300 } }).characters).toEqual({ enabled: true, timeout: 300 });
    expect(
      mergeLayers({ ...enabled, characters: { enabled: true, timeout: 300 } }, { characters: { enabled: false } })
        .characters,
    ).toEqual({
      enabled: false,
      timeout: 300,
    });
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
