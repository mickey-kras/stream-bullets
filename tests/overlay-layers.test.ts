import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CELL_PX,
  CHARACTERS_MAX,
  CHARACTERS_TIMEOUT,
  CHAT_BACKGROUND,
  CONTENT_LAYERS,
  DEFAULT_LAYERS,
  GRID,
  GRID_LAYERS,
  LAYERS_VERSION,
  LAYER_BACKGROUND,
  MIN_CELLS,
  ORIENTATIONS,
  OVERLAY_LAYERS,
  STORED_LAYERS_LENGTH,
  cellFits,
  cellPixels,
  contentSources,
  emptyCells,
  frameSize,
  layerEnabled,
  layerPixels,
  layerUrl,
  layersPatchSchema,
  mergeLayers,
  onStream,
  overlappingPair,
  parseLayerParam,
  placedContent,
  storedLayersSchema,
  storedLayersText,
  type CellRect,
  type ContentItem,
  type ContentLayer,
  type LayerCells,
  type OverlayLayers,
} from "../app/lib/overlay-layers";
import { FRAME_CHARS_MAX } from "../app/lib/playground/protocol";

// Pure rules for overlay layers: the grid, stored values, patches and layer URLs.

const chatCell: CellRect = { c: 20, r: 0, w: 12, h: 10 };
/** Layers with the chat and the characters on the grid of both orientations, both off. */
const LAID: OverlayLayers = {
  ...DEFAULT_LAYERS,
  cells: {
    horizontal: { ...emptyCells(), chat: { c: 0, r: 0, w: 10, h: 14 }, characters: { c: 0, r: 14, w: 32, h: 4 } },
    vertical: { ...emptyCells(), chat: { c: 0, r: 16, w: 18, h: 10 }, characters: { c: 0, r: 26, w: 18, h: 6 } },
  },
};
// Free cells of the horizontal layout of LAID: the chat has columns 0 to 4, the characters have rows 7 and 8.
const pollCell: CellRect = { c: 10, r: 0, w: 8, h: 4 };
const topicCell: CellRect = { c: 18, r: 0, w: 8, h: 4 };
const item: ContentItem = { enabled: true, ref: null, backgroundOpacity: 100, qr: false };
const defaultItems: Record<ContentLayer, ContentItem> = {
  poll: { ...item, qr: true },
  topic: item,
  next: item,
  message: item,
  card: item,
  support: item,
};

/** LAID with more cells in the horizontal orientation. */
function withCells(cells: Partial<LayerCells>, items: Partial<Record<ContentLayer, ContentItem>> = {}): OverlayLayers {
  return {
    ...LAID,
    items: { ...LAID.items, ...items },
    cells: { ...LAID.cells, horizontal: { ...LAID.cells.horizontal, ...cells } },
  };
}

/** The stored text of `layers` as a value, for the lenient read. */
function stored(layers: OverlayLayers): unknown {
  return JSON.parse(storedLayersText(layers));
}

describe("grid and defaults", (): void => {
  it("has a 32 x 18 horizontal and an 18 x 32 vertical grid of 60 px cells", (): void => {
    expect(OVERLAY_LAYERS).toEqual(["content", "chat", "characters"]);
    expect(CELL_PX).toBe(60);
    expect(GRID).toEqual({ horizontal: { cols: 32, rows: 18 }, vertical: { cols: 18, rows: 32 } });
    expect(frameSize("horizontal")).toEqual({ w: 1920, h: 1080 });
    expect(frameSize("vertical")).toEqual({ w: 1080, h: 1920 });
    const least = { w: 8, h: 4 };
    expect(MIN_CELLS).toEqual({
      chat: { w: 6, h: 4 },
      characters: { w: 12, h: 4 },
      poll: least,
      topic: least,
      next: least,
      message: least,
      card: least,
      support: least,
      camera: { w: 6, h: 4 },
    });
  });

  it("has one grid layer for each content source, after the chat and the characters, and the camera frame last", (): void => {
    expect(CONTENT_LAYERS).toEqual(["poll", "topic", "next", "message", "card", "support"]);
    expect(GRID_LAYERS).toEqual(["chat", "characters", ...CONTENT_LAYERS, "camera"]);
    expect(LAYER_BACKGROUND).toEqual({ min: 0, max: 100, step: 5, default: 100 });
    expect(CHAT_BACKGROUND).toBe(LAYER_BACKGROUND);
  });

  it("keeps the chat, the characters and the camera frame off and every layer off the grid by default", (): void => {
    const none = { chat: null, characters: null, poll: null, topic: null, next: null, message: null, card: null };
    expect(DEFAULT_LAYERS).toEqual({
      orientation: "horizontal",
      chat: { enabled: false, hideCommands: true, backgroundOpacity: 100 },
      characters: { enabled: false, timeout: 60, max: 40 },
      camera: { enabled: false },
      items: defaultItems,
      cells: {
        horizontal: { ...none, support: null, camera: null },
        vertical: { ...none, support: null, camera: null },
      },
    });
    expect(emptyCells()).toEqual(DEFAULT_LAYERS.cells.horizontal);
    expect(emptyCells()).not.toBe(emptyCells());
  });

  it("shows a layer on stream when it is enabled and has a cell in the selected orientation", (): void => {
    for (const layer of GRID_LAYERS) expect(onStream(DEFAULT_LAYERS, layer), layer).toBe(false);
    // The chat of LAID has a cell and is off. The poll is on and has no cell.
    expect(layerEnabled(LAID, "chat")).toBe(false);
    expect(layerEnabled(LAID, "poll")).toBe(true);
    expect(onStream(LAID, "chat")).toBe(false);
    expect(onStream(LAID, "poll")).toBe(false);
    const on: OverlayLayers = {
      ...withCells({ poll: pollCell, topic: topicCell }, { topic: { ...item, enabled: false } }),
      chat: { ...LAID.chat, enabled: true },
      characters: { ...LAID.characters, enabled: true },
    };
    expect(GRID_LAYERS.filter((layer) => onStream(on, layer))).toEqual(["chat", "characters", "poll"]);
    expect(layerEnabled(on, "characters")).toBe(true);
    expect(layerEnabled(on, "topic")).toBe(false);
    // The vertical orientation has the chat and the characters, not the poll.
    expect(GRID_LAYERS.filter((layer) => onStream({ ...on, orientation: "vertical" }, layer))).toEqual([
      "chat",
      "characters",
    ]);
  });

  it("converts cells to design pixels and finds the place of a layer in the selected orientation", (): void => {
    expect(cellPixels({ c: 2, r: 4, w: 6, h: 8 })).toEqual({ x: 120, y: 240, w: 360, h: 480 });
    expect(layerPixels(LAID, "chat")).toEqual({ x: 0, y: 0, w: 600, h: 840 });
    expect(layerPixels({ ...LAID, orientation: "vertical" }, "characters")).toEqual({
      x: 0,
      y: 1560,
      w: 1080,
      h: 360,
    });
    expect(layerPixels(DEFAULT_LAYERS, "chat")).toBeNull();
    expect(layerPixels(LAID, "poll")).toBeNull();
    expect(layerPixels(withCells({ poll: pollCell }), "poll")).toEqual({ x: 600, y: 0, w: 480, h: 240 });
  });

  it("checks the grid edges and minimum sizes per orientation", (): void => {
    expect(cellFits("horizontal", "chat", { c: 26, r: 14, w: 6, h: 4 })).toBe(true);
    expect(cellFits("horizontal", "chat", { c: 27, r: 14, w: 6, h: 4 })).toBe(false);
    expect(cellFits("horizontal", "chat", { c: 0, r: 15, w: 6, h: 4 })).toBe(false);
    expect(cellFits("horizontal", "chat", { c: 0, r: 0, w: 5, h: 4 })).toBe(false);
    expect(cellFits("horizontal", "chat", { c: 0, r: 0, w: 6, h: 3 })).toBe(false);
    expect(cellFits("vertical", "characters", { c: 0, r: 0, w: 18, h: 4 })).toBe(true);
    expect(cellFits("vertical", "characters", { c: 0, r: 0, w: 19, h: 4 })).toBe(false);
    expect(cellFits("horizontal", "characters", { c: 0, r: 0, w: 12, h: 3 })).toBe(false);
    expect(cellFits("horizontal", "characters", { c: 0, r: 0, w: 11, h: 4 })).toBe(false);
    for (const layer of CONTENT_LAYERS) {
      expect(cellFits("horizontal", layer, { c: 24, r: 14, w: 8, h: 4 }), layer).toBe(true);
      expect(cellFits("horizontal", layer, { c: 0, r: 0, w: 7, h: 4 }), layer).toBe(false);
      expect(cellFits("horizontal", layer, { c: 0, r: 0, w: 8, h: 3 }), layer).toBe(false);
      expect(cellFits("vertical", layer, { c: 10, r: 0, w: 8, h: 4 }), layer).toBe(true);
      expect(cellFits("vertical", layer, { c: 11, r: 0, w: 8, h: 4 }), layer).toBe(false);
    }
  });

  it("finds overlapping layers and ignores a layer without a cell and shared edges", (): void => {
    const cells = LAID.cells.horizontal;
    expect(overlappingPair(cells)).toBeNull();
    expect(overlappingPair(LAID.cells.vertical)).toBeNull();
    expect(overlappingPair({ ...cells, characters: { c: 0, r: 12, w: 32, h: 4 } })).toEqual(["chat", "characters"]);
    expect(overlappingPair({ ...cells, chat: null, poll: { c: 0, r: 0, w: 8, h: 4 } })).toBeNull();
    expect(overlappingPair({})).toBeNull();
    expect(overlappingPair(emptyCells())).toBeNull();
  });

  it("finds a content layer over another layer and over another content layer", (): void => {
    const cells = LAID.cells.horizontal;
    expect(overlappingPair({ ...cells, poll: pollCell, topic: topicCell })).toBeNull();
    expect(overlappingPair({ ...cells, poll: { c: 8, r: 0, w: 8, h: 4 } })).toEqual(["chat", "poll"]);
    expect(overlappingPair({ ...cells, topic: pollCell, card: pollCell })).toEqual(["topic", "card"]);
    expect(overlappingPair({ ...cells, poll: pollCell, support: { c: 16, r: 2, w: 8, h: 4 } })).toEqual([
      "poll",
      "support",
    ]);
  });

  it("gives the content layers on stream: with a cell in the selected orientation, and enabled", (): void => {
    expect(placedContent(LAID)).toEqual([]);
    expect(contentSources(LAID)).toEqual([]);
    const card: ContentItem = { ...item, ref: "c1", backgroundOpacity: 40 };
    const layers: OverlayLayers = withCells(
      { card: topicCell, poll: pollCell, next: { c: 10, r: 4, w: 8, h: 4 }, topic: { c: 10, r: 8, w: 8, h: 4 } },
      { card, next: { ...item, enabled: false }, topic: { ...item, ref: "t1" } },
    );
    expect(placedContent(layers)).toEqual([
      { layer: "poll", rect: pollCell, item: defaultItems.poll, source: { type: "auto", ref: null } },
      {
        layer: "topic",
        rect: { c: 10, r: 8, w: 8, h: 4 },
        item: { ...item, ref: "t1" },
        source: { type: "topic", ref: "t1" },
      },
      { layer: "card", rect: topicCell, item: card, source: { type: "card", ref: "c1" } },
    ]);
    // A poll layer with a ref shows that poll. A card layer without a ref stays a card source.
    const picked: OverlayLayers = withCells(
      { poll: pollCell, card: topicCell },
      { poll: { ...defaultItems.poll, ref: "p1" } },
    );
    expect(contentSources(picked)).toEqual([
      { type: "poll", ref: "p1" },
      { type: "card", ref: null },
    ]);
    // The other orientation has no content layer cell.
    expect(contentSources({ ...picked, orientation: "vertical" })).toEqual([]);
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
    first.cells.horizontal.chat = { c: 6, r: 0, w: 6, h: 4 };
    first.chat.enabled = true;
    expect(storedLayersSchema.parse({})).toEqual(DEFAULT_LAYERS);
    expect(DEFAULT_LAYERS.cells.horizontal.chat).toBeNull();
    const fallback: OverlayLayers = storedLayersSchema.parse(null);
    fallback.cells.vertical.poll = pollCell;
    expect(DEFAULT_LAYERS.cells.vertical.poll).toBeNull();
  });

  it("reads a missing value, also as a missing key of an enclosing object, as fresh defaults", (): void => {
    expect(storedLayersSchema.parse(undefined)).toEqual(DEFAULT_LAYERS);
    const message = z.object({ layers: storedLayersSchema });
    expect(message.parse({}).layers).toEqual(DEFAULT_LAYERS);
  });

  it("keeps valid cells of both orientations and the selected orientation", (): void => {
    const layers = {
      orientation: "vertical",
      chat: { enabled: true, hideCommands: false, backgroundOpacity: 35 },
      characters: { enabled: true, timeout: 60, max: 40 },
      camera: { enabled: true },
      items: {
        ...defaultItems,
        poll: { enabled: false, ref: "p1", backgroundOpacity: 0, qr: false },
        card: { enabled: true, ref: "c1", backgroundOpacity: 55, qr: true },
      },
      cells: {
        horizontal: {
          ...emptyCells(),
          chat: chatCell,
          characters: { c: 0, r: 14, w: 32, h: 4 },
          poll: { c: 12, r: 0, w: 8, h: 6 },
          support: { c: 0, r: 8, w: 20, h: 6 },
          camera: { c: 1, r: 1, w: 11, h: 7 },
        },
        vertical: { ...emptyCells(), characters: { c: 0, r: 28, w: 18, h: 4 }, message: { c: 0, r: 8, w: 18, h: 4 } },
      },
    };
    expect(storedLayersSchema.parse(layers)).toEqual(layers);
  });

  it("reads a missing or incorrect content layer setting as its default and keeps the other settings", (): void => {
    const read = (items: unknown): Record<ContentLayer, ContentItem> => storedLayersSchema.parse({ items }).items;
    for (const items of [undefined, null, "items", [], {}]) expect(read(items)).toEqual(defaultItems);
    expect(read({ poll: { ref: "p1" }, topic: "t1", next: null, extra: { enabled: false } })).toEqual({
      ...defaultItems,
      poll: { ...defaultItems.poll, ref: "p1" },
    });
    expect(
      read({
        poll: { enabled: "no", ref: 5, backgroundOpacity: 3, qr: "yes" },
        card: { enabled: false, ref: "x".repeat(65), backgroundOpacity: 45, qr: true, theme: "neon" },
        topic: { ref: "" },
      }),
    ).toEqual({ ...defaultItems, card: { enabled: false, ref: null, backgroundOpacity: 45, qr: true } });
    // A layer that has no ref reads a stored ref as null.
    for (const layer of ["next", "message", "support"] as const)
      expect(read({ [layer]: { enabled: false, ref: "r1" } })[layer]).toEqual({ ...item, enabled: false });
  });

  it("reads an invalid or overlapping cell as no cell", (): void => {
    const read = (cells: Record<string, unknown>): LayerCells =>
      storedLayersSchema.parse({ cells: { horizontal: cells } }).cells.horizontal;
    const usual = LAID.cells.horizontal;
    expect(read({ ...usual, poll: pollCell, topic: topicCell })).toEqual({
      ...usual,
      poll: pollCell,
      topic: topicCell,
    });
    // Outside the grid, below the minimum, not a cell, over the chat and over the characters.
    for (const poll of [{ c: 26, r: 0, w: 8, h: 4 }, { c: 10, r: 0, w: 6, h: 4 }, "cell", 7])
      expect(read({ ...usual, poll })).toEqual(usual);
    expect(read({ ...usual, poll: { c: 8, r: 0, w: 8, h: 4 } })).toEqual(usual);
    expect(read({ ...usual, support: { c: 12, r: 12, w: 8, h: 4 } })).toEqual(usual);
    // The earlier layer of GRID_LAYERS keeps its cell: chat, characters, poll, then the layers after it.
    expect(read({ chat: usual.chat, characters: { c: 0, r: 12, w: 32, h: 4 } })).toEqual({
      ...emptyCells(),
      chat: usual.chat,
    });
    expect(read({ poll: pollCell, topic: { c: 16, r: 2, w: 8, h: 4 }, card: topicCell })).toEqual({
      ...emptyCells(),
      poll: pollCell,
      card: topicCell,
    });
    // The vertical grid has its own cells.
    expect(
      storedLayersSchema.parse({ cells: { vertical: { next: { c: 0, r: 0, w: 18, h: 4 } } } }).cells.vertical.next,
    ).toEqual({ c: 0, r: 0, w: 18, h: 4 });
  });

  it("returns fresh content layer settings, so editing one result never changes the defaults", (): void => {
    for (const value of [{}, null]) {
      const layers: OverlayLayers = storedLayersSchema.parse(value);
      layers.items.poll.enabled = false;
      layers.items.card.ref = "c1";
    }
    const partial: OverlayLayers = storedLayersSchema.parse({ items: { topic: "none" } });
    partial.items.topic.backgroundOpacity = 0;
    expect(DEFAULT_LAYERS.items).toEqual(defaultItems);
    expect(storedLayersSchema.parse({})).toEqual(DEFAULT_LAYERS);
  });

  it("drops unknown keys from older or newer versions, also the version and the old pixel rects", (): void => {
    expect(
      storedLayersSchema.parse({
        v: LAYERS_VERSION + 1,
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
    ["past the right edge", { c: 28, r: 0, w: 6, h: 4 }],
    ["past the bottom edge", { c: 0, r: 16, w: 6, h: 4 }],
    ["negative", { c: -2, r: 0, w: 6, h: 4 }],
    ["below the minimum", { c: 0, r: 0, w: 4, h: 4 }],
    ["fractions", { c: 0.5, r: 0, w: 3, h: 2 }],
    ["text", { c: "0", r: 0, w: 3, h: 2 }],
    ["partial", { c: 0, r: 0, w: 3 }],
    ["not an object", "full"],
  ])("reads a chat cell %s as no cell and keeps the other fields", (_name: string, cell: unknown): void => {
    const layers = storedLayersSchema.parse({ chat: { enabled: true }, cells: { horizontal: { chat: cell } } });
    expect(layers).toEqual({ ...DEFAULT_LAYERS, chat: { ...DEFAULT_LAYERS.chat, enabled: true } });
  });

  it("reads the cell of the old content layer as an unknown key", (): void => {
    const cells = { horizontal: { content: { c: 12, r: 0, w: 8, h: 4 } } };
    expect(storedLayersSchema.parse({ cells })).toEqual(DEFAULT_LAYERS);
  });

  it("reads each field of the wrong type as its default", (): void => {
    expect(
      storedLayersSchema.parse({
        orientation: "diagonal",
        chat: { enabled: "yes", hideCommands: 0, backgroundOpacity: "50" },
        characters: { enabled: null },
        cells: { horizontal: [], vertical: 3 },
      }),
    ).toEqual(DEFAULT_LAYERS);
  });

  it("reads a missing or incorrect message background as the default and keeps the other chat fields", (): void => {
    const read = (chat: Record<string, unknown>): unknown => storedLayersSchema.parse({ chat }).chat;
    const old = { enabled: true, hideCommands: false };
    expect(read(old)).toEqual({ ...old, backgroundOpacity: 100 });
    for (const backgroundOpacity of [3, -5, 105, 2.5, "50", null, Number.NaN])
      expect(read({ ...old, backgroundOpacity })).toEqual({ ...old, backgroundOpacity: 100 });
    for (const backgroundOpacity of [0, 5, 50, 100])
      expect(read({ ...old, backgroundOpacity })).toEqual({ ...old, backgroundOpacity });
  });

  it.each([
    ["null", null],
    ["a string", "layers"],
    ["an array", []],
    ["layers of the wrong type", { chat: "on", characters: 1, cells: "none" }],
  ])("reads %s as the default layers and never throws", (_name: string, value: unknown): void => {
    expect(storedLayersSchema.parse(value)).toEqual(DEFAULT_LAYERS);
  });

  it("stays short enough for the 4000-character column limit with every layer set", (): void => {
    expect(STORED_LAYERS_LENGTH).toBe(4000);
    // Each layer on the grid of both orientations, with the longest ref and no setting at its default.
    const ref = "x".repeat(64);
    const cell: CellRect = { c: 20, r: 20, w: 32, h: 32 };
    const cells: LayerCells = {
      chat: cell,
      characters: cell,
      poll: cell,
      topic: cell,
      next: cell,
      message: cell,
      card: cell,
      support: cell,
      camera: cell,
    };
    const changed: ContentItem = { enabled: false, ref: null, backgroundOpacity: 55, qr: true };
    const full: OverlayLayers = {
      orientation: "horizontal",
      chat: { enabled: false, hideCommands: false, backgroundOpacity: 100 },
      characters: { enabled: false, timeout: 600, max: 5 },
      camera: { enabled: true },
      items: {
        poll: { ...changed, ref, qr: false },
        topic: { ...changed, ref },
        next: changed,
        message: changed,
        card: { ...changed, ref },
        support: changed,
      },
      cells: { horizontal: cells, vertical: cells },
    };
    expect(storedLayersText(full).length).toBeGreaterThan(1000);
    expect(storedLayersText(full).length).toBeLessThan(STORED_LAYERS_LENGTH / 2);
  });

  it("stores the version, and leaves out what the read fills in", (): void => {
    const { orientation, chat, characters } = DEFAULT_LAYERS;
    const before = { v: LAYERS_VERSION, orientation, chat, characters };
    expect(LAYERS_VERSION).toBe(3);
    expect(storedLayersText(DEFAULT_LAYERS)).toBe(
      JSON.stringify({ ...before, cells: { horizontal: {}, vertical: {} } }),
    );
    const layers: OverlayLayers = {
      ...withCells(
        { poll: pollCell, card: topicCell, characters: null },
        {
          poll: { enabled: false, ref: "p1", backgroundOpacity: 45, qr: false },
          card: { ...item, ref: "c1" },
          next: { ...item, qr: true },
        },
      ),
      orientation: "vertical",
    };
    expect(stored(layers)).toEqual({
      ...before,
      orientation: "vertical",
      items: {
        poll: { enabled: false, ref: "p1", backgroundOpacity: 45, qr: false },
        card: { ref: "c1" },
        next: { qr: true },
      },
      cells: {
        horizontal: { chat: LAID.cells.horizontal.chat, poll: pollCell, card: topicCell },
        vertical: { chat: LAID.cells.vertical.chat, characters: LAID.cells.vertical.characters },
      },
    });
    // The lenient read gives the same layers back.
    expect(storedLayersSchema.parse(stored(layers))).toEqual(layers);
    expect(storedLayersSchema.parse(stored(DEFAULT_LAYERS))).toEqual(DEFAULT_LAYERS);
    expect(storedLayersSchema.parse(stored(LAID))).toEqual(LAID);
  });
});

describe("camera frame", (): void => {
  // Free cells of LAID: right of the chat, above the characters.
  const frame: CellRect = { c: 20, r: 6, w: 12, h: 6 };

  it("is a grid layer with its own switch, off until the owner puts it on the grid", (): void => {
    expect(DEFAULT_LAYERS.camera).toEqual({ enabled: false });
    expect(layerEnabled(DEFAULT_LAYERS, "camera")).toBe(false);
    const placed: OverlayLayers = withCells({ camera: frame });
    expect(onStream(placed, "camera")).toBe(false);
    const on: OverlayLayers = { ...placed, camera: { enabled: true } };
    expect(onStream(on, "camera")).toBe(true);
    expect(layerPixels(on, "camera")).toEqual({ x: 1200, y: 360, w: 720, h: 360 });
    // The vertical orientation has no camera frame.
    expect(onStream({ ...on, orientation: "vertical" }, "camera")).toBe(false);
    // The frame is not a content layer: it has no source.
    expect(contentSources(on)).toEqual([]);
  });

  it("has a smallest size of 6 x 4 cells and keeps other layers out of its cells", (): void => {
    expect(cellFits("horizontal", "camera", { c: 26, r: 14, w: 6, h: 4 })).toBe(true);
    expect(cellFits("horizontal", "camera", { c: 0, r: 0, w: 5, h: 4 })).toBe(false);
    expect(cellFits("horizontal", "camera", { c: 0, r: 0, w: 6, h: 3 })).toBe(false);
    expect(cellFits("vertical", "camera", { c: 13, r: 0, w: 6, h: 4 })).toBe(false);
    expect(overlappingPair({ ...emptyCells(), poll: pollCell, camera: { c: 14, r: 2, w: 6, h: 4 } })).toEqual([
      "poll",
      "camera",
    ]);
    expect(overlappingPair({ ...emptyCells(), poll: pollCell, camera: frame })).toBeNull();
  });

  it("stores the frame only while it is on, and reads a value without it as off", (): void => {
    const off: OverlayLayers = withCells({ camera: frame });
    expect(stored(off)).not.toHaveProperty("camera");
    expect(stored(off)).toMatchObject({ cells: { horizontal: { camera: frame } } });
    const on: OverlayLayers = { ...off, camera: { enabled: true } };
    expect(stored(on)).toMatchObject({ camera: { enabled: true } });
    expect(storedLayersSchema.parse(stored(on))).toEqual(on);
    expect(storedLayersSchema.parse(stored(off))).toEqual(off);
    // A value from before the camera frame, and a value with an incorrect setting.
    expect(storedLayersSchema.parse({}).camera).toEqual({ enabled: false });
    expect(storedLayersSchema.parse({ camera: "on" }).camera).toEqual({ enabled: false });
    expect(storedLayersSchema.parse({ camera: { enabled: "yes", size: 3 } }).camera).toEqual({ enabled: false });
  });

  it("reads a frame cell that is invalid, or over an earlier layer, as no cell", (): void => {
    const read = (camera: unknown): CellRect | null =>
      storedLayersSchema.parse({ cells: { horizontal: { chat: chatCell, camera } } }).cells.horizontal.camera;
    expect(read({ c: 0, r: 0, w: 12, h: 6 })).toEqual({ c: 0, r: 0, w: 12, h: 6 });
    expect(read({ c: 0, r: 0, w: 5, h: 4 })).toBeNull();
    expect(read({ c: 30, r: 0, w: 6, h: 4 })).toBeNull();
    // The chat is earlier in the order of the layers, so it keeps its cell.
    expect(read({ c: 18, r: 2, w: 6, h: 4 })).toBeNull();
    expect(read("frame")).toBeNull();
  });

  it("takes the switch and the cell in a patch, and refuses other fields and invalid cells", (): void => {
    const ok = (patch: unknown): boolean => layersPatchSchema.safeParse(patch).success;
    expect(
      ok({ camera: { enabled: true }, cells: { horizontal: { camera: frame }, vertical: { camera: null } } }),
    ).toBe(true);
    expect(ok({ camera: {} })).toBe(true);
    expect(ok({ camera: { enabled: "yes" } })).toBe(false);
    expect(ok({ camera: { enabled: true, style: "gold" } })).toBe(false);
    expect(ok({ cells: { horizontal: { camera: { c: 0, r: 0, w: 5, h: 4 } } } })).toBe(false);
    expect(ok({ cells: { horizontal: { poll: pollCell, camera: { c: 14, r: 2, w: 6, h: 4 } } } })).toBe(false);
    const next: OverlayLayers = mergeLayers(LAID, {
      camera: { enabled: true },
      cells: { horizontal: { camera: frame } },
    });
    expect(next.camera).toEqual({ enabled: true });
    expect(next.cells.horizontal.camera).toEqual(frame);
    expect(next.cells.horizontal.camera).not.toBe(frame);
    expect(mergeLayers(next, {}).camera).toEqual({ enabled: true });
    expect(mergeLayers(next, { cells: { horizontal: { camera: null } } }).cells.horizontal.camera).toBeNull();
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
    const cells = { horizontal: { chat: chatCell, characters: null }, vertical: { chat: null } };
    expect(layersPatchSchema.parse({ cells })).toEqual({ cells });
  });

  it("accepts content layer settings and cells", (): void => {
    const patch = {
      items: {
        poll: { enabled: false, ref: "p1", backgroundOpacity: 45, qr: false },
        topic: { ref: "x".repeat(64) },
        card: { ref: null },
        next: { ref: null, enabled: true },
        message: { backgroundOpacity: 0 },
        support: { qr: true },
      },
      cells: {
        horizontal: { poll: pollCell, topic: topicCell, card: null },
        vertical: { next: { c: 0, r: 0, w: 8, h: 4 }, message: { c: 10, r: 28, w: 8, h: 4 }, support: null },
      },
    };
    expect(layersPatchSchema.parse(patch)).toEqual(patch);
    expect(layersPatchSchema.parse({ items: {} })).toEqual({ items: {} });
  });

  it.each([
    ["an unknown layer", { content: { enabled: true } }],
    ["an unknown chat field", { chat: { color: "red" } }],
    ["an old pixel rect", { chat: { rect: { x: 0, y: 0, w: 280, h: 160 } } }],
    ["an unknown orientation", { orientation: "square" }],
    ["an unknown grid", { cells: { square: {} } }],
    ["an unknown cell key", { cells: { horizontal: { chat: { ...chatCell, z: 1 } } } }],
    ["a chat cell below the minimum", { cells: { horizontal: { chat: { c: 0, r: 0, w: 4, h: 4 } } } }],
    ["a characters cell below the minimum", { cells: { vertical: { characters: { c: 0, r: 0, w: 10, h: 4 } } } }],
    ["a cell outside the grid", { cells: { vertical: { chat: { c: 14, r: 0, w: 6, h: 4 } } } }],
    ["a cell of the old content layer", { cells: { horizontal: { content: null } } }],
    ["fractions", { cells: { horizontal: { poll: { c: 0.5, r: 0, w: 4, h: 2 } } } }],
    [
      "overlapping cells",
      { cells: { horizontal: { chat: { c: 0, r: 0, w: 8, h: 8 }, characters: { c: 0, r: 6, w: 12, h: 4 } } } },
    ],
    ["a null value", { chat: { enabled: null } }],
    ["a message background that is not a step of 5", { chat: { backgroundOpacity: 3 } }],
    ["a negative message background", { chat: { backgroundOpacity: -5 } }],
    ["a message background above 100", { chat: { backgroundOpacity: 105 } }],
    ["a message background as text", { chat: { backgroundOpacity: "50" } }],
    ["a fractional message background", { chat: { backgroundOpacity: 2.5 } }],
    ["a null message background", { chat: { backgroundOpacity: null } }],
    ["an unknown content layer", { items: { auto: { enabled: true } } }],
    ["an unknown content layer setting", { items: { poll: { color: "red" } } }],
    ["a ref on the Up next layer", { items: { next: { ref: "n1" } } }],
    ["a ref on the message layer", { items: { message: { ref: "m1" } } }],
    ["a ref on the support layer", { items: { support: { ref: "s1" } } }],
    ["an empty ref", { items: { poll: { ref: "" } } }],
    ["a ref above 64 characters", { items: { card: { ref: "x".repeat(65) } } }],
    ["a ref that is not text", { items: { topic: { ref: 5 } } }],
    ["a content layer background that is not a step of 5", { items: { poll: { backgroundOpacity: 3 } } }],
    ["a content layer switch that is not a boolean", { items: { poll: { enabled: "yes" } } }],
    ["a QR switch that is not a boolean", { items: { poll: { qr: 1 } } }],
    ["a null content layer", { items: { poll: null } }],
    ["a content layer cell below the minimum", { cells: { horizontal: { poll: { c: 10, r: 0, w: 6, h: 4 } } } }],
    ["a content layer cell outside the grid", { cells: { vertical: { card: { c: 12, r: 0, w: 8, h: 4 } } } }],
    ["a content layer cell over the chat cell", { cells: { horizontal: { chat: chatCell, poll: chatCell } } }],
    ["two content layers in one cell", { cells: { horizontal: { poll: pollCell, support: pollCell } } }],
  ])("refuses %s", (_name: string, patch: Record<string, unknown>): void => {
    expect(layersPatchSchema.safeParse(patch).success).toBe(false);
  });

  it.each([0, 5, 100])("accepts a message background of %i percent", (backgroundOpacity: number): void => {
    expect(layersPatchSchema.parse({ chat: { backgroundOpacity } })).toEqual({ chat: { backgroundOpacity } });
  });

  it("merges the message background alone and keeps it when a patch does not name it", (): void => {
    const faint: OverlayLayers = mergeLayers(DEFAULT_LAYERS, { chat: { backgroundOpacity: 0 } });
    expect(faint.chat).toEqual({ enabled: false, hideCommands: true, backgroundOpacity: 0 });
    // A patch from an older editor has no such field.
    expect(mergeLayers(faint, { chat: { enabled: true } }).chat).toEqual({
      enabled: true,
      hideCommands: true,
      backgroundOpacity: 0,
    });
  });

  it("changes only the given fields, copies each cell whole and removes a cell with null", (): void => {
    const next: OverlayLayers = mergeLayers(LAID, {
      orientation: "vertical",
      chat: { enabled: true },
      cells: { horizontal: { chat: chatCell } },
    });
    expect(next).toEqual({
      ...LAID,
      orientation: "vertical",
      chat: { enabled: true, hideCommands: true, backgroundOpacity: 100 },
      cells: { horizontal: { ...LAID.cells.horizontal, chat: chatCell }, vertical: LAID.cells.vertical },
    });
    expect(next.cells.horizontal.chat).not.toBe(chatCell);
    expect(next.cells.vertical.chat).not.toBe(LAID.cells.vertical.chat);
    const removed: OverlayLayers = mergeLayers(next, { cells: { horizontal: { chat: null } } });
    expect(removed.cells.horizontal).toEqual({ ...LAID.cells.horizontal, chat: null });
    expect(removed.cells.vertical).toEqual(LAID.cells.vertical);
    expect(mergeLayers(next, { characters: { enabled: true } }).characters).toEqual({
      enabled: true,
      timeout: 60,
      max: 40,
    });
    expect(mergeLayers(next, {})).toEqual(next);
    expect(DEFAULT_LAYERS.chat.enabled).toBe(false);
    for (const orientation of ORIENTATIONS) expect(GRID[orientation].cols * GRID[orientation].rows).toBe(576);
  });

  it("merges content layer settings and cells, copies each cell and removes a cell with null", (): void => {
    const next: OverlayLayers = mergeLayers(DEFAULT_LAYERS, {
      items: { poll: { ref: "p1", qr: false }, card: { enabled: false, backgroundOpacity: 0 } },
      cells: { horizontal: { poll: pollCell }, vertical: { card: { c: 0, r: 0, w: 8, h: 4 } } },
    });
    expect(next).toEqual({
      ...DEFAULT_LAYERS,
      items: {
        ...defaultItems,
        poll: { enabled: true, ref: "p1", backgroundOpacity: 100, qr: false },
        card: { enabled: false, ref: null, backgroundOpacity: 0, qr: false },
      },
      cells: {
        horizontal: { ...DEFAULT_LAYERS.cells.horizontal, poll: pollCell },
        vertical: { ...DEFAULT_LAYERS.cells.vertical, card: { c: 0, r: 0, w: 8, h: 4 } },
      },
    });
    expect(next.cells.horizontal.poll).not.toBe(pollCell);
    expect(next.items.topic).not.toBe(DEFAULT_LAYERS.items.topic);
    // A patch keeps what it does not name. Null takes the ref and the cell away.
    const kept: OverlayLayers = mergeLayers(next, { items: { poll: { enabled: false } }, cells: { horizontal: {} } });
    expect(kept.items.poll).toEqual({ enabled: false, ref: "p1", backgroundOpacity: 100, qr: false });
    expect(kept.cells).toEqual(next.cells);
    const cleared: OverlayLayers = mergeLayers(next, {
      items: { poll: { ref: null } },
      cells: { horizontal: { poll: null } },
    });
    expect(cleared.items.poll.ref).toBeNull();
    expect(cleared.cells.horizontal.poll).toBeNull();
    expect(cleared.cells.vertical.card).toEqual({ c: 0, r: 0, w: 8, h: 4 });
    expect(DEFAULT_LAYERS.items).toEqual(defaultItems);
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
      max: 40,
    });
  });

  it("accepts only whole seconds from 10 to 600 in a patch, and merges them", (): void => {
    for (const timeout of [10, 90, 600])
      expect(layersPatchSchema.parse({ characters: { timeout } })).toEqual({ characters: { timeout } });
    for (const timeout of [9, 601, 30.5, "60", null, Number.NaN])
      expect(layersPatchSchema.safeParse({ characters: { timeout } }).success).toBe(false);
    const enabled: OverlayLayers = mergeLayers(DEFAULT_LAYERS, { characters: { enabled: true } });
    expect(mergeLayers(enabled, { characters: { timeout: 300 } }).characters).toEqual({
      enabled: true,
      timeout: 300,
      max: 40,
    });
    expect(
      mergeLayers(
        { ...enabled, characters: { enabled: true, timeout: 300, max: 40 } },
        { characters: { enabled: false } },
      ).characters,
    ).toEqual({
      enabled: false,
      timeout: 300,
      max: 40,
    });
  });
});

describe("characters maximum", (): void => {
  it("allows 5 to 40 characters and defaults to the frame limit", (): void => {
    expect(CHARACTERS_MAX).toEqual({ min: 5, max: 40, default: 40 });
    expect(CHARACTERS_MAX.max).toBe(FRAME_CHARS_MAX);
    expect(DEFAULT_LAYERS.characters.max).toBe(40);
  });

  it("reads a stored maximum leniently: a missing or invalid one is the default", (): void => {
    const read = (max: unknown): number => storedLayersSchema.parse({ characters: { max } }).characters.max;
    expect(read(5)).toBe(5);
    expect(read(12)).toBe(12);
    expect(read(40)).toBe(40);
    for (const value of [undefined, 4, 41, 12.5, "12", null]) expect(read(value)).toBe(40);
    // A text from before this setting keeps its timeout.
    expect(storedLayersSchema.parse({ characters: { enabled: true, timeout: 90 } }).characters).toEqual({
      enabled: true,
      timeout: 90,
      max: 40,
    });
  });

  it("accepts only whole numbers from 5 to 40 in a patch, and merges them", (): void => {
    for (const max of [5, 20, 40])
      expect(layersPatchSchema.parse({ characters: { max } })).toEqual({ characters: { max } });
    for (const max of [4, 41, 12.5, "12", null, Number.NaN])
      expect(layersPatchSchema.safeParse({ characters: { max } }).success).toBe(false);
    const lowered: OverlayLayers = mergeLayers(DEFAULT_LAYERS, { characters: { max: 12 } });
    expect(lowered.characters).toEqual({ enabled: false, timeout: 60, max: 12 });
    expect(mergeLayers(lowered, { characters: { timeout: 30 } }).characters).toEqual({
      enabled: false,
      timeout: 30,
      max: 12,
    });
  });

  it("stores the maximum and reads it again", (): void => {
    const lowered: OverlayLayers = mergeLayers(DEFAULT_LAYERS, { characters: { max: 12 } });
    const text: string = storedLayersText(lowered);
    expect(JSON.parse(text)).toMatchObject({ characters: { enabled: false, timeout: 60, max: 12 } });
    expect(storedLayersSchema.parse(JSON.parse(text))).toEqual(lowered);
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
