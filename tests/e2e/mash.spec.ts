import { test, expect } from "@playwright/test";
import { mashId, shots, signedIn } from "./live-helpers";

test("a Mash Battle counts one tap per key press and updates the overlay live", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", 80);
  const viewer = await signedIn(browser, "viewer", 81);
  const id = await mashId(owner);
  const obs = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await obs.goto("/@feature_host/overlay");
  await expect(obs.locator("[data-overlay-mash]")).toBeVisible();

  const page = await viewer.newPage();
  await page.goto(`/@feature_host?view=polls&entry=${id}`);
  await expect(page.getByRole("button", { name: /Radahn/ })).toHaveAttribute("aria-pressed", "true");

  expect((await owner.request.post(`/api/mash/${id}/start`, { data: { countdown: false } })).status()).toBe(200);
  const tap = page.locator(".mash-button");
  await expect(tap).toBeVisible();
  await expect(obs.locator('[data-overlay-mash="live"]')).toBeVisible();
  const mine = page.locator("[data-mash-mine]");
  // The seed gave this viewer 25 taps. A held key repeats, but only the first press counts.
  await tap.focus();
  for (let index = 0; index < 6; index += 1) await page.keyboard.down(" ");
  await page.keyboard.up(" ");
  await expect(mine).toHaveText("26");
  for (let index = 0; index < 3; index += 1) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(120);
  }
  await expect(mine).toHaveText("29");
  // The overlay bar follows the 5 Hz totals without a reload.
  await expect(obs.locator('[data-mash-total="1"]')).toHaveText("29");
  await expect(obs.locator('[data-mash-pct="1"]')).toHaveText("100%");
  if (shots) {
    await page.locator(".mash-card").screenshot({ path: `${shots}/mash-card-live.png` });
    await obs.screenshot({ path: `${shots}/overlay-mash-live.png` });
  }

  expect((await owner.request.post(`/api/mash/${id}/end`, { data: {} })).status()).toBe(200);
  await expect(obs.locator('[data-overlay-mash="finished"]')).toBeVisible();
  await expect(obs.locator(".mash-winner strong")).toHaveText("Radahn");
  await expect(page.locator(".mash-winner-title")).toContainText("Radahn");
  if (shots) await obs.screenshot({ path: `${shots}/overlay-mash-winner.png` });

  // Restart deletes the taps and keeps the sides viewers picked.
  expect((await owner.request.post(`/api/mash/${id}/restart`, { data: {} })).status()).toBe(200);
  await expect(page.getByRole("button", { name: /Radahn/ })).toHaveAttribute("aria-pressed", "true");
  await Promise.all([owner.close(), viewer.close(), obs.close()]);
});

test("only the host runs a battle and signed-out viewers see a sign-in prompt", async ({ browser, page }) => {
  const viewer = await signedIn(browser, "viewer", 82);
  const id = await mashId(viewer);
  expect((await viewer.request.post(`/api/mash/${id}/start`, { data: {} })).status()).toBe(403);
  await page.goto(`/@feature_host?view=polls&entry=${id}`);
  await expect(page.getByText("Sign in to join the battle.")).toBeVisible();
  await viewer.close();
});
