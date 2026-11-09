/**
 * Stands in for `cloudflare:workers` outside workerd: vitest.config.ts aliases the module to this file. The
 * background work starts at once, as in the runtime; tests observe its effects (for example a room fetch) directly.
 */
export function waitUntil(promise: Promise<unknown>): void {
  void promise;
}
