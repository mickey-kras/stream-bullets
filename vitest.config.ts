import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["app/server/**/*.ts"],
      exclude: ["app/server/poll-room.ts"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
