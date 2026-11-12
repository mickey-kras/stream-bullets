import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { newPage, close, expect, test } from "./coverage";
import { clientAddress } from "./client-ips";
import { origin } from "./fixtures";

/** A signed-out phone: 390px wide, touch, mobile viewport. */
async function phone(browser: Browser, octet: number): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("board-navigation", octet) },
  });
}

function row(page: Page, title: string): Locator {
  return page.locator("#topics .topic", { hasText: title });
}

async function rowTop(locator: Locator): Promise<number> {
  return Math.round((await locator.boundingBox())?.y ?? Number.NaN);
}

test("phone list and detail: Back and browser Back keep filters, scroll position and focus", async ({ browser }) => {
  const context = await phone(browser, 160);
  const page = await newPage(context);
  await page.goto("/@pagination_host?view=topics&sort=newest&query=Archive");
  const target = row(page, "Archive topic 30");
  await target.scrollIntoViewIfNeeded();
  const top: number = await rowTop(target);
  const length: number = await page.evaluate(() => history.length);

  // Tap: the list gives way to the detail, and focus moves to its title instead of being lost.
  await target.tap();
  await expect(page).toHaveURL(/entry=/);
  await expect(page).toHaveURL(/query=Archive/);
  const title = page.locator("#detail .detail-title");
  await expect(title).toHaveText("Archive topic 30");
  await expect(title).toBeFocused();
  await expect(page.locator("#topics")).toBeHidden();

  // The Back control returns to the same history entry: no extra step for the browser's Back.
  await page.getByRole("button", { name: "All topics" }).tap();
  await expect(page).not.toHaveURL(/entry=/);
  await expect(page).toHaveURL(/sort=newest&query=Archive/);
  await expect(target).toBeFocused();
  expect(Math.abs((await rowTop(target)) - top)).toBeLessThanOrEqual(4);
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await expect(page.getByRole("searchbox", { name: "Search topics" })).toHaveValue("Archive");

  // Keyboard and the browser's Back do the same.
  await target.press("Enter");
  await expect(title).toBeFocused();
  await page.goBack();
  await expect(page).not.toHaveURL(/entry=/);
  await expect(target).toBeFocused();
  expect(Math.abs((await rowTop(target)) - top)).toBeLessThanOrEqual(4);
  await close(context);
});

test("an empty search is a search result with Clear search, not an empty board", async ({ browser }) => {
  const context = await phone(browser, 161);
  const page = await newPage(context);
  await page.goto("/@pagination_host?view=topics");
  const search = page.getByRole("searchbox", { name: "Search topics" });
  await search.fill("no such topic here");
  await search.press("Enter");
  await expect(page).toHaveURL(/query=no/);
  const list = page.locator("#topics");
  await expect(list.getByRole("heading", { name: "No topics match your search." })).toBeVisible();
  await expect(page.getByText("No topics yet")).toHaveCount(0);
  await expect(page.locator("#sb-announce-polite")).toHaveText("No topics match your search.");
  await list.getByRole("link", { name: "Clear search" }).tap();
  await expect(page).not.toHaveURL(/query=/);
  await expect(row(page, "Archive topic 55")).toBeVisible();
  await close(context);
});

test("desktop Ideas filter without results offers All ideas in the detail pane", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("board-navigation", 162) },
  });
  const page = await newPage(context);
  await page.goto("/@streambullets?view=topics&status=progress");
  const detail = page.locator("#detail");
  await expect(detail.getByRole("heading", { name: "No ideas have the status “In progress”." })).toBeVisible();
  await expect(page.locator("#topics")).toContainText("0 ideas");
  await expect(page.getByText("No ideas here yet.")).toHaveCount(0);
  // The two header links have different names and destinations.
  await expect(page.getByRole("link", { name: "StreamBullets home", exact: true })).toHaveAttribute("href", "/");
  await expect(page.getByRole("link", { name: "Ideas for StreamBullets", exact: true })).toHaveAttribute(
    "href",
    "/@streambullets",
  );
  await page.getByRole("navigation", { name: "Filter by status" }).getByRole("link", { name: "Planned", exact: true }).click();
  await expect(page.locator("#sb-announce-polite")).toHaveText(/^\d+ ideas?$/);
  await page.getByRole("navigation", { name: "Filter by status" }).getByRole("link", { name: "In progress" }).click();
  await detail.getByRole("link", { name: "All ideas" }).click();
  await expect(page).toHaveURL(/\?view=topics$/);
  await expect(page.locator("#topics .idea-row").first()).toBeVisible();
  await close(context);
});

test("phone Back from a poll's discussion returns focus to that poll", async ({ browser }) => {
  const context = await phone(browser, 163);
  const page = await newPage(context);
  await page.goto("/@frozen_host?view=polls");
  const discuss = page.locator(".poll-card", { hasText: "Frozen poll" }).locator(".discuss-link");
  await discuss.tap();
  await expect(page).toHaveURL(/entry=/);
  await page.getByRole("button", { name: "All polls" }).tap();
  await expect(page).not.toHaveURL(/entry=/);
  await expect(page.locator(".poll-card", { hasText: "Frozen poll" }).locator(".discuss-link")).toBeFocused();
  await close(context);
});
