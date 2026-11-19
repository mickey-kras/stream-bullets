import {
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { t, type MessageId } from "../../i18n";
import { SAMPLE_CHAT } from "../../lib/chat-feed";
import {
  RESIZE_HANDLES,
  dropCell,
  firstFreeCell,
  gridCells,
  growCell,
  handleAt,
  handleLines,
  layerAt,
  layoutProblem,
  moveCell,
  resizeCell,
  withCell,
  type Cell,
  type GridCells,
  type GridPoint,
  type PlaceProblem,
  type ResizeHandle,
} from "../../lib/layer-geometry";
import {
  CELL_PX,
  GRID,
  GRID_LAYERS,
  MIN_CELLS,
  cellPixels,
  type CellRect,
  type GridLayer,
  type Orientation,
  type OverlayLayers,
} from "../../lib/overlay-layers";
import type { OverlaySourceRef } from "../../types";
import type { ActivityFeed } from "./activity-feed";
import { SAMPLE_SOURCE, sampleScene } from "./editor-samples";
import { OverlayComposition, frameStyle } from "./overlay-composition";
import { showsContent, type OverlayScene } from "./overlay-stage";
import { useDesignScale } from "./use-design-scale";

export type PreviewBackground = "checker" | "game";

export const LAYER_NAMES: Readonly<Record<GridLayer, MessageId>> = {
  chat: "overlay.comp.chat",
  characters: "overlay.comp.characters",
  content: "overlay.comp.content",
};

/**
 * What a layer palette calls on the grid (see layer-palette.tsx). The pointer positions are in viewport pixels, as
 * in `clientX` and `clientY`.
 */
/** What the place that takes a layer off the grid shows during a move: a layer is carried, or it is over the place. */
export type RemoveDrop = "ready" | "over";

export interface LayoutGridHandle {
  /** Puts a layer that is off the grid at the first free place, at its minimum size. */
  add: (layer: GridLayer) => void;
  /** A layer from the palette is dragged at this point: the grid shows where it would drop. */
  dragOver: (layer: GridLayer, x: number, y: number) => void;
  /** The dragged layer is let go at this point. */
  drop: (layer: GridLayer, x: number, y: number) => void;
  /** The drag from the palette ended without a drop. */
  cancelDrop: () => void;
}

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** A resize handle takes this many screen pixels to each side of its edge: a hit area of 28 pixels. */
const HANDLE_REACH_PX = 14;

const REMOVE_KEYS: ReadonlySet<string> = new Set<string>(["Delete", "Backspace"]);

/**
 * A drag in progress. `move` carries a placed layer: `away` when the pointer is over the place that takes it off
 * the grid. `resize` moves the edges of a handle: `grab` is the pointer
 * minus the edge at the start, in cells, and `to` the grid lines the edges go to. `add` is a layer from the palette
 * over the cell `at` (null: outside the grid).
 */
type Drag =
  | { mode: "move"; layer: GridLayer; grab: Cell; at: Cell; away: boolean }
  | { mode: "resize"; layer: GridLayer; handle: ResizeHandle; grab: GridPoint; to: Cell }
  | { mode: "add"; layer: GridLayer; at: Cell | null };

const NOT_KEPT: Readonly<Record<Drag["mode"], MessageId>> = {
  move: "overlay.grid.notMoved",
  resize: "overlay.grid.notResized",
  add: "overlay.grid.notPlaced",
};
const KEPT: Readonly<Record<Drag["mode"], MessageId>> = {
  move: "overlay.grid.moved",
  resize: "overlay.grid.resized",
  add: "overlay.grid.placed",
};

/** The cell a drag would give its layer. Null for a drag that places nothing. */
function dragShape(cells: GridCells, orientation: Orientation, drag: Drag): CellRect | null {
  if (drag.mode === "add") return drag.at ? dropCell(orientation, drag.layer, drag.at) : null;
  const rect: CellRect | null = cells[drag.layer];
  if (!rect) return null;
  if (drag.mode === "move") return drag.away ? null : moveCell(orientation, rect, drag.grab, drag.at);
  return resizeCell(orientation, drag.layer, rect, drag.handle, drag.to).rect;
}

/** A resize that asks for less than the minimum size of its layer. */
function belowMinimum(cells: GridCells, orientation: Orientation, drag: Drag | null): boolean {
  const rect: CellRect | null = drag ? cells[drag.layer] : null;
  if (drag?.mode !== "resize" || !rect) return false;
  return resizeCell(orientation, drag.layer, rect, drag.handle, drag.to).min;
}

function sameRect(a: CellRect, b: CellRect): boolean {
  return a.c === b.c && a.r === b.r && a.w === b.w && a.h === b.h;
}

function name(layer: GridLayer): string {
  return t(LAYER_NAMES[layer]);
}

function smallText(layer: GridLayer): string {
  return t("overlay.grid.small", { layer: name(layer), w: MIN_CELLS[layer].w, h: MIN_CELLS[layer].h });
}

function problemText(layer: GridLayer, problem: PlaceProblem): string {
  if (problem.kind === "outside") return t("overlay.grid.outside");
  if (problem.kind === "overlap") return t("overlay.grid.touches", { layer: name(problem.other) });
  if (problem.kind === "noRoom") return t("overlay.grid.noRoom", { layer: name(problem.other) });
  return smallText(layer);
}

// "Not moved. It touches Chat." for a cell the grid does not keep.
function notKept(mode: Drag["mode"], layer: GridLayer, problem: PlaceProblem): string {
  return `${t(NOT_KEPT[mode])} ${problemText(layer, problem)}`;
}

// "Column 3, row 2: Chat." for the cell under the keyboard cursor.
function cursorText(cells: GridCells, cell: Cell): string {
  const here: GridLayer | null = layerAt(cells, cell);
  return t("overlay.grid.cursor", { c: cell.c + 1, r: cell.r + 1, what: here ? name(here) : t("overlay.grid.empty") });
}

function placeText(rect: CellRect): { c: number; r: number; w: number; h: number } {
  return { c: rect.c + 1, r: rect.r + 1, w: rect.w, h: rect.h };
}

function boxStyle(rect: CellRect): CSSProperties {
  const { x, y, w, h } = cellPixels(rect);
  return { left: x, top: y, width: w, height: h };
}

/** A pointer on the grid: its point in cells, the reach of a resize handle in cells, and whether it is on the grid. */
interface GridHit {
  point: GridPoint;
  reach: GridPoint;
  inside: boolean;
}

function inBox(box: DOMRect | undefined, x: number, y: number): boolean {
  return box !== undefined && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

function gridHit(box: DOMRect, x: number, y: number, cols: number, rows: number): GridHit {
  return {
    point: { x: ((x - box.left) / box.width) * cols, y: ((y - box.top) / box.height) * rows },
    reach: { x: (HANDLE_REACH_PX / box.width) * cols, y: (HANDLE_REACH_PX / box.height) * rows },
    inside: inBox(box, x, y),
  };
}

/** What the remove place shows for a drag: only a move carries a layer there. */
function removeDrop(drag: Drag | null): RemoveDrop | null {
  if (drag?.mode !== "move") return null;
  return drag.away ? "over" : "ready";
}

/**
 * The layout grid of the selected orientation over a live preview of the composition. Pointer (mouse, touch or pen):
 * press a placed layer to select it and drag it to move it. The selected layer shows eight resize handles, on its
 * corners and edges: drag one to resize the layer in whole cells. The layer and its content follow the new size
 * during the drag. Keyboard (the grid is one native button inside an element with role "application", so screen
 * readers pass the keys through): arrow keys move a cursor, Space or Enter picks up and puts down a layer, Shift +
 * arrow moves the selected layer one cell, Alt + arrow moves its bottom-right corner one cell and Escape cancels. A
 * click without a pointer (an assistive technology's activation) acts as Space. A new orientation or leaving the
 * grid ends a drag. A shape that touches another layer shows red and is not kept. A resize stops at the minimum
 * size of the layer and at the grid edge. A polite live region tells the result.
 *
 * A layer leaves the grid when a pointer drops it on `removeZone`, or by Delete or Backspace for the selected layer.
 * The grid draws only the layers on it: a chat or characters layer that is off has no box (see gridCells).
 *
 * The grid has no layer selector and no palette of its own. The parent owns the selection (`selected`, `onSelect`),
 * and a palette adds a layer through the handle in `ref` (see LayoutGridHandle).
 */
export function LayoutGrid({
  layers,
  scene,
  source,
  background,
  charactersFeed,
  selected,
  onSelect,
  onPlace,
  onRemove,
  removeZone,
  onRemoveDrop,
  ref,
}: Readonly<{
  /** The layers as shown: saved plus local edits. */
  layers: OverlayLayers;
  scene: OverlayScene;
  source: OverlaySourceRef;
  background: PreviewBackground;
  /** The owner's live characters feed, or null while the characters layer is off. */
  charactersFeed: ActivityFeed | null;
  /** The selected layer: it shows the resize handles and takes Shift + arrow and Alt + arrow. */
  selected: GridLayer;
  onSelect: (layer: GridLayer) => void;
  /** Keeps a valid cell for a layer. `when` is "idle" for Shift + arrow and Alt + arrow steps. */
  onPlace: (layer: GridLayer, rect: CellRect, when: "now" | "idle") => void;
  /** Takes a layer off the grid. */
  onRemove: (layer: GridLayer) => void;
  /** The element that takes a layer off the grid when a pointer drops the layer on it: the palette. */
  removeZone: RefObject<HTMLElement | null>;
  /** What `removeZone` shows now. Null: no pointer carries a layer. */
  onRemoveDrop: (drop: RemoveDrop | null) => void;
  ref?: Ref<LayoutGridHandle>;
}>): ReactNode {
  const orientation: Orientation = layers.orientation;
  const { cols, rows } = GRID[orientation];
  const cells: GridCells = gridCells(layers, orientation);
  const frame = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLButtonElement | null>(null);
  useDesignScale(frame, cols * CELL_PX);
  const helpId: string = useId();
  const label: string = t("overlay.grid.label", { cols, rows });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [cursor, setCursor] = useState<Cell>({ c: 0, r: 0 });
  const [focused, setFocused] = useState<boolean>(false);
  // What a press at the pointer would do: resize by a handle, or move a layer. It sets the mouse cursor.
  const [hover, setHover] = useState<ResizeHandle | "move" | null>(null);
  const [status, setStatus] = useState<{ text: string; bad: boolean }>({ text: "", bad: false });
  // The same text again gets a zero-width space at its end, so the live region changes and speaks it again.
  const say = (text: string, bad: boolean = false): void =>
    setStatus((last) => ({ text: last.text === text ? `${text}\u200b` : text, bad }));

  const clampCell = (cell: Cell): Cell => ({
    c: Math.max(0, Math.min(cols - 1, cell.c)),
    r: Math.max(0, Math.min(rows - 1, cell.r)),
  });
  // A new orientation ends a drag and brings the cursor into its grid, before a key or a pointer can use them.
  const [seen, setSeen] = useState<Orientation>(orientation);
  if (seen !== orientation) {
    setSeen(orientation);
    setDrag(null);
    setCursor(clampCell(cursor));
  }

  const cellOf = (point: GridPoint): Cell => clampCell({ c: Math.floor(point.x), r: Math.floor(point.y) });
  const hitAt = (x: number, y: number): GridHit | null => {
    const box: DOMRect | undefined = input.current?.getBoundingClientRect();
    return box && box.width > 0 && box.height > 0 ? gridHit(box, x, y, cols, rows) : null;
  };
  /** The resize handle of the selected layer under a pointer, or null. */
  const handleUnder = (hit: GridHit): ResizeHandle | null => {
    const rect: CellRect | null = cells[selected];
    return rect ? handleAt(rect, hit.point, hit.reach) : null;
  };

  /** Picks up the layer at a cell to move it, and selects it. Null for an empty cell. */
  const lift = (cell: Cell): Drag | null => {
    const hit: GridLayer | null = layerAt(cells, cell);
    const rect: CellRect | null = hit ? cells[hit] : null;
    if (!hit || !rect) return null;
    onSelect(hit);
    return { mode: "move", layer: hit, grab: { c: cell.c - rect.c, r: cell.r - rect.r }, at: cell, away: false };
  };
  /** A press on the grid: a resize by a handle of the selected layer, else a move of the layer at the pointer. */
  const press = (hit: GridHit): Drag | null => {
    const rect: CellRect | null = cells[selected];
    const handle: ResizeHandle | null = handleUnder(hit);
    if (!rect || !handle) return hit.inside ? lift(cellOf(hit.point)) : null;
    const lines: Cell = handleLines(rect, handle);
    return {
      mode: "resize",
      layer: selected,
      handle,
      grab: { x: hit.point.x - lines.c, y: hit.point.y - lines.r },
      to: lines,
    };
  };
  /** `active` with the pointer at `point`, `away` over the remove place. Null when the drag stays the same. */
  const follow = (active: Drag, point: GridPoint, away: boolean): Drag | null => {
    if (active.mode === "resize") {
      const to: Cell = { c: Math.round(point.x - active.grab.x), r: Math.round(point.y - active.grab.y) };
      return to.c === active.to.c && to.r === active.to.r ? null : { ...active, to };
    }
    const at: Cell = cellOf(point);
    const next: Drag = active.mode === "move" ? { ...active, at, away } : { ...active, at };
    const same: boolean = active.at?.c === at.c && active.at.r === at.r;
    return same && removeDrop(active) === removeDrop(next) ? null : next;
  };
  const overRemoveZone = (x: number, y: number): boolean => inBox(removeZone.current?.getBoundingClientRect(), x, y);

  /** Takes a layer off the grid and ends a drag. */
  const remove = (layer: GridLayer): void => {
    setDrag(null);
    onRemove(layer);
    say(t("overlay.grid.removed", { layer: name(layer) }));
  };

  /** Ends a drag. True when the layer has a new cell. */
  const commit = (active: Drag): boolean => {
    if (removeDrop(active) === "over") {
      remove(active.layer);
      return false;
    }
    setDrag(null);
    const rect: CellRect | null = dragShape(cells, orientation, active);
    if (!rect) {
      say(t("overlay.grid.cancelled"));
      return false;
    }
    const before: CellRect | null = cells[active.layer];
    if (before && sameRect(before, rect)) {
      // A press without a change selects the layer. Nothing is saved.
      const small: boolean = belowMinimum(cells, orientation, active);
      say(small ? smallText(active.layer) : t("overlay.grid.selected", { layer: name(active.layer) }));
      return false;
    }
    const problem: PlaceProblem | null = layoutProblem(layers, orientation, active.layer, rect);
    if (problem) {
      say(notKept(active.mode, active.layer, problem), true);
      return false;
    }
    onPlace(active.layer, rect, "now");
    say(t(KEPT[active.mode], { layer: name(active.layer), ...placeText(rect) }));
    return true;
  };

  const pointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    const hit: GridHit | null = hitAt(event.clientX, event.clientY);
    if (!hit) return;
    setCursor(cellOf(hit.point));
    setDrag(press(hit));
  };
  const pointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const hit: GridHit | null = hitAt(event.clientX, event.clientY);
    if (!hit || drag?.mode === "add") return;
    if (!drag) {
      setHover(handleUnder(hit) ?? (layerAt(cells, cellOf(hit.point)) ? "move" : null));
      return;
    }
    const next: Drag | null = follow(drag, hit.point, overRemoveZone(event.clientX, event.clientY));
    if (!next) return;
    if (next.mode === "move") setCursor(next.at);
    onRemoveDrop(removeDrop(next));
    // The minimum size shows only when a resize first reaches it.
    if (belowMinimum(cells, orientation, next) && !belowMinimum(cells, orientation, drag)) say(smallText(next.layer));
    setDrag(next);
  };
  const pointerUp = (): void => {
    onRemoveDrop(null);
    if (drag && drag.mode !== "add") commit(drag);
  };
  const pointerCancel = (): void => {
    onRemoveDrop(null);
    if (drag?.mode !== "add") setDrag(null);
  };

  // Space, Enter, or a click without a pointer: put down the drag, or pick up the layer at the cursor.
  const activate = (): void => {
    if (drag) {
      commit(drag);
      return;
    }
    const next: Drag | null = lift(cursor);
    setDrag(next);
    say(next ? t("overlay.grid.moving", { layer: name(next.layer) }) : cursorText(cells, cursor));
  };
  // A screen reader's activation sends a click with no pointer (`detail` 0). A mouse click already ran pointerUp.
  const click = (event: MouseEvent<HTMLButtonElement>): void => {
    if (event.detail === 0) activate();
  };
  const blur = (): void => {
    setFocused(false);
    if (!drag || drag.mode === "add") return;
    onRemoveDrop(null);
    setDrag(null);
    say(t("overlay.grid.cancelled"));
  };

  /** Shift + arrow moves the selected layer one cell. Alt + arrow moves its bottom-right corner one cell. */
  const step = (mode: "move" | "resize", arrow: readonly [number, number]): void => {
    const rect: CellRect | null = cells[selected];
    if (!rect) {
      say(t("overlay.grid.noCell", { layer: name(selected) }), true);
      return;
    }
    const by: Cell = { c: arrow[0], r: arrow[1] };
    const grown = growCell(orientation, selected, rect, by);
    const next: CellRect =
      mode === "move"
        ? moveCell(orientation, rect, { c: 0, r: 0 }, { c: rect.c + by.c, r: rect.r + by.r })
        : grown.rect;
    if (mode === "resize" && sameRect(rect, next)) {
      // The corner did not move: the layer is at its minimum size or at the edge of the grid.
      say(`${t("overlay.grid.notResized")} ${grown.min ? smallText(selected) : t("overlay.grid.outside")}`, true);
      return;
    }
    const problem: PlaceProblem | null = layoutProblem(layers, orientation, selected, next);
    if (problem) {
      say(notKept(mode, selected, problem), true);
      return;
    }
    onPlace(selected, next, "idle");
    say(t(KEPT[mode], { layer: name(selected), ...placeText(next) }));
  };
  const moveCursor = (arrow: readonly [number, number]): void => {
    const cell: Cell = clampCell({ c: cursor.c + arrow[0], r: cursor.r + arrow[1] });
    setCursor(cell);
    if (drag?.mode === "move") setDrag({ ...drag, at: cell });
    say(cursorText(cells, cell));
  };
  const arrowKey = (event: KeyboardEvent<HTMLButtonElement>, arrow: readonly [number, number]): void => {
    event.preventDefault();
    if (drag || !(event.altKey || event.shiftKey)) moveCursor(arrow);
    else step(event.altKey ? "resize" : "move", arrow);
  };
  // Delete or Backspace: the layer that a move carries, else the selected layer, leaves the grid.
  const removeKey = (): void => {
    const layer: GridLayer = drag?.mode === "move" ? drag.layer : selected;
    if (cells[layer]) remove(layer);
    else say(t("overlay.grid.noCell", { layer: name(layer) }), true);
  };
  const cancelKey = (): void => {
    onRemoveDrop(null);
    setDrag(null);
    say(t("overlay.grid.cancelled"));
  };
  /** The action of a key that is not an arrow, or null for a key the grid does not take. */
  const keyAction = (key: string): (() => void) | null => {
    if (key === " " || key === "Enter") return activate;
    if (REMOVE_KEYS.has(key)) return removeKey;
    return key === "Escape" && drag ? cancelKey : null;
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.ctrlKey || event.metaKey) return;
    const arrow: readonly [number, number] | undefined = ARROWS[event.key];
    if (arrow) {
      arrowKey(event, arrow);
      return;
    }
    const action: (() => void) | null = event.altKey ? null : keyAction(event.key);
    if (!action) return;
    event.preventDefault();
    action();
  };

  /** A layer that a palette put on the grid: it is selected, and the grid takes the focus for the next keys. */
  const added = (layer: GridLayer, rect: CellRect): void => {
    onSelect(layer);
    setCursor({ c: rect.c, r: rect.r });
    input.current?.focus({ preventScroll: true });
  };
  const paletteDrag = (layer: GridLayer, x: number, y: number): Drag => {
    const hit: GridHit | null = hitAt(x, y);
    return { mode: "add", layer, at: hit?.inside ? cellOf(hit.point) : null };
  };
  useImperativeHandle(
    ref,
    (): LayoutGridHandle => ({
      add: (layer: GridLayer): void => {
        const rect: CellRect | null = firstFreeCell(orientation, cells, layer);
        const problem: PlaceProblem | null = rect ? layoutProblem(layers, orientation, layer, rect) : null;
        if (!rect || problem) {
          say(problem ? notKept("add", layer, problem) : t("overlay.grid.noRoom", { layer: name(layer) }), true);
          return;
        }
        onPlace(layer, rect, "now");
        say(t("overlay.grid.placed", { layer: name(layer), ...placeText(rect) }));
        added(layer, rect);
      },
      dragOver: (layer: GridLayer, x: number, y: number): void => setDrag(paletteDrag(layer, x, y)),
      drop: (layer: GridLayer, x: number, y: number): void => {
        const active: Drag = paletteDrag(layer, x, y);
        const rect: CellRect | null = dragShape(cells, orientation, active);
        if (commit(active) && rect) added(layer, rect);
      },
      cancelDrop: (): void => setDrag(null),
    }),
  );

  const shape: CellRect | null = drag ? dragShape(cells, orientation, drag) : null;
  const invalid: boolean =
    drag !== null && shape !== null && layoutProblem(layers, orientation, drag.layer, shape) !== null;
  const lifted: GridLayer | null = drag?.mode === "move" ? drag.layer : null;
  // During a resize the layer, its label and its content follow the new size. Nothing is saved before the release.
  const resized: CellRect | null = drag?.mode === "resize" ? shape : null;
  const shownLayers: OverlayLayers = resized && drag ? withCell(layers, orientation, drag.layer, resized) : layers;
  const shown: GridCells = gridCells(shownLayers, orientation);

  // The preview shows the layers on the grid: chat plays the sample messages. A content cell with nothing on air
  // shows a dimmed sample card. `layers` stays as it is: nothing here is saved or sent to OBS.
  const sampleContent: boolean = shown.content !== null && !showsContent(source, scene.data);

  return (
    <>
      <section
        className="ov-frame ov-comp-frame"
        data-orientation={orientation}
        data-background={background}
        data-sample-off={sampleContent ? "content" : undefined}
        ref={frame}
        aria-label={t("overlay.comp.preview")}
      >
        <div className="ov-scaler" style={frameStyle(orientation)}>
          {background === "game" && <div className="ov-comp-game" aria-hidden="true" />}
          <OverlayComposition
            scene={sampleContent ? sampleScene(scene) : scene}
            source={sampleContent ? SAMPLE_SOURCE : source}
            layers={shownLayers}
            only={null}
            feed={null}
            charactersFeed={charactersFeed}
            samples={SAMPLE_CHAT}
          />
          <div className="ov-grid-lines" aria-hidden="true" />
          {GRID_LAYERS.map((layer: GridLayer) => {
            const rect: CellRect | null = shown[layer];
            if (!rect) return null;
            const px = cellPixels(rect);
            return (
              <div
                key={layer}
                className="ov-grid-box"
                data-grid-box={layer}
                data-selected={layer === selected || undefined}
                data-lifted={layer === lifted || undefined}
                data-off={(layer === "content" && sampleContent) || undefined}
                style={boxStyle(rect)}
                aria-hidden="true"
              >
                <span className="ov-grid-tag">
                  {name(layer)} · {px.w} × {px.h}
                </span>
                {layer === selected &&
                  RESIZE_HANDLES.map((handle: ResizeHandle) => (
                    <span key={handle} className="ov-grid-handle" data-grid-handle={handle} />
                  ))}
              </div>
            );
          })}
          {shape && (
            <div
              className="ov-grid-preview"
              data-grid-preview
              data-invalid={invalid || undefined}
              style={boxStyle(shape)}
            />
          )}
          {/* The application role makes screen readers leave browse mode here, so the grid button gets the arrow keys,
              Space and Enter. The role stays on a wrapper: an application element takes no key handlers. The wrapper
              names the grid and the button names the cursor cell, so the grid name is read once. */}
          <div role="application" className="ov-grid-app" aria-label={label}>
            <button
              type="button"
              className="ov-grid-input"
              data-comp-grid
              data-hover={drag?.mode === "resize" ? drag.handle : (hover ?? undefined)}
              ref={input}
              aria-label={cursorText(cells, cursor)}
              aria-describedby={helpId}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={pointerCancel}
              onPointerLeave={() => setHover(null)}
              onClick={click}
              onKeyDown={keyDown}
              onFocus={() => setFocused(true)}
              onBlur={blur}
            >
              {focused && (
                <span className="ov-grid-cursor" data-grid-cursor style={boxStyle({ ...cursor, w: 1, h: 1 })} />
              )}
            </button>
          </div>
        </div>
      </section>
      <p className="muted ov-comp-help" id={helpId}>
        {t("overlay.grid.help")}
      </p>
      <p className="ov-grid-status" data-grid-status data-bad={status.bad || undefined} aria-live="polite">
        {status.text}
      </p>
    </>
  );
}
