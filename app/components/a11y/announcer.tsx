import type { ReactNode } from "react";

const POLITE_ID = "sb-announce-polite";
const ASSERTIVE_ID = "sb-announce-assertive";

/** Pending messages by key: a newer message with the same key replaces one that has not been read out yet. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Reads a short message out to screen readers. The two live regions are mounted once by <Announcer> and never
 * re-rendered by React, so a message is not lost when the page around it changes. The region is cleared first,
 * so the same text twice is announced twice. Use `assertive` only for time-critical news (a battle starting).
 */
export function announce(message: string, options: Readonly<{ assertive?: boolean; key?: string }> = {}): void {
  const region: HTMLElement | null = globalThis.document?.getElementById(options.assertive ? ASSERTIVE_ID : POLITE_ID);
  if (!region) return;
  const key: string = options.key ?? "";
  if (key) clearTimeout(pending.get(key));
  const timer = setTimeout(
    () => {
      region.textContent = "";
      setTimeout(() => {
        region.textContent = message;
      }, 40);
      if (key) pending.delete(key);
    },
    key ? 120 : 0,
  );
  if (key) pending.set(key, timer);
}

/** The live regions for announce(). Mounted once in the root layout. */
export function Announcer(): ReactNode {
  return (
    <div className="sr-only">
      <p id={POLITE_ID} aria-live="polite" aria-atomic="true" />
      <p id={ASSERTIVE_ID} aria-live="assertive" aria-atomic="true" />
    </div>
  );
}
