import { readFile } from "node:fs/promises";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";
import { clientAddress } from "./client-ips";

const origin: string = "http://localhost:5173";
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));
const png: Buffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
  "base64",
);

async function signedIn(browser: Browser, role: string): Promise<BrowserContext> {
  const sessions = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
  const session = sessions[role];
  if (!session) throw new Error("Unknown test account.");
  const roleIndex: number = ["owner", "viewer", "newcomer", "otherowner", "admin", "reporter"].indexOf(role);
  const context = await browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("platform", roleIndex + 10) },
  });
  await context.addCookies([
    {
      name: "stream-bullets.session_token",
      value: session.cookie,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return context;
}

async function assertNoScriptErrors(page: Page, action: () => Promise<void>): Promise<void> {
  const errors: string[] = [];
  const record = (error: Error): void => {
    errors.push(error.message);
  };
  page.on("pageerror", record);
  await action();
  page.off("pageerror", record);
  expect(errors).toEqual([]);
}

test("public access rejects forged identities and unsafe mutations", async ({ browser, request, page }) => {
  await page.goto("/@test_host");
  await expect(page.getByRole("heading", { name: "Pick the next conversation" })).toBeVisible();
  const forged = await request.post("/api/streamers/test_host", {
    headers: {
      Origin: origin,
      "oai-authenticated-user-id": "owner",
      "oai-authenticated-user-email": "owner@example.test",
    },
    data: { action: "create", kind: "choice", title: "Forged poll", options: ["A", "B"], duration: 0 },
  });
  expect(forged.status()).toBe(401);
  const owner = await signedIn(browser, "owner");
  const crossSite = await owner.request.post("/api/streamers/test_host", {
    headers: { Origin: "https://example.test" },
    data: { action: "create", kind: "choice", title: "Cross-site poll", options: ["A", "B"], duration: 0 },
  });
  expect(crossSite.status()).toBe(403);
  const viewer = await signedIn(browser, "viewer");
  const unauthorized = await viewer.request.post("/api/streamers/test_host", {
    headers: { Origin: origin },
    data: { action: "create", kind: "binary", title: "Viewer poll", duration: 0 },
  });
  expect(unauthorized.status()).toBe(403);
  const me = await owner.request.get("/api/me");
  const identity = (await me.json()) as { viewer: Record<string, unknown> };
  expect(Object.keys(identity.viewer).sort()).toEqual([
    "avatar",
    "avatarPreset",
    "displayPrefs",
    "id",
    "locale",
    "name",
  ]);
  expect(me.headers()["cache-control"]).toBe("no-store");
  expect(me.headers()["x-content-type-options"]).toBe("nosniff");
  await owner.close();
  await viewer.close();
});

test("viewer topics, reactions, replies, and comment likes survive reload", async ({ browser }, testInfo) => {
  const context = await signedIn(browser, "viewer");
  const page = await context.newPage();
  await assertNoScriptErrors(page, async () => {
    await page.goto("/@test_host");
    await page.getByRole("button", { name: "Suggest a topic", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Title", { exact: true }).fill("How should we build a quiet PC?");
    await dialog.getByLabel("Details").fill("Compare cooling and fan speeds. <img src=x onerror=alert(1)>");
    await dialog.getByRole("button", { name: "Submit topic" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "How should we build a quiet PC?" })).toBeVisible();
    await page.getByRole("button", { name: /^Like 0$/ }).click();
    await expect(page.getByRole("button", { name: /^Like 1$/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("textbox", { name: "Write a comment" }).fill("Large fans make a difference.");
    await page.getByRole("button", { name: "Post", exact: true }).click();
    const comment = page.locator("article.comment").filter({ hasText: "Large fans make a difference." });
    await expect(comment).toBeVisible();
    await comment.getByRole("button", { name: "Like comment by viewer" }).click();
    await expect(comment.getByRole("button", { name: "Like comment by viewer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await comment.getByRole("button", { name: "Reply", exact: true }).click();
    const replyBox = page.locator(".inline-reply");
    await replyBox.getByRole("textbox", { name: "Write a reply to viewer" }).fill("A larger case can also help.");
    await replyBox.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByText("A larger case can also help.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "How should we build a quiet PC?" })).toBeVisible();
    await expect(page.getByText("A larger case can also help.", { exact: true })).toBeVisible();
    await expect(comment.getByRole("button", { name: "Like comment by viewer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(
      page.getByText("Compare cooling and fan speeds. <img src=x onerror=alert(1)>", { exact: true }),
    ).toBeVisible();
  });
  await page.screenshot({ path: testInfo.outputPath("community-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("community-mobile.png") });
  await context.close();
});

test("streamer controls a binary poll and the public OBS overlay updates live", async ({ browser }, testInfo) => {
  const ownerContext = await signedIn(browser, "owner");
  const viewerContext = await signedIn(browser, "viewer");
  const owner = await ownerContext.newPage();
  await owner.goto("/@test_host?view=polls");
  await owner.getByRole("button", { name: "Create poll", exact: true }).click();
  const dialog = owner.getByRole("dialog");
  await dialog.getByLabel("Question", { exact: true }).fill("Should we stream on Friday?");
  await dialog.getByRole("radio", { name: "Yes / No" }).check();
  await dialog.getByRole("combobox", { name: "Voting time" }).click();
  await owner.getByRole("option", { name: "Unlimited — until I end it" }).click();
  await dialog.getByRole("button", { name: "Start poll" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(owner).toHaveURL(/entry=/);
  const pollId: string | null = new URL(owner.url()).searchParams.get("entry");
  if (!pollId) throw new Error("Created poll link is missing.");
  const viewer = await viewerContext.newPage();
  await viewer.goto(`/@test_host?view=polls&entry=${pollId}`);
  await expect(viewer.getByRole("button", { name: "Create poll", exact: true })).toHaveCount(0);
  const overlayContext = await browser.newContext({ baseURL: origin });
  const overlay = await overlayContext.newPage();
  await overlay.goto(`/@test_host/overlay?poll=${pollId}`);
  await expect(overlay.getByRole("heading", { name: "Should we stream on Friday?" })).toBeVisible();
  await viewer.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(overlay.locator(".overlay-total")).toContainText("1 vote");
  await expect(overlay.locator(".option-score")).toHaveCount(0);
  await viewer.getByRole("button", { name: "No", exact: true }).click();
  await expect(viewer.getByRole("button", { name: "✓ No", exact: true })).toHaveAttribute("aria-pressed", "true");
  const snapshot = await viewerContext.request.get(`/api/entries/${pollId}`);
  const before = (await snapshot.json()) as { entry: { counts: number[] | null; total: number } };
  expect(before.entry.counts).toBeNull();
  expect(before.entry.total).toBe(1);
  const otherOwner = await signedIn(browser, "otherowner");
  const scopeAttack = await otherOwner.request.post("/api/streamers/other_host", {
    headers: { Origin: origin },
    data: { action: "reveal", id: pollId },
  });
  expect(scopeAttack.status()).toBe(404);
  await owner.getByRole("button", { name: "End & reveal", exact: true }).click();
  await expect(overlay.getByText("Results revealed", { exact: true })).toBeVisible();
  await expect(overlay.locator(".option-score")).toHaveText(["0 votes0%", "1 vote100%"]);
  const closedVote = await viewerContext.request.post("/api/streamers/test_host", {
    headers: { Origin: origin },
    data: { action: "vote", id: pollId, choice: 0 },
  });
  expect(closedVote.status()).toBe(409);
  await overlay.reload();
  await expect(overlay.getByText("Results revealed", { exact: true })).toBeVisible();
  await expect(overlay.getByRole("button", { name: /^(Yes|No)$/ })).toHaveCount(0);
  await overlay.screenshot({ path: testInfo.outputPath("poll-overlay.png") });
  await otherOwner.close();
  await ownerContext.close();
  await viewerContext.close();
  await overlayContext.close();
});

test("a viewer joins the waitlist, an admin approves, and the viewer creates a streamer page", async ({ browser }) => {
  const context = await signedIn(browser, "newcomer");
  const page = await context.newPage();
  await page.goto("/streamers");
  await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Host a community", exact: true }).click();
  const host = page.getByRole("dialog", { name: "Host a community" });
  await expect(host.getByText("Hosting a community is invite-only for now.", { exact: false })).toBeVisible();
  await expect(host.getByRole("button", { name: "Create your community page" })).toHaveCount(0);
  const blocked = await context.request.post("/api/streamer", {
    headers: { Origin: origin },
    data: { handle: "early_host", name: "Too early", about: "" },
  });
  expect(blocked.status()).toBe(403);
  await host.getByLabel("Channel link 1", { exact: true }).fill("https://www.twitch.tv/new_host");
  await host.getByRole("button", { name: "Add another link" }).click();
  await expect(host.getByLabel("Channel link 2", { exact: true })).toBeFocused();
  await host.getByLabel("Channel link 2", { exact: true }).fill("https://example.test/not-needed");
  await host.getByRole("button", { name: "Add another link" }).click();
  await host.getByLabel("Channel link 3", { exact: true }).fill("https://www.youtube.com/@newhost");
  await host.getByRole("button", { name: "Remove channel link 2" }).click();
  await expect(host.getByLabel("Channel link 3", { exact: true })).toHaveCount(0);
  await expect(host.getByLabel("Channel link 2", { exact: true })).toHaveValue("https://www.youtube.com/@newhost");
  await host.getByLabel("Anything else we should know? (optional)").fill("I stream games and tech twice a week.");
  await host.getByRole("button", { name: "Request to host" }).click();
  await expect(page.getByText("Request sent. We'll let you know.").first()).toBeVisible();
  await expect(host.getByText("We'll review your request.", { exact: false })).toBeVisible();
  await page.reload();
  await expect(host.getByText("Request received.")).toBeVisible();
  await expect(host.getByLabel("Channel link 1", { exact: true })).toHaveValue("https://www.twitch.tv/new_host");
  await expect(host.getByLabel("Channel link 2", { exact: true })).toHaveValue("https://www.youtube.com/@newhost");
  await expect(host.getByRole("button", { name: "Update request" })).toBeVisible();

  const adminContext = await signedIn(browser, "admin");
  const admin = await adminContext.newPage();
  await assertNoScriptErrors(admin, async () => {
    await admin.goto("/streamers");
    await admin.getByRole("link", { name: "Admin", exact: true }).click();
    await expect(admin).toHaveURL(/\/admin$/);
    await expect(admin.getByRole("heading", { name: "Streamer requests" })).toBeVisible();
    await expect(admin.getByRole("link", { name: "Pending" })).toHaveAttribute("aria-current", "page");
    const request = admin.getByRole("article", { name: "newcomer" });
    await expect(request).toContainText("newcomer@example.test");
    await expect(request).toContainText("I stream games and tech twice a week.");
    const channel = request.getByRole("link", { name: /twitch\.tv/ });
    await expect(channel).toHaveAttribute("href", "https://www.twitch.tv/new_host");
    await expect(channel).toHaveAttribute("target", "_blank");
    await expect(channel).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await expect(request.getByRole("link", { name: /youtube\.com/ })).toBeVisible();
    await request.getByRole("button", { name: "Approve newcomer" }).click();
    await expect(admin.getByRole("status")).toHaveText("Approved newcomer.");
    await expect(admin.getByRole("article", { name: "newcomer" })).toHaveCount(0);
    await admin.getByRole("link", { name: "Approved" }).click();
    await expect(admin).toHaveURL(/status=approved/);
    await expect(admin.getByRole("article", { name: "newcomer" })).toBeVisible();
    await expect(admin.getByRole("button", { name: "Approve newcomer" })).toHaveCount(0);
  });
  await adminContext.close();

  await page.reload();
  await expect(host.getByText("You're approved to host a community.", { exact: false })).toBeVisible();
  await host.getByLabel("Handle", { exact: true }).fill("new_host");
  await host.getByLabel("Streamer name", { exact: true }).fill("New community");
  await host.getByLabel("About your stream").fill("Games and technology.");
  await host.getByRole("button", { name: "Create your community page" }).click();
  await expect(page.getByText("Your page /@new_host is live.").first()).toBeVisible();
  await expect(host).toBeHidden();
  // Edit your page: a page background, saved with the page.
  await page.goto("/streamers?dialog=page");
  const edit = page.getByRole("dialog", { name: "Edit your page" });
  await edit
    .getByLabel("Background image")
    .setInputFiles({ name: "background.png", mimeType: "image/png", buffer: png });
  await edit.getByRole("button", { name: "Save page" }).click();
  await expect(page.getByText("Streamer page saved.").first()).toBeVisible();
  const avatar = await context.request.put("/api/images/avatar", {
    headers: { Origin: origin, "Content-Type": "image/png" },
    data: png,
  });
  expect(avatar.status()).toBe(200);
  await page.getByRole("link", { name: "Your page", exact: true }).first().click();
  await expect(page.getByText("New community · Suggest topics. Vote. Chat.")).toBeVisible();
  const profile = await context.request.get("/api/me");
  const identity = (await profile.json()) as { viewer: { avatar: string }; streamer: { background: string } };
  const image = await context.request.get(identity.viewer.avatar);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toBe("image/png");
  expect(await image.body()).toEqual(png);
  const rejected = await context.request.put("/api/images/avatar", {
    headers: { Origin: origin, "Content-Type": "image/svg+xml" },
    data: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
  });
  expect(rejected.status()).toBe(415);
  await page.getByRole("button", { name: "Suggest a topic", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Suggest a topic", exact: true })).toBeFocused();
  // On a phone the owner's empty list offers the page link instead of the header action.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Copy page link" })).toBeVisible();
  await context.close();
});

test("only administrators can open the review queue and its API", async ({ browser, page, request }) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  const anonymous = await request.get("/api/admin/applications");
  expect(anonymous.status()).toBe(401);
  const context = await signedIn(browser, "viewer");
  const viewer = await context.newPage();
  const response = await viewer.goto("/admin");
  expect(response?.status()).toBe(404);
  await expect(viewer.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(viewer.getByText("newcomer@example.test")).toHaveCount(0);
  await viewer.goto("/streamers");
  await expect(viewer.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
  for (const status of ["pending", "approved", "rejected"]) {
    const list = await context.request.get(`/api/admin/applications?status=${status}`);
    expect(list.status()).toBe(403);
  }
  const review = await context.request.post("/api/admin/applications", {
    headers: { Origin: origin },
    data: { id: "00000000-0000-4000-8000-000000000000", decision: "approved" },
  });
  expect(review.status()).toBe(403);
  const me = (await (await context.request.get("/api/me")).json()) as { access: { admin: boolean } };
  expect(me.access.admin).toBe(false);
  await context.close();
});

test("a viewer reports a topic and an admin removes it", async ({ browser, page, request }) => {
  const title = "Buy followers cheap at example.test";
  const owner = await signedIn(browser, "owner");
  const created = await owner.request.post("/api/streamers/test_host", {
    headers: { Origin: origin },
    data: { action: "create", kind: "topic", title, body: "Limited offer, click now.", category: "Just chatting" },
  });
  expect(created.status()).toBe(200);
  const { id } = (await created.json()) as { id: string };
  const ownerPage = await owner.newPage();
  await ownerPage.goto(`/@test_host?entry=${id}`);
  await expect(ownerPage.getByRole("heading", { name: title })).toBeVisible();
  await expect(ownerPage.getByRole("button", { name: "Report topic" })).toHaveCount(0);
  await owner.close();

  await page.goto(`/@test_host?entry=${id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Report/ })).toHaveCount(0);
  const anonymous = await request.post("/api/reports", {
    headers: { Origin: origin },
    data: { targetKind: "entry", targetId: id, reason: "spam" },
  });
  expect(anonymous.status()).toBe(401);

  const viewerContext = await signedIn(browser, "reporter");
  const viewer = await viewerContext.newPage();
  await assertNoScriptErrors(viewer, async () => {
    await viewer.goto(`/@test_host?entry=${id}`);
    await viewer.getByRole("button", { name: "Report topic" }).click();
    const dialog = viewer.getByRole("dialog", { name: "Report content" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: /Illegal content/ }).check();
    await expect(dialog.getByRole("button", { name: "Send report" })).toBeDisabled();
    await dialog.getByRole("radio", { name: /Spam or scam/ }).check();
    await dialog.getByLabel(/^Details/).fill("Advertising unrelated to the stream.");
    await dialog.getByRole("button", { name: "Send report" }).click();
    await expect(viewer.getByRole("dialog", { name: "Report sent" })).toBeVisible();
    await viewer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(viewer.getByRole("dialog")).toHaveCount(0);
    // Once reported, one "Reported" marker replaces the button.
    await expect(viewer.getByRole("button", { name: "Report topic" })).toHaveCount(0);
    await expect(viewer.locator(".content-actions .reported-chip")).toHaveText("Reported");
  });
  const forbidden = await viewerContext.request.get("/api/admin/reports");
  expect(forbidden.status()).toBe(403);
  const forbiddenResolve = await viewerContext.request.post("/api/admin/reports", {
    headers: { Origin: origin },
    data: { id: "00000000-0000-4000-8000-000000000000", action: "remove" },
  });
  expect(forbiddenResolve.status()).toBe(403);

  const adminContext = await signedIn(browser, "admin");
  const admin = await adminContext.newPage();
  await assertNoScriptErrors(admin, async () => {
    await admin.goto("/admin");
    await admin
      .getByRole("navigation", { name: "Admin sections" })
      .getByRole("link", { name: "Content reports" })
      .click();
    await expect(admin).toHaveURL(/view=reports/);
    await expect(admin.getByRole("heading", { name: /Content reports/ })).toBeVisible();
    await expect(admin.getByRole("link", { name: "Open", exact: true })).toHaveAttribute("aria-current", "page");
    // Reports are grouped by page, then by reported item.
    const group = admin.getByRole("article", { name: "Test host" });
    await group.getByRole("button", { name: /Show \d+ reported items?/ }).click();
    const item = group.getByRole("listitem").filter({ hasText: "Limited offer, click now." });
    await expect(item).toContainText("Reported by 1 person");
    await expect(item).toContainText("reporter (Spam)");
    await expect(item).toContainText("Advertising unrelated to the stream.");
    await expect(item.getByRole("link", { name: "Open in context" })).toHaveAttribute(
      "href",
      `/@test_host?entry=${id}`,
    );
    await item.getByRole("button", { name: "Remove content" }).click();
    const confirm = admin.getByRole("dialog", { name: "Remove this content?" });
    await confirm.getByRole("button", { name: "Remove content" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "removed" })).toHaveText(
      "Content removed and its reports closed.",
    );
    await expect(admin.getByRole("listitem").filter({ hasText: "Limited offer, click now." })).toHaveCount(0);
    await admin.getByRole("link", { name: "Resolved", exact: true }).click();
    await expect(admin).toHaveURL(/status=resolved/);
    const resolved = admin.getByRole("article", { name: "Test host" });
    await resolved.getByRole("button", { name: /Show \d+ reported items?/ }).click();
    const removed = resolved.getByRole("listitem").filter({ hasText: "Limited offer, click now." });
    await expect(removed.locator(".resolved-line")).toContainText("Removed");
    await expect(removed.getByRole("button")).toHaveCount(0);
  });
  await adminContext.close();

  await viewer.goto("/@test_host?view=topics&sort=newest");
  await expect(viewer.getByRole("heading", { name: "Pick the next conversation" })).toBeVisible();
  await expect(viewer.getByText(title)).toHaveCount(0);
  const gone = await viewerContext.request.get(`/api/entries/${id}`);
  expect(gone.status()).toBe(404);
  await viewerContext.close();
});

test("topic panes and the resize control remain keyboard accessible", async ({ page }) => {
  await page.goto("/@pagination_host");
  const topics = page.getByRole("region", { name: "Scrollable topic list" });
  await topics.focus();
  await page.keyboard.press("PageDown");
  await expect.poll(() => topics.evaluate((element: HTMLElement) => element.scrollTop)).toBeGreaterThan(0);
  const splitter = page.getByRole("slider", { name: "Resize topic panels" });
  await splitter.focus();
  await page.keyboard.press("ArrowRight");
  await expect(splitter).toHaveValue("42");
  await page.keyboard.press("ArrowLeft");
  await expect(splitter).toHaveValue("40");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("region", { name: "Selected topic" })).toBeFocused();
  const workspace = page.locator(".topic-workspace");
  const bounds = await workspace.boundingBox();
  const handle = await splitter.boundingBox();
  if (!bounds || !handle) throw new Error("Topic workspace and resize control must be visible.");
  const handleY: number = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, handleY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.55, handleY);
  await page.mouse.up();
  await expect.poll(async () => Number(await splitter.inputValue())).toBeCloseTo(55, 0);
  await splitter.dblclick();
  await expect(splitter).toHaveValue("40");
});
