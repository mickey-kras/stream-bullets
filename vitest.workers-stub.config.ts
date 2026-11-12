// vitest.config.ts aliases cloudflare:workers here outside workerd.
// Start background work immediately so tests can observe its effects.
export function waitUntil(promise: Promise<unknown>): void {
  void promise;
}
