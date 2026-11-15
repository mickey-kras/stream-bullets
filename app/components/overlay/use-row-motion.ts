import { useLayoutEffect, useRef, type RefObject } from "react";
import { motionReduced } from "../station/motion";

/** The approved chat motion (issue #663): rows move vertically for 520 ms. */
export const ROW_MOTION = { duration: 520, easing: "cubic-bezier(0.22, 1, 0.36, 1)" } as const;

/** Below this many design pixels a row counts as still. */
const STILL_PX = 0.5;

interface Shift {
  dy: number;
  opacity: number;
}

/** The current vertical offset and opacity of a row while its slide runs. */
function shiftOf(item: HTMLElement): Shift {
  const style: CSSStyleDeclaration = getComputedStyle(item);
  const dy: number = style.transform === "none" ? 0 : new DOMMatrixReadOnly(style.transform).m42;
  return { dy, opacity: Number(style.opacity) };
}

function rowId(item: Element): string | undefined {
  return item instanceof HTMLElement ? item.dataset.rowId : undefined;
}

/**
 * The place of each row in `root`: the distance from the top of the row to the bottom of the list, in design
 * pixels. The list grows from the bottom, so a change of the list height does not move this value. offsetTop
 * ignores transforms: it is the layout place, whatever the layer scale.
 */
function places(root: HTMLElement): {
  items: HTMLElement[];
  bottoms: Map<string, number>;
  heights: Map<string, number>;
} {
  const items: HTMLElement[] = [];
  const bottoms = new Map<string, number>();
  const heights = new Map<string, number>();
  const height: number = root.clientHeight;
  for (const child of root.children) {
    const id: string | undefined = rowId(child);
    if (id === undefined || !(child instanceof HTMLElement)) continue;
    items.push(child);
    bottoms.set(id, height - child.offsetTop);
    heights.set(id, child.offsetHeight);
  }
  return { items, bottoms, heights };
}

/**
 * FLIP motion for the chat rows, the children of `list` with `data-row-id`. After each change of `version`, rows
 * that moved slide from where they showed to their new place, and a new row with `data-enter` slides up from one
 * row height below while it fades in. Only transform and opacity animate, with element.animate, so no frame runs
 * layout. A change cancels the slides in flight and starts the new ones from where the rows show.
 *
 * Nothing moves on the first render, with reduced motion (the site's Motion setting or the OS setting), or when a
 * change adds a row without `data-enter` (a reconnect snapshot or a burst): those rows show in place at once.
 */
export function useRowMotion(list: RefObject<HTMLElement | null>, version: unknown): void {
  const bottoms = useRef<Map<string, number> | null>(null);
  const running = useRef<Map<string, Animation>>(new Map());

  // A resize of the layer (a live edit) can wrap the rows again. Then the stored places are measured again, so the
  // next change does not slide the rows from where they were before the resize.
  useLayoutEffect(() => {
    const root: HTMLElement | null = list.current;
    if (!root || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver((): void => {
      if (bottoms.current !== null) bottoms.current = places(root).bottoms;
    });
    observer.observe(root);
    return (): void => observer.disconnect();
  }, [list]);

  useLayoutEffect(() => {
    const root: HTMLElement | null = list.current;
    if (!root) return;
    // All reads first, then all writes: one layout for each change, never one for each row.
    const { items, bottoms: next, heights } = places(root);
    const previous: Map<string, number> | null = bottoms.current;
    bottoms.current = next;
    if (previous === null) return;
    const moved: boolean =
      previous.size !== next.size ||
      [...next].some(([id, bottom]: [string, number]): boolean => previous.get(id) !== bottom);
    if (!moved) return;

    // Where each sliding row shows now, then stop the slides in flight.
    const shifts = new Map<string, Shift>();
    for (const item of items) {
      const id: string = rowId(item) ?? "";
      if (running.current.get(id)?.playState === "running") shifts.set(id, shiftOf(item));
    }
    const gap: number = Number.parseFloat(getComputedStyle(root).rowGap) || 0;
    for (const animation of running.current.values()) animation.cancel();
    running.current.clear();

    if (motionReduced() || typeof root.animate !== "function") return;
    const added: HTMLElement[] = items.filter((item: HTMLElement): boolean => !previous.has(rowId(item) ?? ""));
    if (added.some((item: HTMLElement): boolean => item.dataset.enter === undefined)) return;

    for (const item of items) {
      const id: string = rowId(item) ?? "";
      const bottom: number = next.get(id) ?? 0;
      const before: number | undefined = previous.get(id);
      const shift: Shift | undefined = shifts.get(id);
      // The old top minus the new top: a row that is now further from the bottom starts lower (a positive offset).
      const from: number = before === undefined ? (heights.get(id) ?? 0) + gap : bottom - before + (shift?.dy ?? 0);
      const opacity: number = before === undefined ? 0 : (shift?.opacity ?? 1);
      if (Math.abs(from) < STILL_PX && opacity > 0.99) continue;
      const animation: Animation = item.animate(
        [
          { transform: `translateY(${from}px)`, opacity },
          { transform: "translateY(0)", opacity: 1 },
        ],
        ROW_MOTION,
      );
      running.current.set(id, animation);
      animation.addEventListener("finish", (): void => {
        if (running.current.get(id) === animation) running.current.delete(id);
      });
    }
  }, [list, version]);
}
