import { expect, test } from "@playwright/test";

test("mobile landing keeps the directory and sign-in and loads the scene below the copy", async ({ page }) => {
  test.slow(); // software WebGL in CI builds the scene on the CPU
  await page.setViewportSize({ width: 390, height: 844 });
  // Reduced motion renders the scene on demand, which keeps software WebGL in CI responsive.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const heading = page.getByRole("heading", { name: "YOUR VOICE, ON AIR." });
  await expect(heading).toBeVisible();
  // The live station sits under the copy on phones; it either renders or explains why it cannot.
  const station = page.locator(".landing-station");
  await expect(station.locator("canvas").or(station.getByRole("status"))).toHaveCount(1);
  const copyBottom = (await page.locator(".landing-copy").boundingBox())!;
  const stationTop = (await station.boundingBox())!;
  expect(stationTop.y).toBeGreaterThan(copyBottom.y + copyBottom.height - 20);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Join the conversation" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("button", { name: "Create account", exact: true })).toBeFocused();
  await page.getByRole("link", { name: "Explore streamers" }).click();
  await expect(page.getByRole("heading", { name: "Pick the next conversation" })).toBeInViewport();
  await expect(page.getByRole("link", { name: /test_host/ })).toBeVisible();
  const width = await page.evaluate((): number => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});

test("desktop landing remains usable when WebGL is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      value: function (this: HTMLCanvasElement, contextId: string, options?: unknown): RenderingContext | null {
        if (contextId.startsWith("webgl")) return null;
        return original.call(this, contextId, options);
      },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("station preview is unavailable");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Join the conversation" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("link", { name: "Explore streamers" }).click();
  await expect(page.getByRole("heading", { name: "Pick the next conversation" })).toBeInViewport();
});
