import { newPage, close } from "./coverage";
import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext } from "./coverage";
import { z } from "zod";
import { clientAddress } from "./client-ips";

const origin: string = "http://localhost:5173";
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));

async function signedIn(browser: Browser, role: string): Promise<BrowserContext> {
  const sessions = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
  const session = sessions[role];
  if (!session) throw new Error("Unknown test account.");
  const context = await browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("directory", 135) },
  });
  await context.addCookies([
    { name: "stream-bullets.session_token", value: session.cookie, domain: "localhost", path: "/", httpOnly: true },
  ]);
  return context;
}

test("the Streamers directory pins the official page, pages with Load more, and searches", async ({ page }) => {
  await page.goto("/streamers");
  await expect(page).toHaveTitle("Streamers · StreamBullets");
  await expect(page.getByRole("heading", { level: 1, name: "Streamers" })).toBeVisible();
  const cards = page.locator(".streamer-card");
  // The official page comes first, with its badge; suspended pages are left out; frozen pages say so.
  await expect(cards.first()).toContainText("StreamBullets");
  await expect(cards.first()).toContainText("Official");
  await expect(page.getByRole("link", { name: /Suspended host/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Frozen host/ })).toContainText("Frozen");
  // Every page has a picture: logo, else the owner's picture, else the default Space explorer.
  await expect(page.getByRole("link", { name: /Test host/ }).locator(".user-avatar.portrait")).toHaveAttribute(
    "data-preset",
    "14",
  );

  await expect(cards).toHaveCount(50);
  const count = page.locator(".list-count");
  await expect(count).toHaveText(/^Showing 50 of \d+ pages$/);
  const total = Number(/of (\d+)/.exec((await count.textContent()) ?? "")?.[1]);
  await page.getByRole("button", { name: "Load more streamers" }).click();
  await expect(cards).toHaveCount(total);
  // Focus moves to the first new card, and the button goes when everything is shown.
  await expect(cards.nth(50)).toBeFocused();
  await expect(page.getByRole("button", { name: "Load more streamers" })).toHaveCount(0);
  await expect(count).toHaveText(`Showing ${total} pages`);

  const search = page.getByRole("searchbox", { name: "Search streamers" });
  await search.fill("room 4");
  await expect(page).toHaveURL(/query=room\+4/);
  await expect(cards).toHaveCount(9);
  await expect(count).toHaveText("Showing 9 pages");
  await search.fill("nothing_like_it");
  await search.press("Enter");
  await expect(cards).toHaveCount(0);
  await expect(page.getByText("No streamers match “nothing_like_it”.")).toBeVisible();
  await search.fill("@test_h");
  await search.press("Enter");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("href", "/@test_host");
  await page.goto("/streamers?query=nothing_here");
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page).toHaveURL(/\/streamers$/);
  await expect(search).toHaveValue("");
  await expect(cards).toHaveCount(50);
});

test("a landing sign's intent shows a prompt and sends each card to that action", async ({ browser, page }) => {
  await page.goto("/streamers?then=suggest");
  const prompt = page.getByRole("status").filter({ hasText: "Pick a streamer to suggest a topic." });
  await expect(prompt).toBeVisible();
  await expect(page.getByRole("link", { name: /Test host/ })).toHaveAttribute(
    "href",
    "/@test_host?view=topics&intent=suggest",
  );
  await page.goto("/streamers?then=vote");
  await expect(page.getByRole("link", { name: /Test host/ })).toHaveAttribute("href", "/@test_host?view=polls");
  await page.goto("/streamers?then=discuss");
  await expect(page.getByRole("link", { name: /Test host/ })).toHaveAttribute(
    "href",
    "/@test_host?view=topics&sort=top&intent=discuss",
  );
  // The intent survives a search, and the × clears only the prompt.
  const search = page.getByRole("searchbox", { name: "Search streamers" });
  await search.fill("test_h");
  await search.press("Enter");
  await expect(page).toHaveURL(/then=discuss/);
  await page.getByRole("link", { name: "Clear this prompt and show the plain streamer list" }).click();
  await expect(page).toHaveURL(/\/streamers\?query=test_h$/);
  await expect(page.getByRole("link", { name: /Test host/ })).toHaveAttribute("href", "/@test_host");
  await page.goto("/streamers?then=nonsense");
  await expect(page.locator(".intent-prompt")).toHaveCount(0);

  // Signed-in viewers without a page are offered Host a community; /settings opens Your profile here.
  const context = await signedIn(browser, "viewer");
  const viewer = await newPage(context);
  await viewer.goto("/streamers");
  await expect(viewer.getByRole("main").getByRole("link", { name: "Host a community", exact: true })).toBeVisible();
  const response = await viewer.request.get("/settings", { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers().location).toBe("/streamers?dialog=profile");
  await close(context);
});

test("visitors can open real content from the featured community", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Browse streamers", exact: true }).click();
  const featured = page.getByRole("region", { name: "StreamBullets" });
  await expect(featured.getByText("Start here")).toBeVisible();
  const entry = featured.locator("li a").first();
  const title: string = await entry.innerText();
  await expect(entry).toHaveAttribute("href", /view=topics&entry=/);
  await entry.click();
  await expect(page).toHaveURL(/entry=/);
  await expect(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
  await page.goto("/streamers?query=nothing_here");
  await expect(page.getByText("Start here", { exact: true })).toHaveCount(0);
});
