import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CELL_PX,
  CHARACTERS_TIMEOUT,
  CHAT_BACKGROUND,
  CONTENT_LAYERS,
  DEFAULT_LAYERS,
  EDITOR_LAYERS,
  GRID,
  GRID_LAYERS,
  LAYER_BACKGROUND,
  MIN_CELLS,
  ORIENTATIONS,
  OVERLAY_LAYERS,
  STORED_LAYERS_LENGTH,
  cellFits,
  cellPixels,
  contentSources,
  frameSize,
  layerPixels,
  layerUrl,
  layersPatchSchema,
  mergeLayers,
  overlappingPair,
  parseLayerParam,
  parseStoredLayers,
  placedContent,
  storedLayersSchema,
  storedLayersText,
  type CellRect,
  type ContentItem,
  type ContentLayer,
  type LayerCells,
  type OverlayLayers,
} from "../app/lib/overlay-layers";

// Pure rules for overlay layers: the grid, stored values, patches and layer URLs.

const chatCell: CellRect = { c: 10, r: 0, w: 6, h: 5 };
// Free cells of the default horizontal layout: the chat has columns 0 to 4, the characters have rows 7 and 8.
const pollCell: CellRect = { c: 5, r: 0, w: 4, h: 2 };
const topicCell: CellRect = { c: 9, r: 0, w: 4, h: 2 };
const noContentCells = { poll: null, topic: null, next: null, message: null, card: null, support: null };
const item: ContentItem = { enabled: true, ref: null, backgroundOpacity: 100, qr: false };
const defaultItems: Record<ContentLayer, ContentItem> = {
  poll: { ...item, qr: true },
  topic: item,
  next: item,
  message: item,
  card: item,
  support: item,
};

/** The default layers with content layer cells in the horizontal orientation. */
function withCells(cells: Partial<LayerCells>, items: Partial<Record<ContentLayer, ContentItem>> = {}): OverlayLayers {
  return {
    ...DEFAULT_LAYERS,
    items: { ...DEFAULT_LAYERS.items, ...items },
    cells: { ...DEFAULT_LAYERS.cells, horizontal: { ...DEFAULT_LAYERS.cells.horizontal, ...cells } },
  };
}

describe("grid and defaults", (): void => {
  it("has a 16 x 9 horizontal and a 9 x 16 vertical grid of 120 px cells", (): void => {
    expect(OVERLAY_LAYERS).toEqual(["content", "chat", "characters"]);
    expect(CELL_PX).toBe(120);
    expect(frameSize("horizontal")).toEqual({ w: 1920, h: 1080 });
    expect(frameSize("vertical")).toEqual({ w: 1080, h: 1920 });
    const least = { w: 4, h: 2 };
    expect(MIN_CELLS).toEqual({
      chat: { w: 3, h: 2 },
      characters: { w: 6, h: 2 },
      content: least,
      poll: least,
      topic: least,
      next: least,
      message: least,
      card: least,
      support: least,
    });
  });

  it("has one grid layer for each content source, after the layers of the editor", (): void => {
    expect(CONTENT_LAYERS).toEqual(["poll", "topic", "next", "message", "card", "support"]);
    expect(EDITOR_LAYERS).toEqual(["chat", "characters", "content"]);
    expect(GRID_LAYERS).toEqual([...EDITOR_LAYERS, ...CONTENT_LAYERS]);
    expect(LAYER_BACKGROUND).toEqual({ min: 0, max: 100, step: 5, default: 100 });
    expect(CHAT_BACKGROUND).toBe(LAYER_BACKGROUND);
  });

  it("keeps chat and characters off, content without a cell, and valid default cells that do not overlap", (): void => {
    expect(DEFAULT_LAYERS).toEqual({
      orientation: "horizontal",
      chat: { enabled: false, hideCommands: true, backgroundOpacity: 100 },
      characters: { enabled: false, timeout: 60 },
      items: defaultItems,
      cells: {
        horizontal: {
          chat: { c: 0, r: 0, w: 5, h: 7 },
          characters: { c: 0, r: 7, w: 16, h: 2 },
          content: null,
          ...noContentCells,
        },
        vertical: {
          chat: { c: 0, r: 8, w: 9, h: 5 },
          characters: { c: 0, r: 13, w: 9, h: 3 },
          content: null,
          ...noContentCells,
        },
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
    expect(layerPixels(DEFAULT_LAYERS, "poll")).toBeNull();
    expect(layerPixels(withCells({ poll: pollCell }), "poll")).toEqual({ x: 600, y: 0, w: 480, h: 240 });
  });

  it("checks the grid edges and minimum sizes per orientation", (): void => {
    expect(cellFits("horizontal", "chat", { c: 13, r: 7, w: 3, h: 2 })).toBe(true);
    expect(cellFits("horizontal", "chat", { c: 14, r: 7, w: 3, h: 2 })).toBe(false);
    expect(cellFits("horizontal", "chat", { c: 0, r: 8, w: 3, h: 2 })).toBe(false);
    expect(cellFits("vertical", "characters", { c: 0, r: 0, w: 9, h: 2 })).toBe(true);
    expect(cellFits("vertical", "characters", { c: 0, r: 0, w: 10, h: 2 })).toBe(false);
    expect(cellFits("horizontal", "content", { c: 0, r: 0, w: 3, h: 2 })).toBe(false);
    expect(cellFits("horizontal", "characters", { c: 0, r: 0, w: 6, h: 1 })).toBe(false);
    for (const layer of CONTENT_LAYERS) {
      expect(cellFits("horizontal", layer, { c: 12, r: 7, w: 4, h: 2 }), layer).toBe(true);
      expect(cellFits("horizontal", layer, { c: 0, r: 0, w: 3, h: 2 }), layer).toBe(false);
      expect(cellFits("vertical", layer, { c: 6, r: 0, w: 4, h: 2 }), layer).toBe(false);
    }
  });

  it("finds overlapping layers and ignores content without a cell and shared edges", (): void => {
    const cells = DEFAULT_LAYERS.cells.horizontal;
    expect(overlappingPair({ ...cells, content: { c: 5, r: 0, w: 4, h: 2 } })).toBeNull();
    expect(overlappingPair({ ...cells, content: { c: 4, r: 0, w: 4, h: 2 } })).toEqual(["chat", "content"]);
    expect(overlappingPair({ ...cells, characters: { c: 0, r: 6, w: 16, h: 2 } })).toEqual(["chat", "characters"]);
    expect(overlappingPair({})).toBeNull();
  });

  it("finds a content layer over another layer, over content and over another content layer", (): void => {
    const cells = DEFAULT_LAYERS.cells.horizontal;
    expect(overlappingPair({ ...cells, poll: pollCell, topic: topicCell })).toBeNull();
    expect(overlappingPair({ ...cells, poll: { c: 4, r: 0, w: 4, h: 2 } })).toEqual(["chat", "poll"]);
    expect(overlappingPair({ ...cells, content: pollCell, card: pollCell })).toEqual(["content", "card"]);
    expect(overlappingPair({ ...cells, poll: pollCell, support: { c: 8, r: 1, w: 4, h: 2 } })).toEqual([
      "poll",
      "support",
    ]);
  });

  it("gives the content layers on stream: with a cell in the selected orientation, and enabled", (): void => {
    expect(placedContent(DEFAULT_LAYERS)).toEqual([]);
    expect(contentSources(DEFAULT_LAYERS)).toEqual([]);
    const card: ContentItem = { ...item, ref: "c1", backgroundOpacity: 40 };
    const layers: OverlayLayers = withCells(
      { card: topicCell, poll: pollCell, next: { c: 5, r: 2, w: 4, h: 2 }, topic: { c: 5, r: 4, w: 4, h: 2 } },
      { card, next: { ...item, enabled: false }, topic: { ...item, ref: "t1" } },
    );
    expect(placedContent(layers)).toEqual([
      { layer: "poll", rect: pollCell, item: defaultItems.poll, source: { type: "auto", ref: null } },
      {
        layer: "topic",
        rect: { c: 5, r: 4, w: 4, h: 2 },
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
      chat: { enabled: true, hideCommands: false, backgroundOpacity: 35 },
      characters: { enabled: true, timeout: 60 },
      items: {
        ...defaultItems,
        poll: { enabled: false, ref: "p1", backgroundOpacity: 0, qr: false },
        card: { enabled: true, ref: "c1", backgroundOpacity: 55, qr: true },
      },
      cells: {
        horizontal: {
          chat: chatCell,
          characters: { c: 0, r: 7, w: 16, h: 2 },
          content: { c: 0, r: 0, w: 6, h: 4 },
          ...noContentCells,
          poll: { c: 6, r: 0, w: 4, h: 3 },
          support: { c: 0, r: 4, w: 10, h: 3 },
        },
        vertical: {
          chat: { c: 0, r: 0, w: 9, h: 4 },
          characters: { c: 0, r: 14, w: 9, h: 2 },
          content: null,
          ...noContentCells,
          message: { c: 0, r: 4, w: 9, h: 2 },
        },
      },
    };
    expect(storedLayersSchema.parse(stored)).toEqual(stored);
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

  it("reads an invalid or overlapping content layer cell as no cell", (): void => {
    const read = (cells: Record<string, unknown>): LayerCells =>
      storedLayersSchema.parse({ cells: { horizontal: cells } }).cells.horizontal;
    const usual: LayerCells = DEFAULT_LAYERS.cells.horizontal;
    expect(read({ poll: pollCell, topic: topicCell })).toEqual({ ...usual, poll: pollCell, topic: topicCell });
    // Outside the grid, below the minimum, not a cell, over the chat and over the characters.
    for (const poll of [{ c: 13, r: 0, w: 4, h: 2 }, { c: 5, r: 0, w: 3, h: 2 }, "cell", 7])
      expect(read({ poll })).toEqual(usual);
    expect(read({ poll: { c: 4, r: 0, w: 4, h: 2 } })).toEqual(usual);
    expect(read({ support: { c: 6, r: 6, w: 4, h: 2 } })).toEqual(usual);
    // The earlier layer of GRID_LAYERS keeps its cell: content, then poll, then the layers after it.
    expect(read({ content: pollCell, poll: pollCell })).toEqual({ ...usual, content: pollCell });
    expect(read({ poll: pollCell, topic: { c: 8, r: 1, w: 4, h: 2 }, card: topicCell })).toEqual({
      ...usual,
      poll: pollCell,
      card: topicCell,
    });
    // The vertical grid has its own cells.
    expect(
      storedLayersSchema.parse({ cells: { vertical: { next: { c: 0, r: 0, w: 9, h: 2 } } } }).cells.vertical.next,
    ).toEqual({ c: 0, r: 0, w: 9, h: 2 });
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
    expect(parseStoredLayers('{"chat":{"enabled":true,"backgroundOpacity":0}}').chat.backgroundOpacity).toBe(0);
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
      chat: { enabled: false, hideCommands: false, backgroundOpacity: 100 },
      characters: { enabled: false, timeout: 600 },
      cells: {
        horizontal: { ...DEFAULT_LAYERS.cells.horizontal, content: { c: 10, r: 0, w: 6, h: 7 } },
        vertical: { ...DEFAULT_LAYERS.cells.vertical, content: { c: 0, r: 0, w: 9, h: 8 } },
      },
    };
    expect(STORED_LAYERS_LENGTH).toBe(1000);
    expect(storedLayersText(full).length).toBeLessThan(STORED_LAYERS_LENGTH);
    // Each content layer on the grid of one orientation, with a poll, a topic and a card picked.
    const ref = "20000000-0000-4000-8000-000000000011";
    const cell: CellRect = { c: 10, r: 10, w: 4, h: 2 };
    const placed: OverlayLayers = {
      ...full,
      items: {
        ...DEFAULT_LAYERS.items,
        poll: { ...DEFAULT_LAYERS.items.poll, ref },
        topic: { ...DEFAULT_LAYERS.items.topic, ref },
        card: { ...DEFAULT_LAYERS.items.card, ref },
      },
      cells: {
        ...full.cells,
        vertical: {
          ...full.cells.vertical,
          poll: cell,
          topic: cell,
          next: cell,
          message: cell,
          card: cell,
          support: cell,
        },
      },
    };
    expect(storedLayersText(placed).length).toBeLessThan(STORED_LAYERS_LENGTH);
  });

  it("stores layers without a content layer as before, and leaves out what the read fills in", (): void => {
    const { orientation, chat, characters } = DEFAULT_LAYERS;
    const before = { orientation, chat, characters };
    const cells = (orientation: "horizontal" | "vertical"): unknown => {
      const { chat, characters, content } = DEFAULT_LAYERS.cells[orientation];
      return { chat, characters, content };
    };
    expect(storedLayersText(DEFAULT_LAYERS)).toBe(
      JSON.stringify({ ...before, cells: { horizontal: cells("horizontal"), vertical: cells("vertical") } }),
    );
    const layers: OverlayLayers = {
      ...withCells(
        { poll: pollCell, card: topicCell },
        {
          poll: { enabled: false, ref: "p1", backgroundOpacity: 45, qr: false },
          card: { ...item, ref: "c1" },
          next: { ...item, qr: true },
        },
      ),
      orientation: "vertical",
    };
    const stored: unknown = JSON.parse(storedLayersText(layers));
    expect(stored).toEqual({
      ...before,
      orientation: "vertical",
      items: {
        poll: { enabled: false, ref: "p1", backgroundOpacity: 45, qr: false },
        card: { ref: "c1" },
        next: { qr: true },
      },
      cells: {
        horizontal: { ...(cells("horizontal") as object), poll: pollCell, card: topicCell },
        vertical: cells("vertical"),
      },
    });
    // The lenient read gives the same layers back.
    expect(parseStoredLayers(storedLayersText(layers))).toEqual(layers);
    expect(parseStoredLayers(storedLayersText(DEFAULT_LAYERS))).toEqual(DEFAULT_LAYERS);
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
        vertical: { next: { c: 0, r: 0, w: 4, h: 2 }, message: { c: 5, r: 14, w: 4, h: 2 }, support: null },
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
    ["a content layer cell below the minimum", { cells: { horizontal: { poll: { c: 5, r: 0, w: 3, h: 2 } } } }],
    ["a content layer cell outside the grid", { cells: { vertical: { card: { c: 6, r: 0, w: 4, h: 2 } } } }],
    ["a content layer cell over the chat cell", { cells: { horizontal: { chat: chatCell, poll: chatCell } } }],
    ["two content layers in one cell", { cells: { horizontal: { poll: pollCell, support: pollCell } } }],
    ["a content layer over the content cell", { cells: { horizontal: { content: pollCell, next: pollCell } } }],
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

  it("changes only the given fields, copies each cell whole and removes a content cell with null", (): void => {
    const next: OverlayLayers = mergeLayers(DEFAULT_LAYERS, {
      orientation: "vertical",
      chat: { enabled: true },
      cells: { horizontal: { chat: chatCell, content: { c: 0, r: 0, w: 4, h: 2 } } },
    });
    expect(next).toEqual({
      ...DEFAULT_LAYERS,
      orientation: "vertical",
      chat: { enabled: true, hideCommands: true, backgroundOpacity: 100 },
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
  });

  it("merges content layer settings and cells, copies each cell and removes a cell with null", (): void => {
    const next: OverlayLayers = mergeLayers(DEFAULT_LAYERS, {
      items: { poll: { ref: "p1", qr: false }, card: { enabled: false, backgroundOpacity: 0 } },
      cells: { horizontal: { poll: pollCell }, vertical: { card: { c: 0, r: 0, w: 4, h: 2 } } },
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
        vertical: { ...DEFAULT_LAYERS.cells.vertical, card: { c: 0, r: 0, w: 4, h: 2 } },
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
    expect(cleared.cells.vertical.card).toEqual({ c: 0, r: 0, w: 4, h: 2 });
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
