import { useEffect, useLayoutEffect, useRef } from "react";

export function useDiscussionViewport(focused: boolean, entryId: string | null): void {
  const positions = useRef<Map<string, number>>(new Map());
  const previous = useRef<boolean>(focused);

  useLayoutEffect(() => {
    const scroller: HTMLElement | null = document.querySelector("#detail, .streamer-shell > .page-panel");
    if (!scroller || !entryId) return;
    const key: string = `${entryId}:${focused ? "discussion" : "entry"}`;
    const top: number = positions.current.get(key) ?? 0;
    const changed: boolean = previous.current !== focused;
    previous.current = focused;
    const frame: number = requestAnimationFrame(() => {
      scroller.scrollTop = top;
      if (changed && matchMedia("(max-width: 43.75em)").matches) {
        const target: HTMLElement | null = document.querySelector(
          focused ? ".discussion-focus-bar button" : ".open-discussion",
        );
        target?.focus({ preventScroll: true });
      }
    });
    const remember = (): void => {
      positions.current.set(key, scroller.scrollTop);
    };
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", remember);
    };
  }, [focused, entryId]);

  useEffect(() => {
    if (!focused) return;
    const root: HTMLElement = document.documentElement;
    const viewport: VisualViewport | null = window.visualViewport;
    const resize = (): void => {
      root.style.setProperty("--discussion-height", `${viewport?.height ?? window.innerHeight}px`);
      root.style.setProperty("--discussion-top", `${viewport?.offsetTop ?? 0}px`);
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
      root.style.removeProperty("--discussion-height");
      root.style.removeProperty("--discussion-top");
    };
  }, [focused]);
}
