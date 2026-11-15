import type { ReactNode } from "react";

const POLITE_ID = "sb-announce-polite";
const ASSERTIVE_ID = "sb-announce-assertive";

// Replace unread messages with the same key.
const pending = new Map<string, ReturnType<typeof setTimeout>>();

// Persistent non-React live regions survive rerenders. Clear before writing so repeated text is announced.
// Reserve assertive for time-critical messages.
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

// Mount once in the root layout.
export function Announcer(): ReactNode {
  return (
    <div className="sr-only">
      <p id={POLITE_ID} aria-live="polite" aria-atomic="true" />
      <p id={ASSERTIVE_ID} aria-live="assertive" aria-atomic="true" />
    </div>
  );
}
