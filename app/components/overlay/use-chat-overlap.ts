import { useEffect, useState, type RefObject } from "react";
import type { LayerRect } from "../../lib/overlay-layers";
import type { OverlaySourceRef } from "../../types";

/** Overlaps smaller than this many screen pixels on each axis do not count, so a shared edge is not an overlap. */
const MIN_OVERLAP_PX = 2;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The bounding box of the on-air content in a composition, or null when no content shows. */
function contentBox(root: HTMLElement): Box | null {
  const stage: Element | null = root.querySelector(".ov-composition > .ov-stage");
  if (!stage) return null;
  let box: Box | null = null;
  for (const child of Array.from(stage.children)) {
    const rect: DOMRect = child.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    box = box
      ? {
          left: Math.min(box.left, rect.left),
          top: Math.min(box.top, rect.top),
          right: Math.max(box.right, rect.right),
          bottom: Math.max(box.bottom, rect.bottom),
        }
      : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }
  return box;
}

/** Whether the chat layer box in a composition covers part of the on-air content. */
export function chatCoversContent(root: HTMLElement): boolean {
  const chat: Element | null = root.querySelector('.ov-composition > .ov-layer[data-layer="chat"]');
  const content: Box | null = contentBox(root);
  if (!chat || !content) return false;
  const rect: DOMRect = chat.getBoundingClientRect();
  const width: number = Math.min(rect.right, content.right) - Math.max(rect.left, content.left);
  const height: number = Math.min(rect.bottom, content.bottom) - Math.max(rect.top, content.top);
  return width >= MIN_OVERLAP_PX && height >= MIN_OVERLAP_PX;
}

/**
 * Whether the enabled chat layer covers part of the on-air content in the preview inside `frame`. It measures the
 * rendered boxes, so it follows each content type, position and size. It measures again when the chat rect or the
 * on-air source changes, when the content changes (a poll result, a new card) and when the frame resizes.
 */
export function useChatOverlap(
  frame: RefObject<HTMLElement | null>,
  chat: Readonly<{ enabled: boolean; rect: LayerRect }>,
  source: OverlaySourceRef,
): boolean {
  const [overlap, setOverlap] = useState<boolean>(false);
  const { enabled } = chat;
  const { x, y, w, h } = chat.rect;
  const { type, ref } = source;
  useEffect(() => {
    const root: HTMLElement | null = frame.current;
    if (!root || !enabled) return;
    const measure = (): void => setOverlap(chatCoversContent(root));
    // The layer box positions itself in this commit; measure after layout.
    const frameId: number = requestAnimationFrame(measure);
    // Web fonts change the size of the content text.
    let active: boolean = true;
    void document.fonts?.ready.then((): void => {
      if (active) measure();
    });
    const resize = new ResizeObserver(measure);
    resize.observe(root);
    const stage: Element | null = root.querySelector(".ov-composition > .ov-stage");
    const changes = new MutationObserver(measure);
    if (stage) changes.observe(stage, { childList: true, subtree: true, characterData: true, attributes: true });
    return (): void => {
      active = false;
      cancelAnimationFrame(frameId);
      resize.disconnect();
      changes.disconnect();
    };
  }, [frame, enabled, x, y, w, h, type, ref]);
  // A hidden chat covers nothing. When it shows again, the next frame measures it.
  return enabled && overlap;
}
