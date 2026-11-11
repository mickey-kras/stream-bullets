import { expect, test } from "./coverage";

for (const [label, width, height] of [["small phone", 320, 568], ["phone", 390, 844], ["landscape phone", 844, 390]] as const) {
  test(`${label}: landing controls stay reachable and hero cost is recorded`, async ({ page }, testInfo) => {
    test.slow();
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const devtools = await page.context().newCDPSession(page);
    await devtools.send("Performance.enable");
    await page.goto("/");
    const station = page.locator(".landing-station");
    await expect(station).toHaveAttribute("data-status", /ready|unavailable/, { timeout: 60_000 });
    const load = await page.evaluate(() => ({
      observedReadyMs: performance.now(),
      status: document.querySelector<HTMLElement>(".landing-station")?.dataset.status,
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      resources: performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/assets/")).map((entry) => {
        const resource = entry as PerformanceResourceTiming;
        return { file: new URL(resource.name).pathname, encodedBytes: resource.encodedBodySize, durationMs: resource.duration };
      }),
    }));
    expect(load.documentWidth).toBeLessThanOrEqual(load.viewportWidth);
    for (const link of await page.locator(".landing-copy a").all()) {
      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeInViewport();
      // Trial clicks also detect overlap and clipped hit targets without navigating.
      await link.click({ trial: true });
    }
    const metrics = async (): Promise<Record<string, number>> => {
      const result = await devtools.send("Performance.getMetrics");
      return Object.fromEntries(result.metrics.map((metric: { name: string; value: number }) => [metric.name, metric.value]));
    };
    const sample = async (): Promise<Record<string, number>> => {
      const start = await metrics();
      // Fixed observation window, not a readiness wait. Measures CPU tasks and animation cadence.
      const frames = await page.evaluate(() => new Promise<number>((resolve) => {
        const end = performance.now() + 2000;
        let count = 0;
        const frame = (): void => {
          count += 1;
          if (performance.now() >= end) resolve(count);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }));
      const end = await metrics();
      return { frames, taskSeconds: end.TaskDuration - start.TaskDuration, scriptSeconds: end.ScriptDuration - start.ScriptDuration };
    };
    const still = await sample();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const animated = await sample();
    await testInfo.attach("mobile-hero-cost.json", { body: JSON.stringify({ width, height, load, still, animated }, null, 2), contentType: "application/json" });
    await testInfo.attach("mobile-landing.png", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await devtools.detach();
  });
}

test("landing clicks emit one anonymous receipt; failed tracking does not block navigation", async ({ page }) => {
  const events: { event: string; id: string }[] = [];
  await page.route("**/api/conversions", async (route) => {
    events.push(route.request().postDataJSON() as { event: string; id: string });
    await route.fulfill({ status: 503, body: "unavailable" });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("link", { name: "Browse streamers", exact: true }).click();
  await expect(page).toHaveURL(/\/streamers$/);
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({ event: "cta_browse", id: expect.any(String) });
});
