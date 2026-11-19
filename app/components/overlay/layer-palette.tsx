import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { t } from "../../i18n";
import type { GridLayer } from "../../lib/overlay-layers";
import { LAYER_NAMES, type LayoutGridHandle, type RemoveDrop } from "./layout-grid";

/** A press that moves this many pixels is a drag, not a click. */
const DRAG_START_PX = 6;

interface Point {
  x: number;
  y: number;
}

/**
 * One layer that is not on the grid. A click, Enter or Space adds it at the first free place. A drag (mouse, touch
 * or pen) carries the chip to the grid and drops the layer at the pointer. The chip uses pointer events, not the
 * HTML drag and drop API: that API does not work with touch.
 */
function PaletteChip({
  layer,
  grid,
  hintId,
}: Readonly<{ layer: GridLayer; grid: RefObject<LayoutGridHandle | null>; hintId: string }>): ReactNode {
  // Where the press started. Null: no press.
  const from = useRef<Point | null>(null);
  // How far the chip is from its place during a drag. Null: no drag.
  const [offset, setOffset] = useState<Point | null>(null);
  // The browser sends a click after the release of a drag. That click must not add the layer.
  const dragged = useRef<boolean>(false);

  const end = (): void => {
    from.current = null;
    setOffset(null);
  };
  const pointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    dragged.current = false;
    if (event.button !== 0) return;
    from.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const start: Point | null = from.current;
    if (!start) return;
    const next: Point = { x: event.clientX - start.x, y: event.clientY - start.y };
    if (!offset && Math.hypot(next.x, next.y) < DRAG_START_PX) return;
    dragged.current = true;
    setOffset(next);
    grid.current?.dragOver(layer, event.clientX, event.clientY);
  };
  const pointerUp = (event: PointerEvent<HTMLButtonElement>): void => {
    if (offset) grid.current?.drop(layer, event.clientX, event.clientY);
    end();
  };
  const pointerCancel = (): void => {
    if (offset) grid.current?.cancelDrop();
    end();
  };
  const click = (): void => {
    if (dragged.current) dragged.current = false;
    else grid.current?.add(layer);
  };
  const style: CSSProperties | undefined = offset
    ? { transform: `translate(${offset.x}px, ${offset.y}px)` }
    : undefined;
  return (
    <button
      type="button"
      className="ov-palette-chip"
      data-comp-add={layer}
      data-dragging={offset !== null || undefined}
      aria-describedby={hintId}
      style={style}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerCancel}
      onClick={click}
    >
      <span aria-hidden="true">+ </span>
      {t(LAYER_NAMES[layer])}
    </button>
  );
}

/**
 * The layers that are not on the grid, as chips. A chip adds its layer to the grid `grid` (see PaletteChip). When
 * all layers are on the grid, a note shows in place of the chips. The parent gives the layers and puts the palette
 * where it fits: the palette does not know the page around it.
 *
 * The palette is also where a layer leaves the grid. While a pointer carries a placed layer (`drop`), a drop place
 * covers the chips and names the action. The grid reads the box of the palette through `ref` and takes the drop.
 */
export function LayerPalette({
  free,
  grid,
  drop,
  ref,
}: Readonly<{
  /** The layers that are not on the grid in the selected orientation. */
  free: readonly GridLayer[];
  grid: RefObject<LayoutGridHandle | null>;
  /** A pointer carries a placed layer ("ready"), or holds it over the palette ("over"). Null: no such drag. */
  drop: RemoveDrop | null;
  ref?: Ref<HTMLFieldSetElement>;
}>): ReactNode {
  const hintId: string = useId();
  return (
    <fieldset className="field ov-seg-field ov-palette" data-comp-palette data-drop={drop ?? undefined} ref={ref}>
      <legend className="field-label">{t("overlay.grid.palette")}</legend>
      <div className="ov-palette-body">
        {free.length > 0 ? (
          <>
            <div className="ov-palette-chips">
              {free.map((layer: GridLayer) => (
                <PaletteChip key={layer} layer={layer} grid={grid} hintId={hintId} />
              ))}
            </div>
            <p className="muted ov-comp-note" id={hintId}>
              {t("overlay.grid.paletteHint")}
            </p>
          </>
        ) : (
          <p className="muted ov-comp-note" data-comp-palette-empty>
            {t("overlay.grid.paletteEmpty")}
          </p>
        )}
        {/* Hidden from screen readers: a pointer drag shows it, and the keyboard has Delete on the grid. */}
        {drop && (
          <p className="ov-palette-drop" data-comp-palette-drop aria-hidden="true">
            {t("overlay.grid.dropRemove")}
          </p>
        )}
      </div>
    </fieldset>
  );
}
