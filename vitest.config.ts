import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["app/server/**/*.ts", "app/components/station/**/*.{ts,tsx}"],
      exclude: ["app/server/poll-room.ts"],
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
        "app/server/**/*.ts": { lines: 90, statements: 90, functions: 90, branches: 90 },
        "app/components/station/**/*.{ts,tsx}": { lines: 90, statements: 90, functions: 90, branches: 90 },
      },
    },
  },
});
