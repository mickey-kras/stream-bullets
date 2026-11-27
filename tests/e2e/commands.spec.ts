import type { Locator } from "@playwright/test";
import { expect, test } from "./coverage";
import { COMMANDS } from "../../app/lib/playground/crowd";

/** Opaque pixels on a demo canvas. */
function painted(canvas: Locator): Promise<number> {
  return canvas.evaluate((element: Element): number => {
    const target = element as HTMLCanvasElement;
    const data = target.getContext("2d")?.getImageData(0, 0, target.width, target.height).data;
    let count = 0;
    for (let i = 3; data && i < data.length; i += 4) if (data[i] === 255) count += 1;
    return count;
  });
}

test("the commands page shows each chat command with a demo that runs", async ({ page }) => {
  await page.goto("/commands");
  await expect(page.getByRole("heading", { level: 1, name: "Character commands" })).toBeVisible();
  const rows = page.locator(".command-row");
  await expect(rows).toHaveCount(COMMANDS.length);
  for (const command of COMMANDS) {
    await expect(page.locator(`#${command}`).getByRole("heading", { level: 2, name: `!${command}` })).toBeVisible();
  }
  await expect(page.locator("#left")).toContainText("Also: !l");
  // The demo of !up builds two blocks, so its picture gets more opaque pixels.
  const canvas = page.locator("#up canvas.characters-layer");
  let low: number = Number.POSITIVE_INFINITY;
  let high = 0;
  await expect
    .poll(
      async (): Promise<number> => {
        const count: number = await painted(canvas);
        if (count > 500) low = Math.min(low, count);
        high = Math.max(high, count);
        return high - low;
      },
      { timeout: 15_000, intervals: [200] },
    )
    .toBeGreaterThan(2000);
});

test("with reduced motion the demos stand still", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/commands");
  const canvas = page.locator("#up canvas.characters-layer");
  await expect.poll(() => painted(canvas)).toBeGreaterThan(500);
  const before: number = await painted(canvas);
  await page.waitForTimeout(3000);
  expect(await painted(canvas)).toBe(before);
});
