import { useLayoutEffect, useEffect, type RefObject } from "react";

const useIsomorphicLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

/** True when the header's tabs would be clipped or would touch the brand or the actions on one row. */
export function headerOverflows(header: HTMLElement): boolean {
  const nav: HTMLElement | null = header.querySelector(":scope > nav");
  if (!nav) return false;
  const brand: HTMLElement | null = header.querySelector(":scope > .brand");
  const end: HTMLElement | null = header.querySelector(":scope > .header-end");
  const tabs: HTMLElement[] = [...nav.querySelectorAll<HTMLElement>(":scope > a, :scope > button")];
  if (tabs.some((tab: HTMLElement) => tab.scrollWidth > tab.clientWidth + 1) || nav.scrollWidth > nav.clientWidth + 1)
    return true;
  if (tabs.length === 0) return false;
  const first: DOMRect = tabs[0].getBoundingClientRect();
  const last: DOMRect = tabs.at(-1)!.getBoundingClientRect();
  const brandRight: number | null = brand ? brand.getBoundingClientRect().right : null;
  const endLeft: number | null = end ? end.getBoundingClientRect().left : null;
  return (brandRight !== null && first.left < brandRight + 4) || (endLeft !== null && last.right > endLeft - 4);
}

/**
 * Puts the header's tabs on a second row (`header-stacked`) whenever one row would clip a label or crowd the
 * brand or the actions: at any width, text size or language. Runs on mount, on resize and when fonts load.
 */
export function useFitHeader(header: RefObject<HTMLElement | null>): void {
  useIsomorphicLayoutEffect(() => {
    if (header.current) fitHeader(header.current);
  });
  useEffect(() => {
    const element: HTMLElement | null = header.current;
    if (!element) return;
    let frame: number = 0;
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitHeader(element));
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    void document.fonts?.ready.then(schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [header]);
}

function fitHeader(element: HTMLElement): void {
  element.classList.remove("header-stacked");
  element.classList.toggle("header-stacked", headerOverflows(element));
}
