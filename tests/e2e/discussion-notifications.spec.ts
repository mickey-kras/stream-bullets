import { randomUUID } from "node:crypto";
import { z } from "zod";
import { close, expect, newPage, test, type BrowserContext } from "./coverage";
import { accounts, runSql, signedIn } from "./fixtures";
import { clientIp } from "./client-ips";

const mutationSchema = z.object({ id: z.string().uuid() });
const inboxSchema = z.object({
  notifications: z.array(z.object({ id: z.string(), commentId: z.string(), kind: z.enum(["reply", "mention"]), read: z.boolean() })),
});

async function inbox(context: BrowserContext, commentId: string): Promise<z.infer<typeof inboxSchema>["notifications"]> {
  const response = await context.request.get("/api/notifications");
  expect(response.ok()).toBe(true);
  return inboxSchema.parse(await response.json()).notifications.filter((item) => item.commentId === commentId);
}

async function post(context: BrowserContext, entryId: string, text: string, parentId: string | null = null): Promise<string> {
  const response = await context.request.post("/api/streamers/test_host", {
    data: { action: "comment", id: entryId, text, parentId },
  });
  expect(response.ok()).toBe(true);
  return mutationSchema.parse(await response.json()).id;
}

async function seedEntry(name: string, viewerId: string): Promise<string> {
  const id: string = randomUUID();
  await runSql(`notifications-${name}`, [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,created_at) SELECT '${id}',id,'${viewerId}','topic','Notification lifecycle ${name}','A conversation to follow.','Just chatting',${Date.now()} FROM streamers WHERE handle='test_host';`,
  ]);
  return id;
}

test("keyboard mentions, own comment edits, historical reply links and persistent notification preferences", async ({ browser }) => {
  test.setTimeout(90_000);
  const users = await accounts();
  const entryId: string = await seedEntry("keyboard", users.viewer.id);
  const viewer = await signedIn(browser, "viewer", clientIp("discussion-notifications", 164));
  const owner = await signedIn(browser, "owner", clientIp("discussion-notifications", 165));
  try {
    const page = await newPage(viewer);
    const ownerPage = await newPage(owner);
    await page.goto(`/@test_host?view=topics&entry=${entryId}`);
    const composer = page.getByRole("textbox", { name: "Write a comment", exact: true });
    await composer.fill("Hello @test_host");
    await expect(page.getByRole("option")).toContainText("@test_host");
    await composer.press("Enter");
    await expect(composer).toHaveValue("Hello @owner ");
    await composer.press("End");
    await composer.pressSequentially("please check this thread.");
    const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/streamers/test_host"));
    await page.getByRole("button", { name: "Post", exact: true }).click();
    const rootId: string = mutationSchema.parse(await (await created).json()).id;
    const root = page.locator(`#cm-${rootId}`);
    await expect(root).toContainText("Hello @owner please check this thread.");
    expect(await inbox(owner, rootId)).toHaveLength(1);

    await root.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = root.getByRole("textbox", { name: "Edit comment", exact: true });
    await editor.fill("Hello @owner please check this edited thread.");
    await root.getByRole("button", { name: "Save", exact: true }).click();
    await expect(root).toContainText("Edited");
    await expect(root).toContainText("Hello @owner please check this edited thread.");
    expect(await inbox(owner, rootId)).toHaveLength(1);

    await ownerPage.goto("/notifications");
    await ownerPage.reload();
    const mention = ownerPage.locator(".notification-item").filter({ has: ownerPage.getByRole("link", { name: /viewer mentioned you/ }) }).first();
    await expect(mention).toHaveAttribute("data-unread", "true");
    await mention.getByRole("button", { name: "Mark read", exact: true }).click();
    await expect(mention).toHaveAttribute("data-unread", "false");
    await mention.getByRole("button", { name: "Mark unread", exact: true }).click();
    await expect(mention).toHaveAttribute("data-unread", "true");
    await ownerPage.reload();
    await expect(mention).toHaveAttribute("data-unread", "true");
    await mention.getByRole("link").click();
    await expect(ownerPage).toHaveURL(new RegExp(`comment=${rootId}`));
    await expect(ownerPage.locator(`#cm-${rootId}`)).toBeVisible();
    expect((await inbox(owner, rootId))[0]?.read).toBe(true);

    await runSql("notifications-historical-replies", [
      ...[0, 1].map((index: number) => `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at,parent_id) VALUES ('${randomUUID()}','${entryId}','${users.reporter.id}','Earlier reply ${index}',${Date.now() + index},'${rootId}');`),
    ]);
    const replyText = "@viewer a reply and mention are one event.";
    const replyResponse = await owner.request.post("/api/streamers/test_host", {
      data: { action: "comment", id: entryId, text: replyText, parentId: rootId, mentions: [{ userId: users.viewer.id, start: 0, end: 7 }] },
    });
    expect(replyResponse.ok()).toBe(true);
    const replyId: string = mutationSchema.parse(await replyResponse.json()).id;
    const notifications = await inbox(viewer, replyId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.kind).toBe("reply");
    expect(await inbox(owner, replyId)).toHaveLength(0);
    await ownerPage.goto(`/@test_host?entry=${entryId}&comment=${replyId}`);
    const reply = ownerPage.locator(`#cm-${replyId}`);
    await reply.getByRole("button", { name: "Edit", exact: true }).click();
    await reply.getByRole("textbox", { name: "Edit comment", exact: true }).fill("@viewer this reply was edited.");
    await reply.getByRole("button", { name: "Save", exact: true }).click();
    await expect(reply).toContainText("Edited");
    await expect(reply.locator(".reply-mention")).toHaveAttribute("href", `#cm-${rootId}`);
    expect(await inbox(viewer, replyId)).toHaveLength(1);

    await runSql("notifications-historical-roots", Array.from({ length: 105 }, (_, index: number) =>
      `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at) VALUES ('${randomUUID()}','${entryId}','${users.reporter.id}','Newer root ${index}',${Date.now() + index + 1000});`,
    ));
    await page.goto("/notifications");
    await page.reload();
    const replyNotice = page.locator(".notification-item").filter({ has: page.getByRole("link", { name: /owner replied to your comment/ }) }).first();
    await replyNotice.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`comment=${replyId}`));
    await expect(page.locator(`#cm-${replyId}`)).toBeVisible();
    await expect(page.locator(`#cm-${replyId}`)).toContainText("@viewer this reply was edited.");

    await page.goto("/notifications");
    await page.getByRole("checkbox", { name: "Replies to my comments", exact: true }).uncheck();
    await page.getByRole("checkbox", { name: "Mentions", exact: true }).uncheck();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Notification preferences saved." })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Replies to my comments", exact: true })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Mentions", exact: true })).not.toBeChecked();
    const mutedReply: string = await post(owner, entryId, "This reply follows your saved preferences.", rootId);
    expect(await inbox(viewer, mutedReply)).toHaveLength(0);
  } finally {
    await Promise.all([close(viewer), close(owner)]);
    await runSql("notifications-keyboard-cleanup", [
      `DELETE FROM entries WHERE id='${entryId}';`,
      `DELETE FROM notification_preferences WHERE user_id='${users.viewer.id}';`,
    ]);
  }
});

test("touch selects a stable account mention and notifications survive a new visit", async ({ browser }) => {
  const users = await accounts();
  const entryId: string = await seedEntry("touch", users.viewer.id);
  const viewer = await signedIn(browser, "viewer", clientIp("discussion-notifications", 166), {
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  const owner = await signedIn(browser, "owner", clientIp("discussion-notifications", 167));
  try {
    const page = await newPage(viewer);
    await page.goto(`/@test_host?entry=${entryId}&discussion=1`);
    const composer = page.getByRole("textbox", { name: "Write a comment", exact: true });
    await composer.fill("Touch mention @test_host");
    await page.getByRole("option").tap();
    await expect(composer).toHaveValue("Touch mention @owner ");
    const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/streamers/test_host"));
    await page.getByRole("button", { name: "Post", exact: true }).tap();
    const commentId: string = mutationSchema.parse(await (await created).json()).id;
    expect(await inbox(owner, commentId)).toHaveLength(1);
    const ownerPage = await newPage(owner);
    await ownerPage.goto("/streamers");
    await ownerPage.getByRole("link", { name: /unread notifications/ }).click();
    const notice = ownerPage.locator(`.notification-link[href*="comment=${commentId}"]`);
    await expect(notice).toContainText("viewer mentioned you");
    await notice.click();
    await expect(ownerPage.locator(`#cm-${commentId}`)).toBeVisible();
  } finally {
    await Promise.all([close(viewer), close(owner)]);
    await runSql("notifications-touch-cleanup", [`DELETE FROM entries WHERE id='${entryId}';`]);
  }
});
