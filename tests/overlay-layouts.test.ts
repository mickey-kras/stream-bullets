import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYERS,
  GRID_LAYERS,
  cellFits,
  emptyCells,
  layerEnabled,
  overlappingPair,
  type CellRect,
  type LayerCells,
  type Orientation,
  type OverlayLayers,
} from "../app/lib/overlay-layers";
import {
  EMPTY_LAYOUTS,
  LAYOUT_LIMIT,
  LAYOUT_PRESETS,
  LayoutError,
  PRESET_KEYS,
  STORED_LAYOUTS_LENGTH,
  UNSAVED_LAYOUT,
  createLayout,
  deleteLayout,
  layoutChoices,
  layoutNameSchema,
  outputPresets,
  parseStoredLayouts,
  presetCells,
  presetId,
  presetOf,
  renameLayout,
  resetLayout,
  selectLayout,
  storedLayoutsText,
  type LayoutChoice,
  type LayoutProblem,
  type LayoutState,
  type OverlayLayouts,
  type SavedLayout,
} from "../app/lib/overlay-layouts";

// Pure rules for the layouts of the overlay: the presets, the list, and each action.

const chatCell: CellRect = { c: 0, r: 0, w: 10, h: 14 };
const pollCell: CellRect = { c: 10, r: 0, w: 22, h: 14 };
const keep = { id: "kept", name: "My layout" };

/** The chat and the poll on the horizontal grid, the chat on stream, and no saved layout. */
const start: LayoutState = {
  layouts: EMPTY_LAYOUTS,
  layers: {
    ...DEFAULT_LAYERS,
    chat: { ...DEFAULT_LAYERS.chat, enabled: true },
    cells: { horizontal: { ...emptyCells(), chat: chatCell, poll: pollCell }, vertical: emptyCells() },
  },
};

function problem(action: () => unknown): LayoutProblem | null {
  try {
    action();
    return null;
  } catch (error: unknown) {
    if (error instanceof LayoutError) return error.problem;
    throw error;
  }
}

const ids = (state: LayoutState, output: Orientation = "horizontal"): string[] =>
  state.layouts[output].saved.map((layout: SavedLayout): string => layout.id);

describe("presets", (): void => {
  it("has two presets for the horizontal output and one for the vertical output", (): void => {
    expect(outputPresets("horizontal")).toEqual(["chatting", "gameplay"]);
    expect(outputPresets("vertical")).toEqual(["vertical"]);
    for (const key of PRESET_KEYS) expect(presetOf(presetId(key))).toBe(key);
    expect(presetOf("kept")).toBeNull();
  });

  it("places each layer inside its grid, at a valid size, and over no other layer", (): void => {
    for (const key of PRESET_KEYS) {
      const { output } = LAYOUT_PRESETS[key];
      const cells: LayerCells = presetCells(key);
      expect(overlappingPair(cells), key).toBeNull();
      for (const layer of GRID_LAYERS) {
        const rect: CellRect | null = cells[layer];
        if (rect) expect(cellFits(output, layer, rect), `${key} ${layer}`).toBe(true);
      }
      // Each preset places the camera frame, as the camera frame issue asks.
      expect(cells.camera, key).not.toBeNull();
    }
  });
});

describe("the list of layouts", (): void => {
  it("shows the presets and the layout on stream that is not saved yet", (): void => {
    const list: LayoutChoice[] = layoutChoices(start.layouts, start.layers, "horizontal");
    expect(list).toEqual([
      { id: "preset:chatting", preset: "chatting", name: "", changed: false, active: false },
      { id: "preset:gameplay", preset: "gameplay", name: "", changed: false, active: false },
      { id: UNSAVED_LAYOUT, preset: null, name: "", changed: false, active: true },
    ]);
    expect(layoutChoices(start.layouts, start.layers, "vertical").map((item: LayoutChoice): string => item.id)).toEqual(
      ["preset:vertical", UNSAVED_LAYOUT],
    );
  });

  it("marks the layout on stream, and a preset that the streamer changed", (): void => {
    const picked: LayoutState = selectLayout(start, "horizontal", "preset:gameplay", keep);
    const list: LayoutChoice[] = layoutChoices(picked.layouts, picked.layers, "horizontal");
    expect(list).toEqual([
      { id: "preset:chatting", preset: "chatting", name: "", changed: false, active: false },
      { id: "preset:gameplay", preset: "gameplay", name: "", changed: false, active: true },
      { id: "kept", preset: null, name: "My layout", changed: false, active: false },
    ]);
    // An edit of the grid changes the preset on stream: the list reads the cells of the grid.
    const moved: OverlayLayers = {
      ...picked.layers,
      cells: { ...picked.layers.cells, horizontal: { ...picked.layers.cells.horizontal, poll: null } },
    };
    expect(layoutChoices(picked.layouts, moved, "horizontal")[1]).toMatchObject({ changed: true, active: true });
    // After a different layout goes on stream, the changed preset keeps the version of the streamer.
    const away: LayoutState = selectLayout({ layouts: picked.layouts, layers: moved }, "horizontal", "kept", keep);
    expect(layoutChoices(away.layouts, away.layers, "horizontal")[1]).toMatchObject({ changed: true, active: false });
  });
});

describe("select a layout", (): void => {
  it("keeps the layout on stream as the first layout of the streamer, and puts the preset on stream", (): void => {
    const picked: LayoutState = selectLayout(start, "horizontal", "preset:chatting", keep);
    expect(picked.layouts.horizontal.active).toBe("preset:chatting");
    expect(picked.layouts.horizontal.saved).toEqual([
      { id: "kept", name: "My layout", cells: start.layers.cells.horizontal },
      { id: "preset:chatting", name: "", cells: presetCells("chatting") },
    ]);
    expect(picked.layers.cells.horizontal).toEqual(presetCells("chatting"));
    // The other output and its layouts do not change.
    expect(picked.layers.cells.vertical).toBe(start.layers.cells.vertical);
    expect(picked.layouts.vertical).toBe(start.layouts.vertical);
  });

  it("shows a layer that the layout adds to the grid, and leaves the switch of each other layer", (): void => {
    const hidden: LayoutState = {
      ...start,
      layers: {
        ...start.layers,
        items: { ...start.layers.items, poll: { ...start.layers.items.poll, enabled: false } },
      },
    };
    const picked: LayoutState = selectLayout(hidden, "horizontal", "preset:chatting", keep);
    // The camera frame and the message banner were off the grid: they go on stream.
    expect(layerEnabled(picked.layers, "camera")).toBe(true);
    expect(layerEnabled(picked.layers, "message")).toBe(true);
    // The poll was on the grid and off stream: it stays off stream.
    expect(layerEnabled(picked.layers, "poll")).toBe(false);
    // The characters are not in this preset: their switch stays.
    expect(layerEnabled(picked.layers, "characters")).toBe(false);
  });

  it("returns to a layout of the streamer with the cells that it had", (): void => {
    const picked: LayoutState = selectLayout(start, "horizontal", "preset:gameplay", keep);
    const back: LayoutState = selectLayout(picked, "horizontal", "kept", keep);
    expect(back.layouts.horizontal.active).toBe("kept");
    expect(back.layers.cells.horizontal).toEqual(start.layers.cells.horizontal);
    // No second copy of a layout.
    expect(ids(back)).toEqual(["kept", "preset:gameplay"]);
    // The layout on stream again changes nothing.
    expect(selectLayout(back, "horizontal", "kept", keep)).toBe(back);
  });

  it("saves no layout for an empty grid", (): void => {
    const empty: LayoutState = { layouts: EMPTY_LAYOUTS, layers: DEFAULT_LAYERS };
    expect(ids(selectLayout(empty, "vertical", "preset:vertical", keep), "vertical")).toEqual(["preset:vertical"]);
  });

  it("refuses an unknown layout and a preset of the other output", (): void => {
    expect(problem(() => selectLayout(start, "horizontal", "nothing", keep))).toBe("unknown");
    expect(problem(() => selectLayout(start, "horizontal", "preset:vertical", keep))).toBe("unknown");
    expect(problem(() => selectLayout(start, "vertical", "preset:gameplay", keep))).toBe("unknown");
  });
});

describe("make, rename, delete and reset", (): void => {
  const made = { id: "made", name: "Raid night" };

  it("makes a copy of the layout on stream, or an empty layout, and puts it on stream", (): void => {
    const copy: LayoutState = createLayout(start, "horizontal", made, "current", keep);
    expect(copy.layouts.horizontal.active).toBe("made");
    expect(ids(copy)).toEqual(["kept", "made"]);
    expect(copy.layers.cells.horizontal).toEqual(start.layers.cells.horizontal);
    const empty: LayoutState = createLayout(start, "horizontal", made, "empty", keep);
    expect(empty.layers.cells.horizontal).toEqual(emptyCells());
    expect(empty.layouts.horizontal.saved[0]).toEqual({ ...keep, cells: start.layers.cells.horizontal });
  });

  it("stops at the limit of saved layouts, and does not count the presets", (): void => {
    let state: LayoutState = selectLayout(start, "horizontal", "preset:gameplay", keep);
    for (let index = 1; index < LAYOUT_LIMIT; index += 1)
      state = createLayout(state, "horizontal", { id: `l${index}`, name: `Layout ${index}` }, "current", keep);
    expect(ids(state)).toHaveLength(LAYOUT_LIMIT + 1);
    expect(problem(() => createLayout(state, "horizontal", made, "empty", keep))).toBe("limit");
    // The other output has its own limit.
    expect(problem(() => createLayout(state, "vertical", made, "empty", keep))).toBeNull();
    // All layouts of the two outputs at full size fit the stored text.
    const full: SavedLayout[] = Array.from(
      { length: LAYOUT_LIMIT + 2 },
      (_, index: number): SavedLayout => ({
        id: `00000000-0000-4000-8000-00000000000${index}`,
        name: "N".repeat(40),
        cells: { ...presetCells("chatting"), characters: { c: 13, r: 13, w: 12, h: 1 }, topic: chatCell },
      }),
    );
    const layouts: OverlayLayouts = {
      horizontal: { active: null, saved: full },
      vertical: { active: null, saved: full },
    };
    expect(storedLayoutsText(layouts).length).toBeLessThan(STORED_LAYOUTS_LENGTH);
  });

  it("gives a layout of the streamer a new name, and refuses a preset and an unknown layout", (): void => {
    const picked: LayoutState = selectLayout(start, "horizontal", "preset:gameplay", keep);
    const renamed: OverlayLayouts = renameLayout(picked.layouts, "horizontal", "kept", "Cozy");
    expect(renamed.horizontal.saved[0]).toMatchObject({ id: "kept", name: "Cozy" });
    expect(problem(() => renameLayout(picked.layouts, "horizontal", "preset:gameplay", "Mine"))).toBe("preset");
    expect(problem(() => renameLayout(picked.layouts, "horizontal", "nothing", "Mine"))).toBe("unknown");
    expect(problem(() => renameLayout(picked.layouts, "vertical", "kept", "Mine"))).toBe("unknown");
  });

  it("deletes a layout that is not on stream, and never the layout on stream", (): void => {
    const picked: LayoutState = selectLayout(start, "horizontal", "preset:gameplay", keep);
    expect(problem(() => deleteLayout(picked.layouts, "horizontal", "preset:gameplay"))).toBe("active");
    expect(problem(() => deleteLayout(picked.layouts, "horizontal", "nothing"))).toBe("unknown");
    expect(deleteLayout(picked.layouts, "horizontal", "kept").horizontal.saved.map((item) => item.id)).toEqual([
      "preset:gameplay",
    ]);
    // The version of the streamer of a preset goes, and the preset stays in the list as it comes.
    const back: LayoutState = selectLayout(picked, "horizontal", "kept", keep);
    const gone: OverlayLayouts = deleteLayout(back.layouts, "horizontal", "preset:gameplay");
    expect(layoutChoices(gone, back.layers, "horizontal")[1]).toEqual({
      id: "preset:gameplay",
      preset: "gameplay",
      name: "",
      changed: false,
      active: false,
    });
  });

  it("brings the preset on stream back, and refuses when the layout on stream is not a preset", (): void => {
    expect(problem(() => resetLayout(start, "horizontal"))).toBe("not_preset");
    const picked: LayoutState = selectLayout(start, "horizontal", "preset:gameplay", keep);
    const moved: LayoutState = {
      layouts: picked.layouts,
      layers: { ...picked.layers, cells: { ...picked.layers.cells, horizontal: { ...emptyCells(), chat: chatCell } } },
    };
    const reset: LayoutState = resetLayout(moved, "horizontal");
    expect(reset.layers.cells.horizontal).toEqual(presetCells("gameplay"));
    expect(layoutChoices(reset.layouts, reset.layers, "horizontal")[1]).toMatchObject({ changed: false, active: true });
    const own: LayoutState = selectLayout(picked, "horizontal", "kept", keep);
    expect(problem(() => resetLayout(own, "horizontal"))).toBe("not_preset");
  });
});

describe("stored layouts", (): void => {
  it("reads what it stores, and stores only the layers on the grid", (): void => {
    const picked: LayoutState = selectLayout(start, "horizontal", "preset:gameplay", keep);
    const text: string = storedLayoutsText(picked.layouts);
    expect(parseStoredLayouts(text)).toEqual(picked.layouts);
    const stored = JSON.parse(text) as { horizontal: { saved: { cells: unknown }[] } };
    expect(stored.horizontal.saved[0].cells).toEqual({ chat: chatCell, poll: pollCell });
    expect(parseStoredLayouts("{}")).toEqual(EMPTY_LAYOUTS);
  });

  it("reads a value that is not valid as no layouts, and keeps the valid layouts", (): void => {
    for (const raw of ["", "not json", "[]", "null", '{"horizontal":5}', '{"horizontal":{"saved":"x"}}'])
      expect(parseStoredLayouts(raw), raw).toEqual(EMPTY_LAYOUTS);
    const mixed: string = JSON.stringify({
      horizontal: {
        active: "gone",
        saved: [
          { id: "a", name: "A", cells: { chat: chatCell, poll: { c: 5, r: 0, w: 8, h: 4 }, topic: "no" } },
          { id: "a", name: "Again", cells: {} },
          { id: "", name: "No ID", cells: {} },
          { name: "No ID" },
          "text",
          { id: "b", name: 5, cells: null },
        ],
      },
    });
    const read: OverlayLayouts = parseStoredLayouts(mixed);
    // An ID that is not in the list is not the layout on stream.
    expect(read.horizontal.active).toBeNull();
    expect(read.horizontal.saved).toEqual([
      // The poll is over the chat: it reads as off the grid.
      { id: "a", name: "A", cells: { ...emptyCells(), chat: chatCell } },
      { id: "b", name: "", cells: emptyCells() },
    ]);
    expect(read.vertical).toEqual({ active: null, saved: [] });
  });

  it("takes a name of one line, 1 to 40 characters, without spaces at its ends", (): void => {
    expect(layoutNameSchema.parse("  Raid night  ")).toBe("Raid night");
    expect(layoutNameSchema.parse("N".repeat(40))).toHaveLength(40);
    for (const name of ["", "   ", "N".repeat(41), "two\nlines", "tab\there", 5, null])
      expect(layoutNameSchema.safeParse(name).success, String(name)).toBe(false);
  });
});
