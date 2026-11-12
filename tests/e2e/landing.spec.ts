import { newPage, close } from "./coverage";
import { expect, test } from "./coverage";
import { signedIn } from "./fixtures";
import { clientIp } from "./client-ips";

test("mobile landing is one screen with Browse streamers and the scene under the copy", async ({ page }) => {
  test.slow(); // software WebGL in CI builds the scene on the CPU
  await page.setViewportSize({ width: 390, height: 844 });
  // Reduced motion keeps CI software WebGL responsive.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const heading = page.getByRole("heading", { name: "YOUR VOICE, ON AIR." });
  await expect(heading).toBeVisible();
  // Show the loading atom, then the station or its failure message.
  const station = page.locator(".landing-station");
  await expect(station.locator(".landing-canvas canvas").or(station.locator(".station-status"))).toHaveCount(1, {
    timeout: 60_000,
  });
  await expect(station.locator(".station-loader")).toHaveCount(0);
  const headingBox = (await heading.boundingBox())!;
  const stationBox = (await station.boundingBox())!;
  expect(stationBox.y).toBeGreaterThan(headingBox.y + headingBox.height);
  expect(stationBox.y + stationBox.height).toBeLessThanOrEqual(844 + 1);
  const headerSignIn = page.getByRole("banner").getByRole("button", { name: "Sign in / Sign up", exact: true });
  await expect(headerSignIn).toHaveCount(1);
  await expect(page.getByRole("main").getByRole("button", { name: "Sign in / Sign up" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Log in|Register|Create account)$/ })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("link", { name: "Browse streamers" })).toHaveAttribute(
    "href",
    "/streamers",
  );
  const join = page.getByRole("link", { name: "Join as a streamer", exact: true });
  await expect(join).toBeInViewport();
  await expect(join).toHaveAttribute("href", "/?dialog=host");
  await expect(page.getByText("Collect topics from your viewers and run audience polls.")).toBeVisible();
  await join.click();
  await expect(page).toHaveURL(/\/\?dialog=host$/);
  await expect(page.getByRole("dialog", { name: "Sign in or sign up" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page).toHaveURL(/\/$/);
  await headerSignIn.click();
  await expect(page.getByRole("dialog", { name: "Sign in or sign up" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(headerSignIn).toBeFocused();
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Privacy" })).toBeInViewport();
  await expect(page.getByRole("heading", { name: "Pick the next conversation" })).toHaveCount(0);
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
  const poster = page.locator(".station-poster");
  await expect(poster).toBeVisible();
  expect(await poster.evaluate((image: HTMLImageElement): boolean => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.getByRole("banner").getByRole("button", { name: "Sign in / Sign up", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Sign in or sign up" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  // Plain sign links work without WebGL and with the keyboard.
  const start = page.getByRole("list", { name: "Get started" });
  await expect(start.getByRole("link")).toHaveText(["Suggest a topic", "Vote in a poll", "Discuss the stream"]);
  await start.getByRole("link", { name: "Vote in a poll" }).click();
  await expect(page).toHaveURL(/\/streamers\?then=vote$/);
  await expect(page.getByRole("status")).toContainText("Pick a streamer to vote in their polls.");
});

test("the tilt pill shows only on touch devices that ask for motion access", async ({ browser }) => {
  test.slow(); // software WebGL in CI builds the scene on the CPU
  // Desktop gets no permission pill, even with requestPermission.
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const stubPermission = (): void => {
    Object.defineProperty(globalThis.DeviceOrientationEvent, "requestPermission", {
      value: async (): Promise<string> => "granted",
      configurable: true,
    });
  };
  await desktop.addInitScript(stubPermission);
  const page = await newPage(desktop);
  await page.goto("/");
  const station = page.locator(".landing-station");
  await expect(station).toHaveAttribute("data-status", /ready|unavailable/, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Tilt to look around" })).toHaveCount(0);
  await close(desktop);

  // Show the permission pill on touch phones once the station is ready.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  await phone.addInitScript(stubPermission);
  // Reduced motion hides tilt permission. Full motion restores it.
  await phone.addCookies([
    { name: "sb_prefs", value: encodeURIComponent('{"motion":"full"}'), domain: "localhost", path: "/" },
  ]);
  const mobile = await newPage(phone);
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
  await close(phone);
});

for (const role of ["viewer", "owner"] as const) {
  test(`landing join path for ${role}`, async ({ browser }) => {
    const context = await signedIn(browser, role, clientIp("landing", role === "viewer" ? 154 : 155), {
      reducedMotion: "reduce",
    });
    const page = await newPage(context);
    await page.goto("/");
    const main = page.getByRole("main");
    const join = main.getByRole("link", { name: "Join as a streamer", exact: true });
    await expect(main.getByRole("link", { name: "Browse streamers" })).toBeVisible();
    if (role === "viewer") {
      await join.click();
      await expect(page.getByRole("dialog", { name: "Host a community" })).toBeVisible();
      await expect(page.getByRole("form", { name: "Host a community request" })).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Sign in or sign up" })).toHaveCount(0);
    } else {
      await expect(join).toHaveCount(0);
      await expect(main.getByRole("link", { name: "Your page" })).toHaveAttribute("href", "/@test_host");
    }
    await close(context);
  });
}


test("the station stays visible without JavaScript on desktop and mobile", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await newPage(context);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    const poster = page.locator(".station-poster");
    await expect(poster).toBeVisible();
    await expect(poster).toBeInViewport();
    expect(await poster.evaluate((image: HTMLImageElement): boolean => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.getByRole("link", { name: "Browse streamers", exact: true }).click();
    await expect(page).toHaveURL(/\/streamers$/);
    await expect(page.getByRole("heading", { name: "Streamers", exact: true })).toBeVisible();
  }
  await close(context);
});
