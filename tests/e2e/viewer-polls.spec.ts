import { test, expect, newPage, close, type BrowserContext, type Page } from "./coverage";
import { clientIp } from "./client-ips";
import { origin, signedIn } from "./fixtures";

// Viewer polls on a streamer page: the create control, the author on the card, and the order of the Polls list.

const HOST = "pagination_host";

async function createPoll(context: BrowserContext, title: string): Promise<string> {
  const response = await context.request.post(`/api/streamers/${HOST}`, {
    headers: { Origin: origin },
    data: { action: "create", kind: "choice", title, options: ["First", "Second"], duration: 0 },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

// The titles of the poll cards on the Polls tab, in page order.
async function listedTitles(page: Page): Promise<string[]> {
  return page.locator("article.poll-card h2").allTextContents();
}

test("a signed-in viewer creates a poll, and only the page owner can end it", async ({ browser }) => {
  const guest = await browser.newContext({ baseURL: origin });
  const guestPage = await newPage(guest);
  await guestPage.goto(`/@${HOST}?view=polls`);
  await expect(guestPage.getByRole("heading", { level: 1, name: /Polls/ })).toBeVisible();
  await expect(guestPage.getByRole("button", { name: "Create poll", exact: true })).toHaveCount(0);
  await close(guest);

  const viewer = await signedIn(browser, "viewer", clientIp("viewer-polls", 16));
  const page = await newPage(viewer);
  await page.goto(`/@${HOST}?view=polls`);
  await page.getByRole("button", { name: "Create poll", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Question", exact: true }).fill("Which map does the viewer pick?");
  await dialog.getByRole("textbox", { name: /^Options/ }).fill("Dust\nMirage");
  await dialog.getByRole("button", { name: "Start poll" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/view=polls&entry=/);
  const card = page.locator("article.poll-card").filter({ hasText: "Which map does the viewer pick?" }).first();
  await expect(card.locator("[data-poll-author]")).toContainText("Posted by viewer");
  // The author votes, but has no control that ends the poll or reveals results.
  await card.getByRole("button", { name: /^Dust/ }).click();
  await expect(card.getByRole("button", { name: /^Dust/ })).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByRole("button", { name: "End & reveal" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete poll", exact: true })).toBeVisible();
  const pollId: string | null = new URL(page.url()).searchParams.get("entry");
  if (!pollId) throw new Error("The link of the created poll is missing.");
  const refused = await viewer.request.post(`/api/streamers/${HOST}`, {
    headers: { Origin: origin },
    data: { action: "reveal", id: pollId },
  });
  expect(refused.status()).toBe(403);

  // The page owner sees the author and ends the viewer poll.
  const owner = await signedIn(browser, "paginationowner", clientIp("viewer-polls", 17));
  const ownerPage = await newPage(owner);
  await ownerPage.goto(`/@${HOST}?view=polls&entry=${pollId}`);
  const ownerCard = ownerPage
    .locator("article.poll-card")
    .filter({ hasText: "Which map does the viewer pick?" })
    .first();
  await expect(ownerCard.locator("[data-poll-author]")).toContainText("Posted by viewer");
  await ownerCard.getByRole("button", { name: "End & reveal" }).click();
  await expect(ownerCard.getByText("Ended by host")).toBeVisible();
  await close(owner);
  await close(viewer);
});

test("the Polls tab lists the owner's active polls, then other active polls, then ended polls", async ({ browser }) => {
  const owner = await signedIn(browser, "paginationowner", clientIp("viewer-polls", 18));
  const viewer = await signedIn(browser, "viewer", clientIp("viewer-polls", 19));
  // Creation order is the reverse of the list order, so the newest-first order alone cannot pass.
  const ownerActive = "Order: owner active";
  const viewerActive = "Order: viewer active";
  const ownerEnded = "Order: owner ended";
  const viewerEnded = "Order: viewer ended, newest";
  await createPoll(owner, ownerActive);
  await createPoll(viewer, viewerActive);
  const ended = await createPoll(owner, ownerEnded);
  const endedLater = await createPoll(viewer, viewerEnded);
  for (const id of [ended, endedLater]) {
    const response = await owner.request.post(`/api/streamers/${HOST}`, {
      headers: { Origin: origin },
      data: { action: "reveal", id },
    });
    expect(response.ok()).toBe(true);
  }

  // The order is the same for a guest: "my" polls are the polls of the page owner.
  const guest = await browser.newContext({ baseURL: origin });
  const page = await newPage(guest);
  await page.goto(`/@${HOST}?view=polls`);
  await expect(page.locator("article.poll-card").filter({ hasText: ownerActive })).toBeVisible();
  const titles: string[] = await listedTitles(page);
  const at = (title: string): number => titles.indexOf(title);
  expect(at(ownerActive)).toBeGreaterThanOrEqual(0);
  expect(at(ownerActive)).toBeLessThan(at(viewerActive));
  expect(at(viewerActive)).toBeLessThan(at(viewerEnded));
  // Ended polls list newest first, whoever wrote them.
  expect(at(viewerEnded)).toBeLessThan(at(ownerEnded));
  // The first card is an active poll of the page owner.
  const first = page.locator("article.poll-card").first();
  await expect(first.locator("[data-poll-author]")).toContainText("Posted by paginationowner");
  await expect(first.getByText("Voting live")).toBeVisible();
  await close(guest);
  await close(viewer);
  await close(owner);
});
