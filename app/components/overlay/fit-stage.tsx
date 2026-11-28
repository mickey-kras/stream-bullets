import { useEffect, useRef, type ReactNode, type RefObject } from "react";

/**
 * Scales the content in a cell down so that it fits inside the cell (`--ov-fit` on `box`, never above 1). It
 * compares the content with its stage; both scale together, so the ratio does not depend on the scale already set.
 * It measures again when the content or the cell changes size and when the content changes.
 */
export function useFitScale(box: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const element: HTMLDivElement | null = box.current;
    if (!element) return;
    const measure = (): void => {
      const stage: Element | null = element.firstElementChild;
      const content: Element | null | undefined = stage?.firstElementChild;
      if (!stage || !content) return;
      const outer: DOMRect = stage.getBoundingClientRect();
      const inner: DOMRect = content.getBoundingClientRect();
      const byWidth: number = inner.width > 0 ? outer.width / inner.width : 1;
      const byHeight: number = inner.height > 0 ? outer.height / inner.height : 1;
      element.style.setProperty("--ov-fit", String(Math.min(1, byWidth, byHeight)));
    };
    const sizes = new ResizeObserver(measure);
    const watch = (): void => {
      sizes.disconnect();
      sizes.observe(element);
      const content: Element | null | undefined = element.firstElementChild?.firstElementChild;
      if (content) sizes.observe(content);
      measure();
    };
    const changes = new MutationObserver(watch);
    changes.observe(element, { childList: true, subtree: true, characterData: true });
    watch();
    return (): void => {
      sizes.disconnect();
      changes.disconnect();
    };
  }, [box]);
}

/**
 * One card in its grid cell, as the content layers show theirs: centred, at the full cell width, and scaled down to
 * fit when its text makes it higher than the cell. No text is cut. `type` names the content for checks.
 */
export function FitStage({ type, children }: Readonly<{ type: string; children: ReactNode }>): ReactNode {
  const box = useRef<HTMLDivElement | null>(null);
  useFitScale(box);
  return (
    <div className="ov-fit" ref={box}>
      <div className="ov-stage" data-overlay-type={type}>
        {children}
      </div>
    </div>
  );
}
