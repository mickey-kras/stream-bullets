import { test, expect } from "@playwright/test";
import { signedIn as fixtureSignedIn } from "./fixtures";
import { shots, signedIn } from "./live-helpers";
import { clientIp } from "./client-ips";

test("the owner previews, takes and switches what the one OBS URL shows", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 90));
  const control = await owner.newPage();
  await control.setViewportSize({ width: 1440, height: 1000 });
  const obs = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await obs.goto("/@feature_host/overlay");
  await expect(obs.locator("[data-overlay-mash]")).toBeVisible();

  await control.goto("/overlay-control");
  await expect(control.getByRole("heading", { level: 1, name: "Overlay control" })).toBeVisible();
  await expect(control.locator('[data-ov-monitor="prev"] [data-overlay-source="topic"]')).toContainText("Mic shootout");
  await expect(control.locator("[data-ov-url]")).toHaveText("localhost:5173/@feature_host/overlay");
  if (shots) await control.screenshot({ path: `${shots}/overlay-control.png`, fullPage: true });

  await control.getByRole("button", { name: /Take/ }).click();
  await expect(obs.locator('[data-overlay-source="topic"]')).toContainText("Mic shootout");
  await expect(control.getByRole("button", { name: /Take/ })).toBeDisabled();

  // Shortcut 5 picks the message banner. Typing in the field never switches the source.
  await control.locator("body").press("5");
  const message = control.locator("[data-ov-message]");
  await expect(message).toHaveAttribute("maxlength", "120");
  await message.fill("Back in 5 minutes 4");
  await expect(control.getByRole("radio", { name: /Message banner/ })).toBeChecked();
  await control.getByRole("button", { name: "Save message" }).click();
  await expect(control.getByRole("button", { name: "Save message" })).toBeDisabled();
  await control.getByRole("button", { name: "Hype" }).click();
  await expect(control.getByRole("button", { name: "Hype" })).toHaveAttribute("aria-pressed", "true");
  await expect(control.getByRole("button", { name: /Take/ })).toBeEnabled();
  await control.locator("body").press("t");
  await expect(obs.locator('[data-overlay-source="message"]')).toContainText("Back in 5 minutes 4");
  await expect(obs.locator(".ov-message.style-hype")).toBeVisible();

  await control.getByRole("button", { name: "Top bar" }).click();
  await expect(obs.locator(".ov-stage.pos-top")).toBeVisible();
  // The box follows the saved state, so it changes once the server answers.
  await control.getByRole("checkbox", { name: "Instant switch (skip preview)" }).click();
  await expect(control.getByRole("checkbox", { name: "Instant switch (skip preview)" })).toBeChecked();
  await expect(control.locator('[data-ov-monitor="prev"]')).toHaveCount(0);
  await control.locator("body").press("8");
  await expect(obs.locator('[data-overlay-type="hidden"]')).toBeEmpty();
  if (shots) await obs.screenshot({ path: `${shots}/overlay-hidden.png` });

  // Back to Auto so the page ends as it started: the newest open poll.
  await control.locator("body").press("1");
  await expect(obs.locator('[data-overlay-type="auto"]')).toBeVisible();
  await control.getByRole("checkbox", { name: "Instant switch (skip preview)" }).click();
  await expect(control.getByRole("checkbox", { name: "Instant switch (skip preview)" })).not.toBeChecked();
  await Promise.all([owner.close(), obs.close()]);
});

test("overlay control is for the page owner only", async ({ browser, page }) => {
  await page.goto("/overlay-control");
  await expect(page).toHaveURL(/\/streamers$/);
  const viewer = await signedIn(browser, "viewer", clientIp("overlay-control", 91));
  const viewerPage = await viewer.newPage();
  expect((await viewerPage.goto("/overlay-control"))?.status()).toBe(404);
  expect((await viewer.request.post("/api/overlay", { data: { action: "take" } })).status()).toBe(404);
  const long = "x".repeat(121);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 92));
  const tooLong = await owner.request.post("/api/overlay", { data: { action: "message", text: long, style: "info" } });
  expect(tooLong.status()).toBe(400);
  await Promise.all([viewer.close(), owner.close()]);
});

test("a monitor shows its stage only once it is scaled to the frame", async ({ browser }) => {
  const phone = { viewport: { width: 390, height: 844 } };
  // Without script the stage is never scaled, as before hydration. At its default size it would spill out.
  const still = await fixtureSignedIn(browser, "featureowner", 92, { ...phone, javaScriptEnabled: false });
  const before = await still.newPage();
  await before.goto("/overlay-control");
  await expect(before.locator('[data-ov-monitor="air"] .ov-scaler')).toBeHidden();
  await still.close();
  const owner = await fixtureSignedIn(browser, "featureowner", 92, phone);
  const page = await owner.newPage();
  await page.goto("/overlay-control");
  await expect(page.locator('[data-ov-monitor="air"] .ov-scaler')).toBeVisible();
  await owner.close();
});
