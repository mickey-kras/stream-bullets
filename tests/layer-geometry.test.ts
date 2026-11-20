import { describe, expect, it } from "vitest";
import {
  RESIZE_HANDLES,
  diffLayers,
  dropCell,
  firstFreeCell,
  gridCells,
  growCell,
  handleAt,
  handleLines,
  isEmptyPatch,
  layerAt,
  layersAction,
  layoutProblem,
  mergePatches,
  moveCell,
  onGrid,
  placeProblem,
  resizeCell,
  spanCells,
  withCell,
  withPlaced,
  withRemoved,
  withoutSent,
  type Cell,
  type ResizeHandle,
} from "../app/lib/layer-geometry";
import {
  DEFAULT_LAYERS,
  EDITOR_LAYERS,
  MIN_CELLS,
  overlappingPair,
  type CellRect,
  type EditorLayer,
  type LayerCells,
  type LayersPatch,
  type OverlayLayers,
} from "../app/lib/overlay-layers";

const write = { writer: "editor-1234", seq: 1 };
const cell: CellRect = { c: 10, r: 0, w: 6, h: 4 };

function layers(): OverlayLayers {
  return structuredClone({ ...DEFAULT_LAYERS, chat: { ...DEFAULT_LAYERS.chat, enabled: true } });
}

describe("grid edits", () => {
  it("spans the rectangle between two cells in either direction", () => {
    expect(spanCells({ c: 2, r: 3 }, { c: 5, r: 4 })).toEqual({ c: 2, r: 3, w: 4, h: 2 });
    expect(spanCells({ c: 5, r: 4 }, { c: 2, r: 3 })).toEqual({ c: 2, r: 3, w: 4, h: 2 });
    expect(spanCells({ c: 1, r: 1 }, { c: 1, r: 1 })).toEqual({ c: 1, r: 1, w: 1, h: 1 });
  });

  it("moves a cell by the grabbed cell and keeps it inside the grid", () => {
    expect(moveCell("horizontal", cell, { c: 1, r: 1 }, { c: 4, r: 3 })).toEqual({ c: 3, r: 2, w: 6, h: 4 });
    expect(moveCell("horizontal", cell, { c: 0, r: 0 }, { c: 15, r: 8 })).toEqual({ c: 10, r: 5, w: 6, h: 4 });
    expect(moveCell("vertical", cell, { c: 0, r: 0 }, { c: 8, r: 15 })).toEqual({ c: 3, r: 12, w: 6, h: 4 });
    expect(moveCell("horizontal", cell, { c: 2, r: 2 }, { c: 0, r: 0 })).toEqual({ c: 0, r: 0, w: 6, h: 4 });
  });

  it("finds the layer at a cell", () => {
    const cells = { ...DEFAULT_LAYERS.cells.horizontal, content: cell };
    expect(layerAt(cells, { c: 0, r: 0 })).toBe("chat");
    expect(layerAt(cells, { c: 4, r: 6 })).toBe("chat");
    expect(layerAt(cells, { c: 5, r: 6 })).toBeNull();
    expect(layerAt(cells, { c: 15, r: 8 })).toBe("characters");
    expect(layerAt(cells, { c: 12, r: 2 })).toBe("content");
    expect(layerAt(DEFAULT_LAYERS.cells.horizontal, { c: 12, r: 2 })).toBeNull();
  });

  it("refuses a cell over another layer or below the minimum size, and allows the layer's own place", () => {
    const cells = DEFAULT_LAYERS.cells.horizontal;
    expect(placeProblem("horizontal", cells, "content", cell)).toBeNull();
    expect(placeProblem("horizontal", cells, "content", { c: 4, r: 0, w: 4, h: 2 })).toEqual({
      kind: "overlap",
      other: "chat",
    });
    expect(placeProblem("horizontal", cells, "chat", { c: 0, r: 5, w: 5, h: 3 })).toEqual({
      kind: "overlap",
      other: "characters",
    });
    expect(placeProblem("horizontal", cells, "chat", { c: 1, r: 1, w: 5, h: 5 })).toBeNull();
    expect(placeProblem("horizontal", cells, "content", { c: 10, r: 0, w: 3, h: 2 })).toEqual({ kind: "small" });
    expect(placeProblem("horizontal", cells, "characters", { c: 6, r: 0, w: 5, h: 2 })).toEqual({ kind: "small" });
  });

  it("refuses a cell outside the grid of the orientation", () => {
    const cells = DEFAULT_LAYERS.cells.horizontal;
    // A horizontal cell at column 10 does not fit the 9 columns of the vertical grid.
    expect(placeProblem("vertical", DEFAULT_LAYERS.cells.vertical, "content", cell)).toEqual({ kind: "outside" });
    expect(placeProblem("horizontal", cells, "content", { c: 12, r: 0, w: 5, h: 2 })).toEqual({ kind: "outside" });
    expect(placeProblem("horizontal", cells, "content", { c: 10, r: 5, w: 4, h: 5 })).toEqual({ kind: "outside" });
    expect(placeProblem("horizontal", cells, "content", { c: -1, r: 0, w: 4, h: 2 })).toEqual({ kind: "outside" });
    expect(placeProblem("horizontal", cells, "content", { c: 6, r: -1, w: 4, h: 2 })).toEqual({ kind: "outside" });
    expect(placeProblem("horizontal", cells, "content", { c: 12, r: 0, w: 4, h: 2 })).toBeNull();
  });

  it("replaces one layer's cell in one orientation and removes a content cell", () => {
    const placed: OverlayLayers = withCell(layers(), "vertical", "content", { c: 0, r: 0, w: 9, h: 4 });
    expect(placed.cells.vertical.content).toEqual({ c: 0, r: 0, w: 9, h: 4 });
    expect(placed.cells.horizontal).toEqual(DEFAULT_LAYERS.cells.horizontal);
    expect(withCell(placed, "vertical", "content", null).cells.vertical.content).toBeNull();
    expect(withCell(placed, "horizontal", "chat", cell).cells.horizontal.chat).toEqual(cell);
    // Chat and characters always keep a cell.
    expect(withCell(placed, "horizontal", "chat", null).cells.horizontal.chat).toEqual(
      DEFAULT_LAYERS.cells.horizontal.chat,
    );
  });
});

describe("field-level patches", () => {
  it("diffs only the changed fields", () => {
    const before = layers();
    expect(diffLayers(before, layers())).toEqual({});
    const after: OverlayLayers = {
      orientation: "vertical",
      chat: { enabled: false, hideCommands: false, backgroundOpacity: 40 },
      characters: { enabled: true, timeout: 90 },
      items: before.items,
      cells: {
        horizontal: { ...before.cells.horizontal, chat: cell, content: { c: 5, r: 0, w: 4, h: 2 } },
        vertical: before.cells.vertical,
      },
    };
    expect(diffLayers(before, after)).toEqual({
      orientation: "vertical",
      chat: { enabled: false, hideCommands: false, backgroundOpacity: 40 },
      characters: { enabled: true, timeout: 90 },
      cells: { horizontal: { chat: cell, content: { c: 5, r: 0, w: 4, h: 2 } } },
    });
    expect(
      diffLayers(after, {
        ...after,
        cells: { ...after.cells, horizontal: { ...after.cells.horizontal, content: null } },
      }),
    ).toEqual({
      cells: { horizontal: { content: null } },
    });
    expect(diffLayers(before, { ...before, chat: { ...before.chat, hideCommands: false } })).toEqual({
      chat: { hideCommands: false },
    });
    expect(diffLayers(before, { ...before, chat: { ...before.chat, backgroundOpacity: 0 } })).toEqual({
      chat: { backgroundOpacity: 0 },
    });
  });

  it("merges patches with the newer field winning, and checks emptiness", () => {
    const merged = mergePatches(
      { chat: { enabled: true, hideCommands: true }, cells: { horizontal: { chat: cell, content: null } } },
      { chat: { enabled: false }, orientation: "vertical", cells: { horizontal: { content: cell } } },
    );
    expect(merged).toEqual({
      orientation: "vertical",
      chat: { enabled: false, hideCommands: true },
      cells: { horizontal: { chat: cell, content: cell } },
    });
    expect(mergePatches({ orientation: "vertical" }, {})).toEqual({ orientation: "vertical" });
    // Each step of the message background slider replaces the step before it.
    expect(
      mergePatches({ chat: { enabled: true, backgroundOpacity: 60 } }, { chat: { backgroundOpacity: 55 } }),
    ).toEqual({
      chat: { enabled: true, backgroundOpacity: 55 },
    });
    expect(mergePatches({}, { characters: { enabled: true } })).toEqual({ characters: { enabled: true } });
    expect(mergePatches({}, {})).toEqual({});
    expect(isEmptyPatch({})).toBe(true);
    expect(isEmptyPatch({ chat: {}, cells: { vertical: {} } })).toBe(true);
    expect(isEmptyPatch({ chat: { enabled: true } })).toBe(false);
    expect(isEmptyPatch({ orientation: "horizontal" })).toBe(false);
    expect(isEmptyPatch({ cells: { vertical: { content: null } } })).toBe(false);
  });

  it("drops the sent fields that still hold the sent value and keeps later edits", () => {
    const sent: LayersPatch = {
      orientation: "vertical",
      chat: { enabled: true, hideCommands: false },
      characters: { enabled: true },
      cells: { horizontal: { chat: cell, content: null } },
    };
    expect(withoutSent(sent, sent)).toEqual({});
    const later: LayersPatch = {
      orientation: "horizontal",
      chat: { enabled: true, hideCommands: true },
      characters: { enabled: false },
      cells: { horizontal: { chat: { ...cell, c: 9 }, content: null }, vertical: { content: cell } },
    };
    expect(withoutSent(later, sent)).toEqual({
      orientation: "horizontal",
      chat: { hideCommands: true },
      characters: { enabled: false },
      cells: { horizontal: { chat: { ...cell, c: 9 } }, vertical: { content: cell } },
    });
    expect(withoutSent({ chat: { hideCommands: true } }, {})).toEqual({ chat: { hideCommands: true } });
    const faint: LayersPatch = { chat: { backgroundOpacity: 20 } };
    expect(withoutSent(faint, faint)).toEqual({});
    expect(withoutSent({ chat: { backgroundOpacity: 15 } }, faint)).toEqual({ chat: { backgroundOpacity: 15 } });
    expect(withoutSent({}, sent)).toEqual({});
    // The draft itself does not change.
    expect(later.cells?.horizontal?.content).toBeNull();
  });

  it("drops a field edited back to its in-flight value, and the unsent patch still saves that value", () => {
    const inFlight: LayersPatch = { cells: { horizontal: { chat: cell } } };
    // While the request runs, the field is edited away and back.
    let draft: LayersPatch = mergePatches(inFlight, { cells: { horizontal: { chat: { ...cell, c: 9 } } } });
    let unsent: LayersPatch = { cells: { horizontal: { chat: { ...cell, c: 9 } } } };
    draft = mergePatches(draft, { cells: { horizontal: { chat: { ...cell } } } });
    unsent = mergePatches(unsent, { cells: { horizontal: { chat: { ...cell } } } });
    expect(draft).toEqual(inFlight);
    // The answer leaves no draft for the field: it shows the saved value. The next request sends it again.
    expect(withoutSent(draft, inFlight)).toEqual({});
    expect(layersAction(unsent, write)).toEqual({ action: "layers", write, cells: { horizontal: { chat: cell } } });
  });

  it("builds a request with only the patch fields, the write order and copied cells", () => {
    const patch: LayersPatch = { cells: { vertical: { characters: cell } }, chat: { enabled: true } };
    const action = layersAction(patch, write);
    expect(action).toEqual({
      action: "layers",
      write,
      chat: { enabled: true },
      cells: { vertical: { characters: cell } },
    });
    expect(action.cells?.vertical?.characters).not.toBe(cell);
    expect(action.write).not.toBe(write);
    expect(layersAction({}, write)).toEqual({ action: "layers", write });
  });
});

describe("resize by a handle", () => {
  // A content cell in the middle of the horizontal grid: columns 5 to 10, rows 2 to 5.
  const box: CellRect = { c: 5, r: 2, w: 6, h: 4 };

  it("moves only the edges of each handle to the grid lines of the pointer", () => {
    // One column in from the left and the right, one row in from the top and the bottom.
    const to: Readonly<Record<"x" | "y", Readonly<Record<-1 | 1, number>>>> = {
      x: { [-1]: 6, 1: 10 },
      y: { [-1]: 3, 1: 5 },
    };
    const expected: Readonly<Record<ResizeHandle, CellRect>> = {
      nw: { c: 6, r: 3, w: 5, h: 3 },
      n: { c: 5, r: 3, w: 6, h: 3 },
      ne: { c: 5, r: 3, w: 5, h: 3 },
      e: { c: 5, r: 2, w: 5, h: 4 },
      se: { c: 5, r: 2, w: 5, h: 3 },
      s: { c: 5, r: 2, w: 6, h: 3 },
      sw: { c: 6, r: 2, w: 5, h: 3 },
      w: { c: 6, r: 2, w: 5, h: 4 },
    };
    for (const handle of RESIZE_HANDLES) {
      const line: Cell = { c: to.x[handle.includes("w") ? -1 : 1], r: to.y[handle.includes("n") ? -1 : 1] };
      expect(resizeCell("horizontal", "content", box, handle, line), handle).toEqual({
        rect: expected[handle],
        min: false,
      });
    }
  });

  it("starts each handle on its own grid lines, so a press without a move changes nothing", () => {
    expect(handleLines(box, "nw")).toEqual({ c: 5, r: 2 });
    expect(handleLines(box, "se")).toEqual({ c: 11, r: 6 });
    expect(handleLines(box, "ne")).toEqual({ c: 11, r: 2 });
    for (const handle of RESIZE_HANDLES)
      expect(resizeCell("horizontal", "content", box, handle, handleLines(box, handle)), handle).toEqual({
        rect: box,
        min: false,
      });
  });

  it("grows a layer in each direction", () => {
    expect(resizeCell("horizontal", "content", box, "se", { c: 14, r: 8 }).rect).toEqual({ c: 5, r: 2, w: 9, h: 6 });
    expect(resizeCell("horizontal", "content", box, "nw", { c: 2, r: 1 }).rect).toEqual({ c: 2, r: 1, w: 9, h: 5 });
    expect(resizeCell("horizontal", "content", box, "n", { c: 0, r: 0 }).rect).toEqual({ c: 5, r: 0, w: 6, h: 6 });
    expect(resizeCell("horizontal", "content", box, "w", { c: 0, r: 0 }).rect).toEqual({ c: 0, r: 2, w: 11, h: 4 });
  });

  it("stops at the minimum size of the layer and says so", () => {
    for (const layer of EDITOR_LAYERS) {
      const least = MIN_CELLS[layer];
      const wide: CellRect = { c: 2, r: 2, w: 8, h: 5 };
      // The bottom-right corner goes past the top-left corner: the top-left corner stays.
      expect(resizeCell("horizontal", layer, wide, "se", { c: 0, r: 0 }), layer).toEqual({
        rect: { c: 2, r: 2, w: least.w, h: least.h },
        min: true,
      });
      // The top-left corner goes past the bottom-right corner: the bottom-right corner stays.
      expect(resizeCell("horizontal", layer, wide, "nw", { c: 16, r: 9 }), layer).toEqual({
        rect: { c: 10 - least.w, r: 7 - least.h, w: least.w, h: least.h },
        min: true,
      });
    }
    // Exactly the minimum is not below it.
    expect(resizeCell("horizontal", "content", box, "e", { c: 9, r: 0 })).toEqual({
      rect: { c: 5, r: 2, w: 4, h: 4 },
      min: false,
    });
    expect(resizeCell("horizontal", "content", box, "e", { c: 8, r: 0 }).min).toBe(true);
    expect(resizeCell("horizontal", "content", box, "s", { c: 0, r: 3 }).min).toBe(true);
  });

  it("stops at the edges of the grid in both orientations", () => {
    expect(resizeCell("horizontal", "content", box, "se", { c: 40, r: 40 })).toEqual({
      rect: { c: 5, r: 2, w: 11, h: 7 },
      min: false,
    });
    expect(resizeCell("horizontal", "content", box, "nw", { c: -3, r: -3 })).toEqual({
      rect: { c: 0, r: 0, w: 11, h: 6 },
      min: false,
    });
    const tall: CellRect = { c: 2, r: 4, w: 4, h: 3 };
    expect(resizeCell("vertical", "content", tall, "se", { c: 40, r: 40 }).rect).toEqual({ c: 2, r: 4, w: 7, h: 12 });
    for (const handle of RESIZE_HANDLES)
      for (const to of [
        { c: -9, r: -9 },
        { c: 99, r: 99 },
        { c: 99, r: -9 },
      ])
        expect(
          placeProblem(
            "vertical",
            { ...DEFAULT_LAYERS.cells.vertical, chat: tall },
            "content",
            resizeCell("vertical", "content", tall, handle, to).rect,
          )?.kind,
          handle,
        ).not.toBe("outside");
  });

  it("leaves the overlap rule to placeProblem, which refuses a resize onto another layer as it refuses a move", () => {
    const cells: LayerCells = DEFAULT_LAYERS.cells.horizontal;
    // The chat (5 x 7 at the top-left) grows one row down, onto the characters slot.
    const down: CellRect = resizeCell("horizontal", "chat", cells.chat, "s", { c: 0, r: 8 }).rect;
    expect(down).toEqual({ c: 0, r: 0, w: 5, h: 8 });
    expect(placeProblem("horizontal", cells, "chat", down)).toEqual({ kind: "overlap", other: "characters" });
    // To the right the cells are free.
    const right: CellRect = resizeCell("horizontal", "chat", cells.chat, "e", { c: 9, r: 0 }).rect;
    expect(placeProblem("horizontal", cells, "chat", right)).toBeNull();
    // A shared edge is not an overlap.
    const content: CellRect = { c: 9, r: 0, w: 4, h: 2 };
    expect(placeProblem("horizontal", { ...cells, content }, "chat", right)).toBeNull();
    const over: CellRect = resizeCell("horizontal", "chat", cells.chat, "e", { c: 10, r: 0 }).rect;
    expect(placeProblem("horizontal", { ...cells, content }, "chat", over)).toEqual({
      kind: "overlap",
      other: "content",
    });
  });

  it("resizes by one cell from the bottom-right corner for the keyboard", () => {
    expect(growCell("horizontal", "content", box, { c: 1, r: 0 })).toEqual({ rect: { ...box, w: 7 }, min: false });
    expect(growCell("horizontal", "content", box, { c: -1, r: 0 })).toEqual({ rect: { ...box, w: 5 }, min: false });
    expect(growCell("horizontal", "content", box, { c: 0, r: 1 })).toEqual({ rect: { ...box, h: 5 }, min: false });
    expect(growCell("horizontal", "content", box, { c: 0, r: -1 })).toEqual({ rect: { ...box, h: 3 }, min: false });
    // At the minimum size a smaller step changes nothing and reports the minimum.
    const least: CellRect = { c: 5, r: 2, w: 4, h: 2 };
    expect(growCell("horizontal", "content", least, { c: -1, r: 0 })).toEqual({ rect: least, min: true });
    expect(growCell("horizontal", "content", least, { c: 0, r: -1 })).toEqual({ rect: least, min: true });
    // At the edge of the grid a larger step changes nothing and does not report the minimum.
    const edge: CellRect = { c: 10, r: 5, w: 6, h: 4 };
    expect(growCell("horizontal", "content", edge, { c: 1, r: 0 })).toEqual({ rect: edge, min: false });
    expect(growCell("horizontal", "content", edge, { c: 0, r: 1 })).toEqual({ rect: edge, min: false });
  });

  it("finds the handle under a pointer: a band along each edge, a corner where two bands meet", () => {
    const reach = { x: 0.25, y: 0.25 };
    const at = (x: number, y: number): ResizeHandle | null => handleAt(box, { x, y }, reach);
    expect(at(5, 2)).toBe("nw");
    expect(at(8, 2)).toBe("n");
    expect(at(11, 2)).toBe("ne");
    expect(at(11, 4)).toBe("e");
    expect(at(11, 6)).toBe("se");
    expect(at(8, 6)).toBe("s");
    expect(at(5, 6)).toBe("sw");
    expect(at(5, 4)).toBe("w");
    // The band reaches to both sides of the edge.
    expect(at(4.8, 4)).toBe("w");
    expect(at(5.2, 4)).toBe("w");
    expect(at(11.2, 6.2)).toBe("se");
    // The middle moves the layer, and a point away from the layer is not a handle.
    expect(at(8, 4)).toBeNull();
    expect(at(5.3, 4)).toBeNull();
    expect(at(4.7, 4)).toBeNull();
    expect(at(8, 6.3)).toBeNull();
    expect(at(11.3, 1)).toBeNull();
  });

  it("keeps the middle of a small layer free of handles when the bands are wide", () => {
    // On a phone a band can be wider than half a cell. Inside the layer it takes at most a quarter of the side.
    const small: CellRect = { c: 0, r: 0, w: 3, h: 2 };
    const reach = { x: 0.7, y: 0.7 };
    expect(handleAt(small, { x: 1.5, y: 1 }, reach)).toBeNull();
    expect(handleAt(small, { x: 1.5, y: 0.4 }, reach)).toBe("n");
    expect(handleAt(small, { x: 1.5, y: 0.6 }, reach)).toBeNull();
    expect(handleAt(small, { x: 3.6, y: 2.6 }, reach)).toBe("se");
    expect(handleAt(small, { x: 2.3, y: 1 }, reach)).toBe("e");
  });
});

describe("layer palette", () => {
  it("adds a layer at the first free place that fits its minimum size, row by row", () => {
    // The default layout: chat 5 x 7 at the top-left, characters along the bottom.
    const cells: LayerCells = DEFAULT_LAYERS.cells.horizontal;
    expect(firstFreeCell("horizontal", cells, "content")).toEqual({ c: 5, r: 0, w: 4, h: 2 });
    // A chat across the top rows moves the first place below it.
    const top: LayerCells = { ...cells, chat: { c: 0, r: 0, w: 14, h: 3 } };
    expect(firstFreeCell("horizontal", top, "content")).toEqual({ c: 0, r: 3, w: 4, h: 2 });
    // Three free columns at the right are too narrow: the place is in the first row that has four.
    const narrow: LayerCells = { ...cells, chat: { c: 0, r: 0, w: 13, h: 2 } };
    expect(firstFreeCell("horizontal", narrow, "content")).toEqual({ c: 0, r: 2, w: 4, h: 2 });
    expect(firstFreeCell("vertical", DEFAULT_LAYERS.cells.vertical, "content")).toEqual({ c: 0, r: 0, w: 4, h: 2 });
  });

  it("finds a place that passes the placement rules for each layer", () => {
    for (const layer of EDITOR_LAYERS) {
      const cells: LayerCells = { ...DEFAULT_LAYERS.cells.horizontal, content: { c: 5, r: 0, w: 4, h: 2 } };
      const rect: CellRect | null = firstFreeCell("horizontal", cells, layer);
      expect(rect && placeProblem("horizontal", cells, layer, rect), layer).toBeNull();
    }
  });

  it("gives no place when the grid is full", () => {
    const full: LayerCells = {
      ...DEFAULT_LAYERS.cells.horizontal,
      chat: { c: 0, r: 0, w: 16, h: 7 },
      characters: { c: 0, r: 7, w: 16, h: 2 },
      content: null,
    };
    expect(firstFreeCell("horizontal", full, "content")).toBeNull();
    // One free row is not enough for two rows.
    const row: LayerCells = { ...full, chat: { c: 0, r: 0, w: 16, h: 6 } };
    expect(firstFreeCell("horizontal", row, "content")).toBeNull();
  });

  it("drops a layer at its minimum size around the pointed cell, inside the grid", () => {
    const drops: readonly (readonly [EditorLayer, Cell, CellRect])[] = [
      ["content", { c: 8, r: 4 }, { c: 6, r: 3, w: 4, h: 2 }],
      ["content", { c: 0, r: 0 }, { c: 0, r: 0, w: 4, h: 2 }],
      ["content", { c: 15, r: 8 }, { c: 12, r: 7, w: 4, h: 2 }],
      ["characters", { c: 15, r: 0 }, { c: 10, r: 0, w: 6, h: 2 }],
      ["chat", { c: 1, r: 8 }, { c: 0, r: 7, w: 3, h: 2 }],
    ];
    for (const [layer, at, rect] of drops) expect(dropCell("horizontal", layer, at), layer).toEqual(rect);
    expect(dropCell("vertical", "content", { c: 8, r: 15 })).toEqual({ c: 5, r: 14, w: 4, h: 2 });
  });

  it("finds a free place of a given size", () => {
    const cells: LayerCells = DEFAULT_LAYERS.cells.horizontal;
    expect(firstFreeCell("horizontal", cells, "content", { w: 11, h: 7 })).toEqual({ c: 5, r: 0, w: 11, h: 7 });
    expect(firstFreeCell("horizontal", cells, "content", { w: 12, h: 7 })).toBeNull();
  });
});

describe("layers off the grid", () => {
  const off = (): OverlayLayers => structuredClone(DEFAULT_LAYERS);
  const allOn = (): OverlayLayers => ({
    ...off(),
    chat: { ...DEFAULT_LAYERS.chat, enabled: true },
    characters: { ...DEFAULT_LAYERS.characters, enabled: true },
  });

  it("draws a chat or characters layer only while it is on, and content only with a cell", () => {
    expect(gridCells(off(), "horizontal")).toEqual({ chat: null, characters: null, content: null });
    expect(EDITOR_LAYERS.filter((layer: EditorLayer): boolean => onGrid(off(), "horizontal", layer))).toEqual([]);
    const on: OverlayLayers = withCell(allOn(), "horizontal", "content", cell);
    const { chat, characters } = DEFAULT_LAYERS.cells.horizontal;
    expect(gridCells(on, "horizontal")).toEqual({ chat, characters, content: cell });
    expect(EDITOR_LAYERS.every((layer: EditorLayer): boolean => onGrid(on, "horizontal", layer))).toBe(true);
    // The content has a cell only in the horizontal layout. The switches apply to both orientations.
    expect(gridCells(on, "vertical")).toEqual({
      chat: DEFAULT_LAYERS.cells.vertical.chat,
      characters: DEFAULT_LAYERS.cells.vertical.characters,
      content: null,
    });
    expect(onGrid(on, "vertical", "content")).toBe(false);
  });

  it("removes chat and characters by their switch and keeps their cells, and removes the content cell", () => {
    const start: OverlayLayers = withCell(allOn(), "horizontal", "content", cell);
    const noCharacters: OverlayLayers = withRemoved(start, "horizontal", "characters");
    expect(noCharacters.characters).toEqual({ ...DEFAULT_LAYERS.characters, enabled: false });
    expect(noCharacters.cells).toEqual(start.cells);
    expect(noCharacters.chat.enabled).toBe(true);
    expect(diffLayers(start, noCharacters)).toEqual({ characters: { enabled: false } });
    expect(diffLayers(start, withRemoved(start, "horizontal", "chat"))).toEqual({ chat: { enabled: false } });
    const noContent: OverlayLayers = withRemoved(start, "horizontal", "content");
    expect(noContent.cells.horizontal.content).toBeNull();
    expect(diffLayers(start, noContent)).toEqual({ cells: { horizontal: { content: null } } });
    expect(start.characters.enabled).toBe(true);
  });

  it("puts a layer back on the grid at a cell and turns it on", () => {
    const rect: CellRect = { c: 8, r: 0, w: 3, h: 2 };
    const placed: OverlayLayers | null = withPlaced(off(), "horizontal", "chat", rect);
    expect(placed?.chat.enabled).toBe(true);
    expect(placed?.characters.enabled).toBe(false);
    expect(placed?.cells.horizontal.chat).toEqual(rect);
    expect(placed?.cells.vertical).toEqual(DEFAULT_LAYERS.cells.vertical);
    expect(diffLayers(off(), placed ?? off())).toEqual({
      chat: { enabled: true },
      cells: { horizontal: { chat: rect } },
    });
    const content: OverlayLayers | null = withPlaced(off(), "horizontal", "content", cell);
    expect(content?.cells.horizontal.content).toEqual(cell);
    expect(content?.chat.enabled).toBe(false);
  });

  it("lets a layer take the stored cell of a layer that is off, and moves that cell to a free place", () => {
    // The stored characters cell is the bottom two rows. The characters are off, so the grid shows that area free.
    const rect: CellRect = { c: 0, r: 7, w: 4, h: 2 };
    expect(layoutProblem(off(), "horizontal", "content", rect)).toBeNull();
    const placed: OverlayLayers | null = withPlaced(off(), "horizontal", "content", rect);
    expect(placed?.cells.horizontal.content).toEqual(rect);
    // No room for 16 x 2 cells now: the stored cell takes the first free place at the minimum size.
    expect(placed?.cells.horizontal.characters).toEqual({ c: 5, r: 0, w: 6, h: 2 });
    expect(placed?.characters.enabled).toBe(false);
    expect(placed ? overlappingPair(placed.cells.horizontal) : "none").toBeNull();
    // A stored cell keeps its size when that size has a free place.
    const low: OverlayLayers = withCell(off(), "horizontal", "chat", { c: 0, r: 0, w: 5, h: 3 });
    const moved: OverlayLayers | null = withPlaced(low, "horizontal", "content", { c: 0, r: 0, w: 4, h: 2 });
    expect(moved?.cells.horizontal.chat).toEqual({ c: 4, r: 0, w: 5, h: 3 });
    // A layer on the grid stays in the way.
    expect(layoutProblem(allOn(), "horizontal", "content", rect)).toEqual({ kind: "overlap", other: "characters" });
    expect(withPlaced(allOn(), "horizontal", "content", rect)).toBeNull();
    expect(withPlaced(off(), "horizontal", "content", { c: 14, r: 0, w: 4, h: 2 })).toBeNull();
  });

  it("refuses a cell that leaves no free place for the stored cell of a layer that is off", () => {
    // Chat fills the top seven rows. The characters are off, with their stored cell in the bottom two rows.
    const tall: OverlayLayers = withCell(allOn(), "horizontal", "chat", { c: 0, r: 0, w: 16, h: 7 });
    const start: OverlayLayers = withRemoved(tall, "horizontal", "characters");
    const rect: CellRect = { c: 0, r: 7, w: 16, h: 2 };
    expect(layoutProblem(start, "horizontal", "content", rect)).toEqual({ kind: "noRoom", other: "characters" });
    expect(withPlaced(start, "horizontal", "content", rect)).toBeNull();
    // Ten columns leave the minimum characters cell (6 x 2) free beside the content.
    const narrow: OverlayLayers | null = withPlaced(start, "horizontal", "content", { ...rect, w: 10 });
    expect(narrow?.cells.horizontal.characters).toEqual({ c: 10, r: 7, w: 6, h: 2 });
  });
});
