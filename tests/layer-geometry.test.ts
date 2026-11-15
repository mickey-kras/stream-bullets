import { describe, expect, it } from "vitest";
import {
  diffLayers,
  isEmptyPatch,
  layerAt,
  layersAction,
  mergePatches,
  moveCell,
  placeProblem,
  spanCells,
  withCell,
  withoutSent,
} from "../app/lib/layer-geometry";
import { DEFAULT_LAYERS, type CellRect, type LayersPatch, type OverlayLayers } from "../app/lib/overlay-layers";

const write = { writer: "editor-1234", seq: 1 };
const cell: CellRect = { c: 10, r: 0, w: 6, h: 4 };

function layers(): OverlayLayers {
  return structuredClone({ ...DEFAULT_LAYERS, chat: { enabled: true, hideCommands: true } });
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
      chat: { enabled: false, hideCommands: false },
      characters: { enabled: true },
      cells: {
        horizontal: { ...before.cells.horizontal, chat: cell, content: { c: 5, r: 0, w: 4, h: 2 } },
        vertical: before.cells.vertical,
      },
    };
    expect(diffLayers(before, after)).toEqual({
      orientation: "vertical",
      chat: { enabled: false, hideCommands: false },
      characters: { enabled: true },
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
