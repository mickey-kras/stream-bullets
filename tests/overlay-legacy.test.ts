import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OVERLAY_POSITIONS, OVERLAY_SIZES, OVERLAY_SOURCES } from "../db/enums";
import {
  LEGACY_DEFAULT,
  legacyLayersText,
  parseStoredLayers,
  withPollOverride,
  type LegacyContent,
} from "../app/lib/overlay-legacy";
import {
  CONTENT_LAYERS,
  DEFAULT_LAYERS,
  GRID_LAYERS,
  LAYERS_VERSION,
  ORIENTATIONS,
  cellFits,
  cellPixels,
  emptyCells,
  onStream,
  overlappingPair,
  storedLayersText,
  type CellRect,
  type ContentLayer,
  type GridLayer,
  type LayerCells,
  type OverlayLayers,
} from "../app/lib/overlay-layers";
import type { OverlaySource } from "../app/types";
import fixture from "./fixtures/overlay-layers-120.json";

// Overlay state from before the overlay studio: one source on air, and chat and characters cells that always exist.
// The old texts have cells of 120 px (16 x 9 across). The read gives cells of 60 px: see `fine`.

const oldChat = { horizontal: { c: 0, r: 0, w: 5, h: 7 }, vertical: { c: 0, r: 8, w: 9, h: 5 } };
const oldCharacters = { horizontal: { c: 0, r: 7, w: 16, h: 2 }, vertical: { c: 0, r: 13, w: 9, h: 3 } };

/** A cell of the old grid as cells of today: each old cell is 2 x 2 cells. */
function fine(rect: CellRect): CellRect {
  return { c: rect.c * 2, r: rect.r * 2, w: rect.w * 2, h: rect.h * 2 };
}

/** An old stored text: chat and characters cells in both orientations, and a `content` cell or null. */
function oldText(
  options: {
    chat?: boolean;
    characters?: boolean;
    content?: CellRect | null;
    cells?: Record<string, unknown>;
    orientation?: string;
  } = {},
): string {
  const cells = (orientation: "horizontal" | "vertical"): Record<string, unknown> => ({
    chat: oldChat[orientation],
    characters: oldCharacters[orientation],
    content: orientation === "horizontal" ? (options.content ?? null) : null,
    ...(orientation === "horizontal" ? options.cells : {}),
  });
  return JSON.stringify({
    orientation: options.orientation ?? "horizontal",
    chat: { enabled: options.chat ?? false, hideCommands: false, backgroundOpacity: 40 },
    characters: { enabled: options.characters ?? false, timeout: 90 },
    cells: { horizontal: cells("horizontal"), vertical: cells("vertical") },
  });
}

function air(type: OverlaySource, ref: string | null = null, more: Partial<LegacyContent> = {}): LegacyContent {
  return { air: { type, ref }, position: "lower", size: "m", ...more };
}

/** The layers that have a cell in the horizontal orientation. */
function placed(layers: OverlayLayers): GridLayer[] {
  return GRID_LAYERS.filter((layer: GridLayer): boolean => layers.cells.horizontal[layer] !== null);
}

describe("old stored text", (): void => {
  it("tells an old text from the current version", (): void => {
    expect(LAYERS_VERSION).toBe(3);
    for (const raw of ["{}", oldText(), '{"v":1}', '{"v":2}', '{"v":"3"}', "{", "", "null", "[]", '"v"'])
      expect(legacyLayersText(raw), raw).toBe(true);
    expect(legacyLayersText(storedLayersText(DEFAULT_LAYERS))).toBe(false);
    expect(legacyLayersText('{"v":3}')).toBe(false);
  });

  it("reads a text of the current version as it is, also with an old source on air", (): void => {
    const layers: OverlayLayers = {
      ...DEFAULT_LAYERS,
      chat: { enabled: false, hideCommands: false, backgroundOpacity: 40 },
      cells: { horizontal: { ...emptyCells(), chat: { c: 1, r: 3, w: 7, h: 5 } }, vertical: emptyCells() },
    };
    const raw: string = storedLayersText(layers);
    expect(parseStoredLayers(raw)).toEqual(layers);
    // The chat is off and keeps its cell. No content layer comes on the grid.
    expect(parseStoredLayers(raw, air("auto"))).toEqual(layers);
    expect(parseStoredLayers('{"v":3}', air("message"))).toEqual(DEFAULT_LAYERS);
  });

  it("takes a chat or characters layer that was off away from the grid and keeps its settings", (): void => {
    const layers: OverlayLayers = parseStoredLayers(oldText());
    expect(layers).toEqual({
      ...DEFAULT_LAYERS,
      chat: { enabled: false, hideCommands: false, backgroundOpacity: 40 },
      characters: { enabled: false, pushEnabled: true, timeout: 90, max: 40 },
    });
    expect(parseStoredLayers(oldText({ orientation: "vertical" })).orientation).toBe("vertical");
  });

  it("keeps the cells of a chat or characters layer that was on, in both orientations", (): void => {
    const chat: OverlayLayers = parseStoredLayers(oldText({ chat: true }));
    expect(chat.cells).toEqual({
      horizontal: { ...emptyCells(), chat: fine(oldChat.horizontal) },
      vertical: { ...emptyCells(), chat: fine(oldChat.vertical) },
    });
    expect(onStream(chat, "chat")).toBe(true);
    const both: OverlayLayers = parseStoredLayers(oldText({ chat: true, characters: true }));
    for (const orientation of ORIENTATIONS)
      expect(both.cells[orientation]).toEqual({
        ...emptyCells(),
        chat: fine(oldChat[orientation]),
        characters: fine(oldCharacters[orientation]),
      });
    expect(both.characters).toEqual({ enabled: true, pushEnabled: true, timeout: 90, max: 40 });
  });

  it("gives a layer that was on its old default cell when the text has no valid cell", (): void => {
    for (const raw of ['{"chat":{"enabled":true}}', '{"chat":{"enabled":true},"cells":{"horizontal":{"chat":"x"}}}']) {
      const layers: OverlayLayers = parseStoredLayers(raw);
      expect(layers.cells.horizontal.chat, raw).toEqual(fine(oldChat.horizontal));
      expect(layers.cells.vertical.chat, raw).toEqual(fine(oldChat.vertical));
      expect(layers.cells.horizontal.characters, raw).toBeNull();
    }
    // Chat and characters cells that overlap both took their defaults.
    const cells = { chat: { c: 0, r: 5, w: 16, h: 4 }, characters: { c: 0, r: 7, w: 16, h: 2 } };
    const raw: string = JSON.stringify({
      chat: { enabled: true },
      characters: { enabled: true },
      cells: { horizontal: cells },
    });
    expect(parseStoredLayers(raw).cells.horizontal).toEqual({
      ...emptyCells(),
      chat: fine(oldChat.horizontal),
      characters: fine(oldCharacters.horizontal),
    });
  });

  it("gives an old text the default alerts and goal, off the grid, and keeps them in a text of this version", (): void => {
    for (const raw of [oldText({ chat: true, characters: true }), '{"v":2}', "{}", "{"]) {
      const layers: OverlayLayers = parseStoredLayers(raw, LEGACY_DEFAULT);
      expect(layers.alerts, raw).toEqual(DEFAULT_LAYERS.alerts);
      expect(layers.goal, raw).toEqual(DEFAULT_LAYERS.goal);
      for (const orientation of ORIENTATIONS) {
        expect(layers.cells[orientation].alerts, raw).toBeNull();
        expect(layers.cells[orientation].goal, raw).toBeNull();
      }
    }
    const current: OverlayLayers = {
      ...DEFAULT_LAYERS,
      alerts: {
        enabled: true,
        rules: { ...DEFAULT_LAYERS.alerts.rules, bits: { ...DEFAULT_LAYERS.alerts.rules.bits, min: 250 } },
      },
      goal: { enabled: true, title: "New subscribers", counts: "follows", target: 100 },
      cells: {
        horizontal: { ...emptyCells(), alerts: { c: 8, r: 0, w: 16, h: 3 }, goal: { c: 24, r: 0, w: 8, h: 2 } },
        vertical: emptyCells(),
      },
    };
    const raw: string = storedLayersText(current);
    expect(legacyLayersText(raw)).toBe(false);
    expect(parseStoredLayers(raw)).toEqual(current);
    // A text of this version has no old source on air to place.
    expect(parseStoredLayers(raw, air("auto"))).toEqual(current);
  });

  it("reads invalid JSON and other values as the defaults, with the old default source", (): void => {
    for (const raw of ["{", "", "null", "[]", "7"]) expect(parseStoredLayers(raw), raw).toEqual(DEFAULT_LAYERS);
    expect(placed(parseStoredLayers("{", LEGACY_DEFAULT))).toEqual(["poll"]);
  });
});

describe("old source on air", (): void => {
  it("has the old default: the latest active poll in the lower position at size M", (): void => {
    expect(LEGACY_DEFAULT).toEqual({ air: { type: "auto", ref: null }, position: "lower", size: "m" });
  });

  it("does not place a content layer without the old columns", (): void => {
    expect(placed(parseStoredLayers(oldText()))).toEqual([]);
  });

  it.each<[OverlaySource, string | null, ContentLayer, string | null]>([
    ["auto", null, "poll", null],
    ["poll", "p1", "poll", "p1"],
    ["topic", "t1", "topic", "t1"],
    ["next", null, "next", null],
    ["message", null, "message", null],
    ["card", "c1", "card", "c1"],
    ["card", null, "card", null],
    ["support", null, "support", null],
    // A ref on a source that has none does not go to the layer.
    ["next", "old", "next", null],
  ])("puts %s with ref %s on the grid as the %s layer with ref %s", (type, ref, layer, kept): void => {
    const layers: OverlayLayers = parseStoredLayers(oldText(), air(type, ref));
    expect(placed(layers)).toEqual([layer]);
    expect(layers.items[layer]).toEqual({ ...DEFAULT_LAYERS.items[layer], enabled: true, ref: kept });
    expect(onStream(layers, layer)).toBe(true);
    expect(onStream({ ...layers, orientation: "vertical" }, layer)).toBe(true);
    const others: ContentLayer[] = CONTENT_LAYERS.filter((other: ContentLayer): boolean => other !== layer);
    for (const other of others) expect(layers.items[other]).toEqual(DEFAULT_LAYERS.items[other]);
  });

  it("puts no layer on the grid for Hidden and for a specific poll without a poll", (): void => {
    expect(parseStoredLayers(oldText(), air("hidden"))).toEqual(parseStoredLayers(oldText()));
    expect(parseStoredLayers(oldText(), air("poll", null))).toEqual(parseStoredLayers(oldText()));
  });

  it("turns a layer on that a newer text had turned off", (): void => {
    const raw: string = JSON.stringify({ items: { message: { enabled: false, backgroundOpacity: 30 } } });
    expect(parseStoredLayers(raw, air("message")).items.message).toEqual({
      enabled: true,
      ref: null,
      backgroundOpacity: 30,
      qr: false,
    });
  });

  it("maps each old position and size to a cell of each orientation", (): void => {
    const cells = (position: LegacyContent["position"], size: LegacyContent["size"]): CellRect[] => {
      const layers: OverlayLayers = parseStoredLayers("{}", air("message", null, { position, size }));
      return ORIENTATIONS.map(
        (orientation): CellRect => layers.cells[orientation].message ?? { c: 0, r: 0, w: 0, h: 0 },
      );
    };
    // The numbers are those of the old grid.
    const cell = (c: number, r: number, w: number, h: number): CellRect => fine({ c, r, w, h });
    expect(cells("lower", "s")).toEqual([cell(0, 7, 8, 2), cell(0, 14, 7, 2)]);
    expect(cells("lower", "m")).toEqual([cell(0, 6, 10, 3), cell(0, 13, 9, 3)]);
    expect(cells("lower", "l")).toEqual([cell(0, 5, 12, 4), cell(0, 12, 9, 4)]);
    expect(cells("top", "s")).toEqual([cell(0, 0, 12, 2), cell(0, 0, 7, 2)]);
    expect(cells("top", "m")).toEqual([cell(0, 0, 16, 2), cell(0, 0, 9, 2)]);
    expect(cells("top", "l")).toEqual([cell(0, 0, 16, 3), cell(0, 0, 9, 3)]);
    expect(cells("corner", "s")).toEqual([cell(11, 7, 5, 2), cell(5, 14, 4, 2)]);
    expect(cells("corner", "m")).toEqual([cell(10, 6, 6, 3), cell(4, 13, 5, 3)]);
    expect(cells("corner", "l")).toEqual([cell(8, 5, 8, 4), cell(3, 12, 6, 4)]);
    expect(cells("center", "s")).toEqual([cell(5, 3, 6, 3), cell(2, 7, 5, 2)]);
    expect(cells("center", "m")).toEqual([cell(4, 3, 8, 3), cell(1, 6, 7, 3)]);
    expect(cells("center", "l")).toEqual([cell(3, 2, 10, 5), cell(0, 6, 9, 4)]);
  });

  it("gives a poll the cell of a full-frame poll for its size, whatever the position", (): void => {
    const cell = (c: number, r: number, w: number, h: number): CellRect => fine({ c, r, w, h });
    const expected: Record<LegacyContent["size"], CellRect[]> = {
      s: [cell(5, 0, 9, 5), cell(0, 0, 7, 6)],
      m: [cell(5, 0, 11, 7), cell(0, 0, 9, 8)],
      l: [cell(0, 0, 16, 9), cell(0, 0, 9, 10)],
    };
    for (const size of OVERLAY_SIZES)
      for (const position of OVERLAY_POSITIONS)
        for (const type of ["auto", "poll"] as const) {
          const layers: OverlayLayers = parseStoredLayers("{}", air(type, "p1", { position, size }));
          expect([layers.cells.horizontal.poll, layers.cells.vertical.poll], `${size} ${position}`).toEqual(
            expected[size],
          );
        }
  });

  it("gives every source, position and size a valid cell that touches no other layer", (): void => {
    const sources: OverlaySource[] = ["auto", "topic", "next", "message", "card", "support"];
    for (const raw of [oldText(), oldText({ chat: true }), oldText({ chat: true, characters: true })])
      for (const type of sources)
        for (const position of OVERLAY_POSITIONS)
          for (const size of OVERLAY_SIZES) {
            const layers: OverlayLayers = parseStoredLayers(raw, air(type, "r1", { position, size }));
            const layer: ContentLayer = type === "auto" ? "poll" : (type as ContentLayer);
            for (const orientation of ORIENTATIONS) {
              const cells: LayerCells = layers.cells[orientation];
              const rect: CellRect | null = cells[layer];
              expect(rect, `${type} ${position} ${size} ${orientation}`).not.toBeNull();
              expect(rect && cellFits(orientation, layer, rect)).toBe(true);
              expect(overlappingPair(cells)).toBeNull();
            }
          }
  });

  it("uses the old content cell of an orientation in place of the position", (): void => {
    const content: CellRect = { c: 6, r: 2, w: 9, h: 4 };
    const layers: OverlayLayers = parseStoredLayers(oldText({ chat: true, content }), air("topic", "t1"));
    expect(layers.cells.horizontal.topic).toEqual(fine(content));
    // The vertical orientation had no content cell: the layer takes the cell of the lower position, below the chat.
    expect(layers.cells.vertical.topic).toEqual(fine({ c: 0, r: 13, w: 9, h: 3 }));
    // An invalid content cell does not count.
    const small: OverlayLayers = parseStoredLayers(
      oldText({ content: { c: 0, r: 0, w: 2, h: 1 } }),
      air("topic", "t1"),
    );
    expect(small.cells.horizontal.topic).toEqual(fine({ c: 0, r: 6, w: 10, h: 3 }));
  });

  it("moves the layer to free space when its cell touches the chat or the characters on stream", (): void => {
    // The lower third touches the chat (columns 0 to 4) and the characters (rows 7 and 8): first free place.
    const lower: OverlayLayers = parseStoredLayers(oldText({ chat: true, characters: true }), air("next"));
    expect(lower.cells.horizontal.next).toEqual(fine({ c: 5, r: 0, w: 10, h: 3 }));
    // The poll cell at size M is the space beside the old default chat cell and above the characters.
    const poll: OverlayLayers = parseStoredLayers(oldText({ chat: true, characters: true }), air("auto"));
    expect(poll.cells.horizontal.poll).toEqual(fine({ c: 5, r: 0, w: 11, h: 7 }));
    expect(poll.cells.vertical.poll).toEqual(fine({ c: 0, r: 0, w: 9, h: 8 }));
    // At size L the poll wants the frame: it gets the largest free cell.
    const large: OverlayLayers = parseStoredLayers(
      oldText({ chat: true, characters: true }),
      air("auto", null, { size: "l" }),
    );
    expect(large.cells.horizontal.poll).toEqual(fine({ c: 5, r: 0, w: 11, h: 7 }));
    expect(large.cells.vertical.poll).toEqual(fine({ c: 0, r: 0, w: 9, h: 8 }));
    // A layer that is off does not take space: the poll keeps its cell.
    const off: OverlayLayers = parseStoredLayers(oldText(), air("auto", null, { size: "l" }));
    expect(off.cells.horizontal.poll).toEqual(fine({ c: 0, r: 0, w: 16, h: 9 }));
  });

  it("takes the largest free cell, and leaves the layer off the grid when no place is free", (): void => {
    const withChat = (chat: CellRect): string =>
      JSON.stringify({
        chat: { enabled: true },
        characters: { enabled: true },
        cells: { horizontal: { chat, characters: oldCharacters.horizontal } },
      });
    // Four free columns beside the chat.
    const narrow: OverlayLayers = parseStoredLayers(withChat({ c: 0, r: 0, w: 12, h: 7 }), air("auto"));
    expect(narrow.cells.horizontal.poll).toEqual(fine({ c: 12, r: 0, w: 4, h: 7 }));
    // A free strip of two rows under a chat across the top: the layer keeps its width.
    const strip: string = JSON.stringify({
      chat: { enabled: true },
      cells: { horizontal: { chat: { c: 0, r: 0, w: 16, h: 7 } } },
    });
    expect(parseStoredLayers(strip, air("next")).cells.horizontal.next).toEqual(fine({ c: 0, r: 7, w: 10, h: 2 }));
    // Three free columns are below the minimum width of a content layer.
    const thin: OverlayLayers = parseStoredLayers(withChat({ c: 0, r: 0, w: 13, h: 7 }), air("auto"));
    expect(thin.cells.horizontal.poll).toBeNull();
    // The chat and the characters fill the frame: the layer stays off the grid, with its settings.
    const full: OverlayLayers = parseStoredLayers(withChat({ c: 0, r: 0, w: 16, h: 7 }), air("poll", "p1"));
    expect(full.cells.horizontal.poll).toBeNull();
    expect(full.items.poll).toEqual({ ...DEFAULT_LAYERS.items.poll, ref: "p1" });
    // The vertical orientation of that text has only the old default cells, with free space.
    expect(full.cells.vertical.poll).toEqual(fine({ c: 0, r: 0, w: 9, h: 8 }));
  });

  it("leaves layers that already use a content layer as they are", (): void => {
    const support: CellRect = { c: 6, r: 0, w: 4, h: 2 };
    for (const cells of [{ horizontal: { support } }, { vertical: { support: { c: 0, r: 0, w: 4, h: 2 } } }]) {
      const raw: string = JSON.stringify({ cells });
      expect(parseStoredLayers(raw, air("auto"))).toEqual(parseStoredLayers(raw));
      expect(parseStoredLayers(raw, air("auto")).cells.horizontal.poll).toBeNull();
    }
  });

  it("converts once: the stored result reads as the current version and does not convert again", (): void => {
    const converted: OverlayLayers = parseStoredLayers(oldText({ chat: true }), air("card", "c1"));
    const raw: string = storedLayersText(converted);
    expect(legacyLayersText(raw)).toBe(false);
    expect(parseStoredLayers(raw, air("card", "c1"))).toEqual(converted);
    // The owner takes the layer off the grid. The old source does not bring it back.
    const removed: OverlayLayers = {
      ...converted,
      cells: {
        horizontal: { ...converted.cells.horizontal, card: null },
        vertical: { ...converted.cells.vertical, card: null },
      },
    };
    expect(parseStoredLayers(storedLayersText(removed), air("card", "c1"))).toEqual(removed);
  });
});

describe("poll override", (): void => {
  const pollCell: CellRect = { c: 0, r: 0, w: 8, h: 4 };
  const chatCell: CellRect = fine(oldChat.horizontal);

  it("shows the poll in the poll layer and takes the other content layers off the grid", (): void => {
    const layers: OverlayLayers = {
      ...DEFAULT_LAYERS,
      chat: { ...DEFAULT_LAYERS.chat, enabled: true },
      items: { ...DEFAULT_LAYERS.items, poll: { ...DEFAULT_LAYERS.items.poll, enabled: false, ref: "p1" } },
      cells: {
        horizontal: { ...emptyCells(), chat: chatCell, poll: { c: 11, r: 1, w: 9, h: 5 }, topic: pollCell },
        vertical: { ...emptyCells(), message: pollCell },
      },
    };
    const shown: OverlayLayers = withPollOverride(layers, "p2");
    expect(shown.items.poll).toEqual({ ...DEFAULT_LAYERS.items.poll, enabled: true, ref: "p2" });
    // The poll layer keeps its cell. Where it had none, it takes the cell of a full-frame poll.
    expect(shown.cells).toEqual({
      horizontal: { ...emptyCells(), chat: chatCell, poll: { c: 11, r: 1, w: 9, h: 5 } },
      vertical: { ...emptyCells(), poll: { c: 0, r: 0, w: 18, h: 16 } },
    });
    expect(shown.chat).toEqual(layers.chat);
    expect(layers.cells.horizontal.topic).toEqual(pollCell);
  });

  it("moves the poll to free space beside the chat", (): void => {
    const layers: OverlayLayers = parseStoredLayers(oldText({ chat: true, characters: true }), air("hidden"));
    expect(withPollOverride(layers, "p1").cells.horizontal.poll).toEqual({ c: 10, r: 0, w: 22, h: 14 });
    // A chat across the top leaves the five bottom rows: the poll takes them at its width.
    const top: OverlayLayers = {
      ...DEFAULT_LAYERS,
      cells: { horizontal: { ...emptyCells(), chat: { c: 0, r: 0, w: 32, h: 13 } }, vertical: emptyCells() },
    };
    expect(withPollOverride(top, "p1").cells.horizontal.poll).toEqual({ c: 0, r: 13, w: 22, h: 5 });
    expect(withPollOverride(DEFAULT_LAYERS, "p1").cells.horizontal.poll).toEqual({ c: 10, r: 0, w: 22, h: 14 });
  });
});

describe("cells of 120 px", (): void => {
  it("reads a text of version 2 with each cell as 2 x 2 cells, and converts once", (): void => {
    const chat: CellRect = { c: 13, r: 0, w: 3, h: 2 };
    const poll: CellRect = { c: 0, r: 0, w: 5, h: 3 };
    const card: CellRect = { c: 0, r: 14, w: 9, h: 2 };
    const raw: string = JSON.stringify({
      v: 2,
      orientation: "vertical",
      chat: { enabled: true, hideCommands: false, backgroundOpacity: 55 },
      items: { poll: { ref: "p1" } },
      cells: { horizontal: { chat, poll }, vertical: { card } },
    });
    expect(legacyLayersText(raw)).toBe(true);
    const layers: OverlayLayers = parseStoredLayers(raw);
    expect(layers).toEqual({
      ...DEFAULT_LAYERS,
      orientation: "vertical",
      chat: { enabled: true, hideCommands: false, backgroundOpacity: 55 },
      items: { ...DEFAULT_LAYERS.items, poll: { ...DEFAULT_LAYERS.items.poll, ref: "p1" } },
      cells: {
        horizontal: { ...emptyCells(), chat: fine(chat), poll: fine(poll) },
        vertical: { ...emptyCells(), card: fine(card) },
      },
    });
    // A text of version 2 has no old source on air to place.
    expect(parseStoredLayers(raw, air("message"))).toEqual(layers);
    const stored: string = storedLayersText(layers);
    expect(legacyLayersText(stored)).toBe(false);
    expect(parseStoredLayers(stored)).toEqual(layers);
  });

  it("drops a cell of version 2 that the old grid did not keep", (): void => {
    const cells = {
      // Outside the old grid, below the old minimum size, a fraction, and over the chat.
      chat: { c: 0, r: 0, w: 3, h: 2 },
      characters: { c: 11, r: 7, w: 6, h: 2 },
      poll: { c: 4, r: 0, w: 4, h: 1 },
      topic: { c: 8, r: 0, w: 4.5, h: 2 },
      next: { c: 2, r: 1, w: 4, h: 2 },
    };
    const layers: OverlayLayers = parseStoredLayers(JSON.stringify({ v: 2, cells: { horizontal: cells } }));
    expect(layers.cells.horizontal).toEqual({ ...emptyCells(), chat: fine(cells.chat) });
  });

  // The fixture holds what the code before issue #1032 read from each text, in cells of 120 px:
  // [text, old source on air as "type:ref:position:size" or null, horizontal cells, vertical cells].
  const oldCells = z.partialRecord(z.enum(GRID_LAYERS), z.tuple([z.number(), z.number(), z.number(), z.number()]));
  const cases = z.array(z.tuple([z.number(), z.string().nullable(), oldCells, oldCells])).parse(fixture.cases);

  function source(name: string): LegacyContent {
    const [type, ref, position, size] = name.split(":");
    return {
      air: { type: z.enum(OVERLAY_SOURCES).parse(type), ref: ref === "" ? null : ref },
      position: z.enum(OVERLAY_POSITIONS).parse(position),
      size: z.enum(OVERLAY_SIZES).parse(size),
    };
  }

  it("gives each old layout the same place in design pixels in both orientations", (): void => {
    expect(cases.length).toBeGreaterThan(100);
    for (const [text, name, horizontal, vertical] of cases) {
      const raw: string = fixture.texts[text];
      const layers: OverlayLayers = parseStoredLayers(raw, name === null ? undefined : source(name));
      const old = { horizontal, vertical };
      for (const orientation of ORIENTATIONS)
        for (const layer of GRID_LAYERS) {
          const rect: CellRect | null = layers.cells[orientation][layer];
          const cell: [number, number, number, number] | undefined = old[orientation][layer];
          const before = cell ? { x: cell[0] * 120, y: cell[1] * 120, w: cell[2] * 120, h: cell[3] * 120 } : null;
          expect(rect && cellPixels(rect), `${raw} ${name} ${orientation} ${layer}`).toEqual(before);
        }
      expect(parseStoredLayers(storedLayersText(layers)), `${raw} ${name}`).toEqual(layers);
    }
  });
});
