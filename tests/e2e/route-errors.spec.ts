import { expect, test } from "./coverage";
import { clientAddress } from "./client-ips";
import { runSql } from "./fixtures";

test.use({ extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("route-errors", 136) } });

test("DB failures show a correlated request ID on reload and client navigation", async ({ page }) => {
  await page.goto("/");
  await runSql("route-errors-break", ["ALTER TABLE streamers RENAME TO streamers_unavailable;"]);
  try {
    const response = await page.goto("/streamers");
    expect(response?.status()).toBe(500);
    const initialId: string | undefined = response?.headers()["x-request-id"];
    expect(initialId).toMatch(/^[a-f0-9-]{36}$/);
    await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
    await expect(page.getByText(`Request ID: ${initialId}`, { exact: true })).toBeVisible();
    await expect(page.locator("main")).not.toContainText("streamers_unavailable");

    await page.goto("/");
    const dataResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/streamers.data");
    await page.locator(".landing-main a[href='/streamers']").first().click();
    const navigation = await dataResponse;
    expect(navigation.status()).toBe(500);
    const navigationId: string | undefined = navigation.headers()["x-request-id"];
    expect(navigationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(navigationId).not.toBe(initialId);
    await expect(page.getByText(`Request ID: ${navigationId}`, { exact: true })).toBeVisible();
  } finally {
    await runSql("route-errors-restore", ["ALTER TABLE streamers_unavailable RENAME TO streamers;"]);
  }
  await page.goto("/@missing_host");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByText(/^Request ID:/)).toHaveCount(0);
});
