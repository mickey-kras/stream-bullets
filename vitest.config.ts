import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { uiCoveragePlugin } from "./scripts/ui-coverage-plugin.ts";

export default defineConfig({
  plugins: process.env.UI_COVERAGE === "1" ? [uiCoveragePlugin("unit")] : [],
  resolve: {
    // Outside workerd, `cloudflare:workers` resolves to a stub. Tests that need the Durable Object runtime mock it
    // with tests/helpers/room.ts instead.
    alias: { "cloudflare:workers": fileURLToPath(new URL("vitest.workers-stub.config.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: process.env.UI_COVERAGE === "1" ? ["./scripts/ui-coverage-setup.ts"] : [],
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
