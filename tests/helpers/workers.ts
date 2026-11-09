/**
 * Stands in for `cloudflare:workers` outside workerd (vitest.config.ts aliases the module here). `waitUntil` keeps
 * each background promise so a test can wait for it with `settleBackground()`.
 */
const background: Promise<unknown>[] = [];

export function waitUntil(promise: Promise<unknown>): void {
  background.push(promise);
}

/** Waits for every promise passed to `waitUntil` so far. */
export async function settleBackground(): Promise<void> {
  while (background.length > 0) await Promise.allSettled(background.splice(0));
}
