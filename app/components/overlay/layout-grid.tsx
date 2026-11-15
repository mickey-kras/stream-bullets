import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { t, type MessageId } from "../../i18n";
import { SAMPLE_CHAT } from "../../lib/chat-feed";
import { layerAt, moveCell, placeProblem, spanCells, type Cell, type PlaceProblem } from "../../lib/layer-geometry";
import {
  CELL_PX,
  GRID,
  GRID_LAYERS,
  MIN_CELLS,
  cellPixels,
  type CellRect,
  type GridLayer,
  type LayerCells,
  type Orientation,
  type OverlayLayers,
} from "../../lib/overlay-layers";
import type { OverlaySourceRef } from "../../types";
import { CHARACTERS_READY, OverlayComposition, frameStyle } from "./overlay-composition";
import type { OverlayScene } from "./overlay-stage";
import { useDesignScale } from "./use-design-scale";

export type PreviewBackground = "checker" | "game";

export const LAYER_NAMES: Readonly<Record<GridLayer, MessageId>> = {
  chat: "overlay.comp.chat",
  characters: "overlay.comp.characters",
  content: "overlay.comp.content",
};

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** A drag in progress: `paint` draws the selected layer across cells, `move` carries a placed layer. */
type Drag =
  | { mode: "paint"; layer: GridLayer; from: Cell; to: Cell }
  | { mode: "move"; layer: GridLayer; grab: Cell; at: Cell };

/** The cell a drag would give its layer. */
function dragShape(cells: LayerCells, orientation: Orientation, drag: Drag): CellRect | null {
  if (drag.mode === "paint") return spanCells(drag.from, drag.to);
  const rect: CellRect | null = cells[drag.layer];
  return rect ? moveCell(orientation, rect, drag.grab, drag.at) : null;
}

function name(layer: GridLayer): string {
  return t(LAYER_NAMES[layer]);
}

function problemText(layer: GridLayer, problem: PlaceProblem): string {
  if (problem.kind === "outside") return t("overlay.grid.outside");
  if (problem.kind === "overlap") return t("overlay.grid.touches", { layer: name(problem.other) });
  return t("overlay.grid.small", { layer: name(layer), w: MIN_CELLS[layer].w, h: MIN_CELLS[layer].h });
}

// "Column 3, row 2: Chat." for the cell under the keyboard cursor.
function cursorText(cells: LayerCells, cell: Cell): string {
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

/**
 * The layout grid of the selected orientation over a live preview of the composition. Pointer: drag on empty cells to
 * draw the selected layer, drag a placed layer to move it. Keyboard (the grid is one native button inside an element
 * with role "application", so screen readers pass the keys through): arrow keys move a cursor, Space or Enter picks
 * up and puts down (draw or move), Shift + arrow moves the selected layer one cell and Escape cancels. A click without
 * a pointer (an assistive technology's activation) acts as Space. A new orientation or leaving the grid ends a drag.
 * A shape that touches another layer or is below the minimum size shows red and is not kept. A polite
 * live region tells the result.
 */
export function LayoutGrid({
  layers,
  scene,
  source,
  background,
  selected,
  onSelect,
  onPlace,
}: Readonly<{
  /** The layers as shown: saved plus local edits. */
  layers: OverlayLayers;
  scene: OverlayScene;
  source: OverlaySourceRef;
  background: PreviewBackground;
  selected: GridLayer;
  onSelect: (layer: GridLayer) => void;
  /** Keeps a valid cell for a layer. `when` is "idle" for Shift + arrow steps. */
  onPlace: (layer: GridLayer, rect: CellRect, when: "now" | "idle") => void;
}>): ReactNode {
  const orientation: Orientation = layers.orientation;
  const { cols, rows } = GRID[orientation];
  const cells: LayerCells = layers.cells[orientation];
  const frame = useRef<HTMLElement | null>(null);
  useDesignScale(frame, cols * CELL_PX);
  const helpId: string = useId();
  const label: string = t("overlay.grid.label", { cols, rows });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [cursor, setCursor] = useState<Cell>({ c: 0, r: 0 });
  const [focused, setFocused] = useState<boolean>(false);
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

  const start = (cell: Cell): Drag => {
    const hit: GridLayer | null = layerAt(cells, cell);
    const rect: CellRect | null = hit ? cells[hit] : null;
    if (hit && rect) {
      onSelect(hit);
      return { mode: "move", layer: hit, grab: { c: cell.c - rect.c, r: cell.r - rect.r }, at: cell };
    }
    return { mode: "paint", layer: selected, from: cell, to: cell };
  };
  const follow = (active: Drag, cell: Cell): Drag =>
    active.mode === "move" ? { ...active, at: cell } : { ...active, to: cell };

  const commit = (active: Drag): void => {
    setDrag(null);
    const rect: CellRect | null = dragShape(cells, orientation, active);
    if (!rect) return;
    const problem: PlaceProblem | null = placeProblem(orientation, cells, active.layer, rect);
    const key: MessageId = active.mode === "move" ? "overlay.grid.notMoved" : "overlay.grid.notPlaced";
    if (problem) {
      say(`${t(key)} ${problemText(active.layer, problem)}`, true);
      return;
    }
    onPlace(active.layer, rect, "now");
    const done: MessageId = active.mode === "move" ? "overlay.grid.moved" : "overlay.grid.placed";
    say(t(done, { layer: name(active.layer), ...placeText(rect) }));
  };

  const cellAt = (event: PointerEvent<HTMLElement>): Cell => {
    const box: DOMRect = event.currentTarget.getBoundingClientRect();
    return clampCell({
      c: Math.floor(((event.clientX - box.left) / box.width) * cols),
      r: Math.floor(((event.clientY - box.top) / box.height) * rows),
    });
  };
  const pointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    const cell: Cell = cellAt(event);
    setCursor(cell);
    setDrag(start(cell));
  };
  const pointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!drag) return;
    const cell: Cell = cellAt(event);
    const next: Drag = follow(drag, cell);
    const now: CellRect | null = dragShape(cells, orientation, drag);
    const then: CellRect | null = dragShape(cells, orientation, next);
    if (then && now?.c === then.c && now.r === then.r && now.w === then.w && now.h === then.h) return;
    setCursor(cell);
    setDrag(next);
  };
  const pointerUp = (): void => {
    if (drag) commit(drag);
  };
  const pointerCancel = (): void => setDrag(null);

  // Space, Enter, or a click without a pointer: put down the drag, or pick up at the cursor.
  const activate = (): void => {
    if (drag) {
      commit(drag);
      return;
    }
    const next: Drag = start(cursor);
    setDrag(next);
    say(
      next.mode === "move"
        ? t("overlay.grid.moving", { layer: name(next.layer) })
        : t("overlay.grid.drawing", { layer: name(next.layer), c: cursor.c + 1, r: cursor.r + 1 }),
    );
  };
  // A screen reader's activation sends a click with no pointer (`detail` 0). A mouse click already ran pointerUp.
  const click = (event: MouseEvent<HTMLButtonElement>): void => {
    if (event.detail === 0) activate();
  };
  const blur = (): void => {
    setFocused(false);
    if (!drag) return;
    setDrag(null);
    say(t("overlay.grid.cancelled"));
  };

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const arrow: readonly [number, number] | undefined = ARROWS[event.key];
    const rect: CellRect | null = cells[selected];
    if (arrow && event.shiftKey && !drag) {
      // Shift + arrow moves the selected layer one cell.
      event.preventDefault();
      if (!rect) {
        say(t("overlay.grid.noCell", { layer: name(selected) }), true);
        return;
      }
      const next: CellRect = moveCell(
        orientation,
        rect,
        { c: 0, r: 0 },
        { c: rect.c + arrow[0], r: rect.r + arrow[1] },
      );
      const problem: PlaceProblem | null = placeProblem(orientation, cells, selected, next);
      if (problem) say(`${t("overlay.grid.notMoved")} ${problemText(selected, problem)}`, true);
      else {
        onPlace(selected, next, "idle");
        say(t("overlay.grid.moved", { layer: name(selected), ...placeText(next) }));
      }
    } else if (arrow) {
      event.preventDefault();
      const cell: Cell = clampCell({ c: cursor.c + arrow[0], r: cursor.r + arrow[1] });
      setCursor(cell);
      if (drag) setDrag(follow(drag, cell));
      say(cursorText(cells, cell));
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      activate();
    } else if (event.key === "Escape" && drag) {
      event.preventDefault();
      setDrag(null);
      say(t("overlay.grid.cancelled"));
    }
  };

  const shape: CellRect | null = drag ? dragShape(cells, orientation, drag) : null;
  const invalid: boolean =
    drag !== null && shape !== null && placeProblem(orientation, cells, drag.layer, shape) !== null;
  const lifted: GridLayer | null = drag?.mode === "move" ? drag.layer : null;

  return (
    <>
      <section
        className="ov-frame ov-comp-frame"
        data-orientation={orientation}
        data-background={background}
        ref={frame}
        aria-label={t("overlay.comp.preview")}
      >
        <div className="ov-scaler" style={frameStyle(orientation)}>
          {background === "game" && <div className="ov-comp-game" aria-hidden="true" />}
          <OverlayComposition
            scene={scene}
            source={source}
            layers={layers}
            only={null}
            feed={null}
            samples={SAMPLE_CHAT}
          />
          <div className="ov-grid-lines" aria-hidden="true" />
          {GRID_LAYERS.map((layer: GridLayer) => {
            const rect: CellRect | null = cells[layer];
            if (!rect) return null;
            const px = cellPixels(rect);
            const on: boolean = layer === "content" || layers[layer].enabled;
            return (
              <div
                key={layer}
                className="ov-grid-box"
                data-grid-box={layer}
                data-selected={layer === selected || undefined}
                data-lifted={layer === lifted || undefined}
                data-off={!on || undefined}
                style={boxStyle(rect)}
                aria-hidden="true"
              >
                <span className="ov-grid-tag">
                  {name(layer)} · {px.w} × {px.h}
                </span>
                {layer === "characters" && !CHARACTERS_READY && (
                  <span className="ov-grid-soon">{t("overlay.comp.layerSoon", { layer: name(layer) })}</span>
                )}
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
              aria-label={cursorText(cells, cursor)}
              aria-describedby={helpId}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={pointerCancel}
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
