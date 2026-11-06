import { expect, test } from "@playwright/test";

test("mobile landing is one screen with Browse streamers and the scene under the copy", async ({ page }) => {
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
  // Sign-up and sign-in are one OAuth step in the header; the hero has one primary action, Browse streamers.
  const headerSignIn = page.getByRole("banner").getByRole("button", { name: "Sign in / Sign up", exact: true });
  await expect(headerSignIn).toHaveCount(1);
  await expect(page.getByRole("main").getByRole("button", { name: "Sign in / Sign up" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Log in|Register|Create account)$/ })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("link", { name: "Browse streamers" })).toHaveAttribute(
    "href",
    "/streamers",
  );
  await headerSignIn.click();
  await expect(page.getByRole("dialog", { name: "Sign in or sign up" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(headerSignIn).toBeFocused();
  // The legal footer stays on the one screen.
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Privacy" })).toBeInViewport();
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
  await page.getByRole("banner").getByRole("button", { name: "Sign in / Sign up", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Sign in or sign up" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  // The station's three signs are also plain links, so they work without WebGL and from the keyboard.
  const start = page.getByRole("list", { name: "Get started" });
  await expect(start.getByRole("link")).toHaveText(["Suggest a topic", "Vote in a poll", "Discuss the stream"]);
  await start.getByRole("link", { name: "Vote in a poll" }).click();
  await expect(page).toHaveURL(/\/streamers\?then=vote$/);
  await expect(page.getByRole("status")).toContainText("Pick a streamer to vote in their polls.");
});

test("the tilt pill shows only on touch devices that ask for motion access", async ({ browser }) => {
  test.slow(); // software WebGL in CI builds the scene on the CPU
  // Desktop: even a browser with requestPermission (Safari on a Mac) gets no pill.
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const stubPermission = (): void => {
    Object.defineProperty(globalThis.DeviceOrientationEvent, "requestPermission", {
      value: async (): Promise<string> => "granted",
      configurable: true,
    });
  };
  await desktop.addInitScript(stubPermission);
  const page = await desktop.newPage();
  await page.goto("/");
  const station = page.locator(".landing-station");
  await expect(station).toHaveAttribute("data-status", /ready|unavailable/, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Tilt to look around" })).toHaveCount(0);
  await desktop.close();

  // A touch phone whose browser needs the tap (iOS Safari) gets the pill once the station is ready.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  await phone.addInitScript(stubPermission);
  const mobile = await phone.newPage();
  await mobile.goto("/");
  const ready = mobile.locator('.landing-station[data-status="ready"]');
  const unavailable = mobile.locator('.landing-station[data-status="unavailable"]');
  await expect(ready.or(unavailable)).toHaveCount(1, { timeout: 60_000 });
  if ((await ready.count()) === 1) {
    const pill = mobile.getByRole("button", { name: "Tilt to look around" });
    await expect(pill).toBeVisible();
    await pill.tap();
    await expect(pill).toHaveCount(0);
  }
  await phone.close();
});
