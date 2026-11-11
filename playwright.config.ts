import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 3,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ["line"],
    ["html", { open: "never" }],
    ...(process.env.BROWSER_COVERAGE === "1" ? [["./scripts/browser-coverage-reporter.ts"] as [string]] : []),
  ],
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    {
      name: "chromium",
      testIgnore: "**/responsive-layout.spec.ts",
      workers: 1,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "responsive-chromium",
      testMatch: "**/responsive-layout.spec.ts",
      fullyParallel: true,
      workers: 2,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node tests/e2e-server.ts",
    url: "http://localhost:5173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
