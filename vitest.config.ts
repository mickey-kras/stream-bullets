import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Outside workerd, use a stub. Room tests mock the module with tests/helpers/room.ts.
    alias: { "cloudflare:workers": fileURLToPath(new URL("vitest.workers-stub.config.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["app/server/**/*.ts", "app/components/station/**/*.{ts,tsx}", "app/lib/**", "worker/**"],
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
        "app/server/**/*.ts": { lines: 90, statements: 90, functions: 90, branches: 90 },
        "app/components/station/**/*.{ts,tsx}": { lines: 90, statements: 90, functions: 90, branches: 90 },
        "app/lib/**": { lines: 90, statements: 90, functions: 90, branches: 90 },
        "worker/**": { lines: 90, statements: 90, functions: 90, branches: 90 },
      },
    },
  },
});
