import { useLayoutEffect, useEffect, type RefObject } from "react";

const useIsomorphicLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

// Detect tab clipping or collisions with brand/actions.
export function headerOverflows(header: HTMLElement): boolean {
  const nav: HTMLElement | null = header.querySelector(":scope > nav");
  if (!nav) return false;
  const brand: HTMLElement | null = header.querySelector(":scope > .brand");
  const end: HTMLElement | null = header.querySelector(":scope > .header-end");
  const tabs: HTMLElement[] = [...nav.querySelectorAll<HTMLElement>(":scope > a, :scope > button")];
  if (
    tabs.some((tab: HTMLElement) => tab.scrollWidth > tab.clientWidth + 1) ||
    [nav, brand, end].some((part: HTMLElement | null) => part !== null && part.scrollWidth > part.clientWidth + 1)
  )
    return true;
  if (tabs.length === 0) return false;
  const first: DOMRect = tabs[0].getBoundingClientRect();
  const last: DOMRect = tabs.at(-1)!.getBoundingClientRect();
  const brandRight: number | null = brand ? brand.getBoundingClientRect().right : null;
  const endLeft: number | null = end
    ? Math.min(
        end.getBoundingClientRect().left,
        ...[...end.children]
          .filter((child: Element) => child.getClientRects().length > 0)
          .map((child: Element) => child.getBoundingClientRect().left),
      )
    : null;
  return (brandRight !== null && first.left < brandRight + 4) || (endLeft !== null && last.right > endLeft - 4);
}

// Stack tabs when one row would clip or crowd them. Recheck on mount, resize and font load.
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
