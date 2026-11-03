import { expect, test } from "@playwright/test";

test("mobile landing keeps the directory and sign-in without loading the scene", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const scripts: string[] = [];
  page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(request.url()); });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "YOUR VOICE, ON AIR." })).toBeVisible();
  await expect(page.locator(".landing-canvas canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Join the conversation" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("button", { name: "Create account", exact: true })).toBeFocused();
  await page.getByRole("link", { name: "Explore streamers" }).click();
  await expect(page.getByRole("heading", { name: "Pick the next conversation" })).toBeInViewport();
  await expect(page.getByRole("link", { name: /test_host/ })).toBeVisible();
  await expect(page.locator(".landing-canvas canvas")).toHaveCount(0);
  expect(scripts.some((url: string) => /scene\.client/.test(url))).toBe(false);
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
