import { describe, expect, it } from "vitest";
import {
  clampRect,
  diffLayers,
  isEmptyPatch,
  layersAction,
  mergePatches,
  moveRect,
  resizeRect,
  sameRect,
  setRectField,
  withoutSent,
  withRect,
} from "../app/lib/layer-geometry";
import type { LayersPatch, OverlayLayers } from "../app/lib/overlay-layers";

const MIN = { w: 280, h: 160 };

function layers(): OverlayLayers {
  return {
    chat: { enabled: true, rect: { x: 100, y: 100, w: 400, h: 600 }, hideCommands: true },
    characters: { enabled: false, rect: { x: 0, y: 760, w: 1920, h: 320 } },
  };
}

describe("rect geometry", () => {
  it("clamps a rect into the frame in whole pixels, moving a too-wide rect left", () => {
    expect(clampRect({ x: 10.4, y: 20.6, w: 300.2, h: 200.7 }, MIN)).toEqual({ x: 10, y: 21, w: 300, h: 201 });
    expect(clampRect({ x: 1800, y: 1000, w: 400, h: 300 }, MIN)).toEqual({ x: 1520, y: 780, w: 400, h: 300 });
    expect(clampRect({ x: -5, y: -5, w: 10, h: 10 }, MIN)).toEqual({ x: 0, y: 0, w: 280, h: 160 });
    expect(clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, MIN)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it("moves a rect and keeps its size inside the frame", () => {
    const rect = { x: 100, y: 100, w: 400, h: 600 };
    expect(moveRect(rect, 10, -20)).toEqual({ x: 110, y: 80, w: 400, h: 600 });
    expect(moveRect(rect, 5000, 5000)).toEqual({ x: 1520, y: 480, w: 400, h: 600 });
  });

  it("resizes from the bottom-right corner within the frame and the minimum", () => {
    const rect = { x: 100, y: 100, w: 400, h: 600 };
    expect(resizeRect(rect, 20.4, -30, MIN)).toEqual({ x: 100, y: 100, w: 420, h: 570 });
    expect(resizeRect(rect, -1000, -1000, MIN)).toEqual({ x: 100, y: 100, w: 280, h: 160 });
    expect(resizeRect(rect, 5000, 5000, MIN)).toEqual({ x: 100, y: 100, w: 1820, h: 980 });
  });

  it("sets one field and keeps the rect in the frame", () => {
    const rect = { x: 1500, y: 100, w: 400, h: 600 };
    expect(setRectField(rect, "y", 50, MIN)).toEqual({ x: 1500, y: 50, w: 400, h: 600 });
    expect(setRectField(rect, "w", 1000, MIN)).toEqual({ x: 920, y: 100, w: 1000, h: 600 });
  });

  it("compares rects by value and replaces one layer's rect", () => {
    expect(sameRect({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 4 })).toBe(true);
    expect(sameRect({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 5 })).toBe(false);
    const rect = { x: 0, y: 0, w: 640, h: 200 };
    expect(withRect(layers(), "chat", rect).chat).toEqual({ ...layers().chat, rect });
    expect(withRect(layers(), "characters", rect).characters).toEqual({ ...layers().characters, rect });
    expect(withRect(layers(), "characters", rect).chat).toEqual(layers().chat);
  });
});

describe("field-level patches", () => {
  it("diffs only the changed fields", () => {
    const before = layers();
    expect(diffLayers(before, layers())).toEqual({});
    const after: OverlayLayers = {
      chat: { enabled: false, rect: { x: 1, y: 2, w: 300, h: 200 }, hideCommands: false },
      characters: { enabled: true, rect: { x: 0, y: 0, w: 640, h: 160 } },
    };
    expect(diffLayers(before, after)).toEqual(after);
    expect(diffLayers(before, { ...before, chat: { ...before.chat, hideCommands: false } })).toEqual({
      chat: { hideCommands: false },
    });
  });

  it("merges patches with the newer field winning, and checks emptiness", () => {
    const merged = mergePatches({ chat: { enabled: true, hideCommands: true } }, { chat: { enabled: false } });
    expect(merged).toEqual({ chat: { enabled: false, hideCommands: true } });
    expect(mergePatches({}, { characters: { enabled: true } })).toEqual({ characters: { enabled: true } });
    expect(mergePatches({}, {})).toEqual({});
    expect(isEmptyPatch({})).toBe(true);
    expect(isEmptyPatch({ chat: { enabled: true } })).toBe(false);
    expect(isEmptyPatch({ characters: { enabled: true } })).toBe(false);
  });

  it("drops the sent fields that still hold the sent value and keeps later edits", () => {
    const rect = { x: 1, y: 2, w: 300, h: 200 };
    const sent = { chat: { enabled: true, rect, hideCommands: false }, characters: { enabled: true, rect } };
    expect(withoutSent(sent, sent)).toEqual({});
    const later = {
      chat: { enabled: true, rect: { ...rect, x: 9 }, hideCommands: false },
      characters: { enabled: false, rect },
    };
    expect(withoutSent(later, sent)).toEqual({ chat: { rect: { ...rect, x: 9 } }, characters: { enabled: false } });
    expect(withoutSent({ chat: { hideCommands: true } }, {})).toEqual({ chat: { hideCommands: true } });
    expect(withoutSent({}, sent)).toEqual({});
  });

  it("drops a field edited back to its in-flight value, and the unsent patch still saves that value", () => {
    const rect = { x: 1, y: 2, w: 300, h: 200 };
    const inFlight = { chat: { rect } };
    // While the request runs, the field is edited away and back.
    let draft: LayersPatch = mergePatches(inFlight, { chat: { rect: { ...rect, x: 9 } } });
    let unsent: LayersPatch = { chat: { rect: { ...rect, x: 9 } } };
    draft = mergePatches(draft, { chat: { rect: { ...rect } } });
    unsent = mergePatches(unsent, { chat: { rect: { ...rect } } });
    expect(draft).toEqual(inFlight);
    // The answer leaves no draft for the field: it shows the saved value. The next request sends it again.
    expect(withoutSent(draft, inFlight)).toEqual({});
    expect(layersAction(unsent)).toEqual({ action: "layers", chat: { rect } });
  });

  it("builds a request with only the patch fields and copies rects", () => {
    const rect = { x: 1, y: 2, w: 300, h: 200 };
    const action = layersAction({ chat: { rect }, characters: { rect } });
    expect(action).toEqual({ action: "layers", chat: { rect }, characters: { rect } });
    expect(action.chat?.rect).not.toBe(rect);
    expect(action.characters?.rect).not.toBe(rect);
    expect(layersAction({ chat: { enabled: true }, characters: { enabled: false } })).toEqual({
      action: "layers",
      chat: { enabled: true },
      characters: { enabled: false },
    });
    expect(layersAction({})).toEqual({ action: "layers" });
  });
});
