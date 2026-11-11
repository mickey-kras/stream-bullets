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
  await expect(page.getByRole("alert")).toContainText("Vote unavailable");
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
  let reached: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route("**/api/streamers/test_host?*", async (route) => {
    const response = await route.fetch();
    reached?.();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: /Refresh polls/ }).click();
  await started;
  try {
    await page.getByRole("link", { name: "Topics", exact: true }).click();
    await expect(page).toHaveURL(/view=topics/);
  } finally {
    release?.();
  }
  await expect(page.getByRole("heading", { name: /Topics/ }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Delayed refresh poll", exact: true })).toHaveCount(0);
  await close(owner);
});
