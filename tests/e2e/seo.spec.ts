import { expect, test } from "./coverage";
import { origin } from "./fixtures";

test("public pages emit canonical URLs in server HTML", async ({ request }) => {
  for (const path of ["/", "/streamers", "/privacy", "/terms", "/ai", "/@feature_host"]) {
    const response = await request.get(`${path}?dialog=login&then=vote&utm_source=test`);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain(`rel="canonical" href="${origin}${path}"`);
  }
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toContain("application/xml");
  expect(await sitemap.text()).toContain(`<loc>${origin}/@feature_host</loc>`);
  expect(await (await request.get("/robots.txt")).text()).toContain("Sitemap: https://streambullets.com/sitemap.xml");
});

test("canonical identity follows tabs and conversation navigation", async ({ page }) => {
  await page.goto("/@feature_host?view=about&dialog=login&utm_source=test");
  const canonical = page.locator('link[rel="canonical"]');
  await expect(canonical).toHaveCount(1);
  await expect(canonical).toHaveAttribute("href", `${origin}/@feature_host?view=about`);
  await page.goto("/@feature_host?sort=top&utm_source=test");
  await expect(canonical).toHaveAttribute("href", `${origin}/@feature_host`);
  await page.locator("button.topic").filter({ hasText: "Mic shootout" }).click();
  await expect.poll((): string | null => new URL(page.url()).searchParams.get("entry")).not.toBeNull();
  const entry: string | null = new URL(page.url()).searchParams.get("entry");
  await expect(canonical).toHaveAttribute("href", `${origin}/@feature_host?entry=${entry}`);
  await page.goto("/@missing_profile");
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
});
