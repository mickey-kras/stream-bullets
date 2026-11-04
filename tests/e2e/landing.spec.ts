import { expect, test } from "@playwright/test";

test("mobile landing is one screen with sign-in and the scene under the copy", async ({ page }) => {
  test.slow(); // software WebGL in CI builds the scene on the CPU
  await page.setViewportSize({ width: 390, height: 844 });
  // Reduced motion renders the scene on demand, which keeps software WebGL in CI responsive.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const heading = page.getByRole("heading", { name: "YOUR VOICE, ON AIR." });
  await expect(heading).toBeVisible();
  // The live station fills the screen under the headline. The atom shows while the scene loads (slowly,
  // on CI's software WebGL); then the station either renders or explains why it cannot.
  const station = page.locator(".landing-station");
  await expect(station.locator(".landing-canvas canvas").or(station.locator(".station-status"))).toHaveCount(1, {
    timeout: 60_000,
  });
  await expect(station.locator(".station-loader")).toHaveCount(0);
  const headingBox = (await heading.boundingBox())!;
  const stationBox = (await station.boundingBox())!;
  expect(stationBox.y).toBeGreaterThan(headingBox.y + headingBox.height);
  expect(stationBox.y + stationBox.height).toBeLessThanOrEqual(844 + 1);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Join the conversation" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("button", { name: "Create account", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Pick the next conversation" })).toHaveCount(0);
  // One adaptive screen: nothing scrolls in either direction.
  const page_ = await page.evaluate(() => {
    const el = document.querySelector(".landing-page")!;
    return {
      sw: document.documentElement.scrollWidth,
      sh: el.scrollHeight,
      ch: el.clientHeight,
    };
  });
  expect(page_.sw).toBeLessThanOrEqual(390);
  expect(page_.sh).toBeLessThanOrEqual(page_.ch);
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
  await expect(page.getByRole("link", { name: "Explore streamers" })).toHaveCount(0);
});
