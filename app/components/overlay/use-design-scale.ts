import { useEffect, type RefObject } from "react";

/**
 * Scales fixed design-pixel content to an element. Sets `--ov-scale` on the element and `data-scaled` once measured,
 * so CSS can hide the content until then and never overflow. Follows resizes. Works inside a scaled ancestor too:
 * the layout size ignores ancestor transforms.
 *
 * Without `designHeight` the scale is element width / designWidth. With it the content fits inside the element
 * ("contain"): the smaller of the width and height ratios, so no part is cut off when the aspect ratios differ.
 *
 * With `enabled` false the element is not measured and has no scale (a design canvas that is off).
 */
export function useDesignScale(
  ref: RefObject<HTMLElement | null>,
  designWidth: number,
  designHeight?: number,
  enabled: boolean = true,
): void {
  useEffect(() => {
    const element: HTMLElement | null = ref.current;
    if (!element) return;
    if (!enabled) {
      element.style.removeProperty("--ov-scale");
      delete element.dataset.scaled;
      return;
    }
    if (designWidth <= 0) return;
    const scale = (): void => {
      const byWidth: number = element.clientWidth / designWidth;
      const value: number =
        designHeight !== undefined && designHeight > 0
          ? Math.min(byWidth, element.clientHeight / designHeight)
          : byWidth;
      element.style.setProperty("--ov-scale", String(value));
      element.dataset.scaled = "true";
    };
    scale();
    const observer = new ResizeObserver(scale);
    observer.observe(element);
    return (): void => observer.disconnect();
  }, [ref, designWidth, designHeight, enabled]);
}
