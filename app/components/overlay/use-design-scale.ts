import { useEffect, type RefObject } from "react";

/**
 * Scales fixed design-pixel content to the width of an element. Sets `--ov-scale` (element width / designWidth) on
 * the element and `data-scaled` once measured, so CSS can hide the content until then and never overflow. Follows
 * resizes. Works inside a scaled ancestor too: the layout width ignores ancestor transforms.
 */
export function useDesignScale(ref: RefObject<HTMLElement | null>, designWidth: number): void {
  useEffect(() => {
    const element: HTMLElement | null = ref.current;
    if (!element || designWidth <= 0) return;
    const scale = (): void => {
      element.style.setProperty("--ov-scale", String(element.clientWidth / designWidth));
      element.dataset.scaled = "true";
    };
    scale();
    const observer = new ResizeObserver(scale);
    observer.observe(element);
    return (): void => observer.disconnect();
  }, [ref, designWidth]);
}
