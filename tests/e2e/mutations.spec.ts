import { test, expect, newPage, close, type BrowserContext, type Page } from "./coverage";
import { clientIp } from "./client-ips";
import { origin, signedIn } from "./fixtures";

async function createPoll(context: BrowserContext, title: string): Promise<string> {
  const response = await context.request.post("/api/streamers/test_host", {
    headers: { Origin: origin },
    data: { action: "create", kind: "choice", title, options: ["First", "Second"], duration: 0 },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

function loaderReads(page: Page): string[] {
  const reads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith(".data")) reads.push(request.url());
  });
  return reads;
}

test("each poll stays usable while another vote is pending and only board data refreshes", async ({ browser }) => {
  const owner = await signedIn(browser, "owner", clientIp("mutations", 25));
  const firstId = await createPoll(owner, "Independent first poll");
  await createPoll(owner, "Independent second poll");
  const viewer = await signedIn(browser, "viewer", clientIp("mutations", 26));
  const page = await newPage(viewer);
  await page.goto("/@test_host?view=polls");
  const reads = loaderReads(page);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/streamers/test_host", async (route) => {
    if (route.request().method() === "POST" && (route.request().postDataJSON() as { id: string }).id === firstId)
      await held;
    await route.continue();
  });
  const first = page.locator("article.poll-card").filter({ hasText: "Independent first poll" });
  const second = page.locator("article.poll-card").filter({ hasText: "Independent second poll" });
  try {
    await first.getByRole("button", { name: "First", exact: true }).click();
    await expect(first.getByRole("button", { name: "Second", exact: true })).toBeDisabled();
    await expect(second.getByRole("button", { name: "Second", exact: true })).toBeEnabled();
    await second.getByRole("button", { name: "Second", exact: true }).click();
    await expect(second.getByRole("button", { name: "Second", exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally {
    release?.();
  }
  await expect(first.getByRole("button", { name: "First", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(second.getByRole("button", { name: "Second", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(reads).toEqual([]);
  await close(viewer);
  await close(owner);
});

test("selected poll data stays current and failed votes leave controls usable", async ({ browser }) => {
  const owner = await signedIn(browser, "owner", clientIp("mutations", 25));
  const id = await createPoll(owner, "Selected refresh poll");
  const viewer = await signedIn(browser, "viewer", clientIp("mutations", 27));
  const page = await newPage(viewer);
  await page.goto(`/@test_host?view=polls&entry=${id}`);
  const reads = loaderReads(page);
  await page.route("**/api/streamers/test_host", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Vote unavailable" }),
    });
  });
  const first = page.getByRole("button", { name: "First", exact: true });
  await first.click();
  await expect(page.locator(".page-error")).toHaveText("Vote unavailable");
  await expect(first).toBeEnabled();
  await page.unroute("**/api/streamers/test_host");
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  expect(reads).toEqual([]);
  await close(viewer);
  await close(owner);
});

test("a delayed board response cannot replace the next navigation", async ({ browser }) => {
  const owner = await signedIn(browser, "owner", clientIp("mutations", 25));
  await createPoll(owner, "Delayed refresh poll");
  const page = await newPage(owner);
  await page.goto("/@test_host?view=polls");
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delivered: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  let reached: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route("**/api/streamers/test_host?*", async (route) => {
    const response = await route.fetch();
    reached?.();
    await held;
    await route.fulfill({ response });
    delivered?.();
  });
  await page.getByRole("button", { name: /Refresh polls/ }).click();
  await started;
  try {
    await page.locator(".streamer-header nav").getByRole("link", { name: "Topics", exact: true }).click();
    await expect(page).toHaveURL(/view=topics/);
  } finally {
    release?.();
  }
  await completed;
  await expect(page.getByRole("heading", { name: /Pick the next conversation/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Delayed refresh poll", exact: true })).toHaveCount(0);
  await close(owner);
});

test("deleting an open poll through its card menu returns to the current list", async ({ browser }) => {
  const owner = await signedIn(browser, "owner", clientIp("mutations", 25));
  const id = await createPoll(owner, "Selected poll to delete");
  const page = await newPage(owner);
  await page.goto(`/@test_host?view=polls&entry=${id}`);
  const card = page.locator("article.poll-card").filter({ hasText: "Selected poll to delete" });
  await card.locator(".poll-kebab > summary").click();
  await card.getByRole("button", { name: "Delete poll", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete poll?", exact: true });
  await dialog.getByRole("button", { name: "Delete poll", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/view=polls$/);
  await expect(page.getByRole("heading", { name: "Selected poll to delete", exact: true })).toHaveCount(0);
  const removed = await owner.request.get(`/api/entries/${id}`);
  expect(removed.status()).toBe(404);
  await close(owner);
});

test("refreshing a selection deleted by another client replaces stale content with the missing-page response", async ({
  browser,
}) => {
  const owner = await signedIn(browser, "owner", clientIp("mutations", 25));
  const id = await createPoll(owner, "Poll removed during a vote");
  const viewer = await signedIn(browser, "viewer", clientIp("mutations", 26));
  const page = await newPage(viewer);
  await page.goto(`/@test_host?view=polls&entry=${id}`);
  await page.route("**/api/streamers/test_host", async (route) => {
    const vote = await route.fetch();
    expect(vote.ok()).toBe(true);
    const removed = await owner.request.post("/api/streamers/test_host", {
      headers: { Origin: origin },
      data: { action: "delete", id },
    });
    expect(removed.ok()).toBe(true);
    await route.fulfill({ response: vote });
  });
  await page.getByRole("button", { name: "First", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Poll removed during a vote", exact: true })).toHaveCount(0);
  await close(viewer);
  await close(owner);
});
