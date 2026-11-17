import { randomUUID } from "node:crypto";
import { z } from "zod";
import { close, expect, newPage, test, type BrowserContext } from "./coverage";
import { accounts, runSql, signedIn } from "./fixtures";
import { clientIp } from "./client-ips";

const mutationSchema = z.object({ id: z.string().uuid() });
const inboxSchema = z.object({
  notifications: z.array(
    z.object({ id: z.string(), commentId: z.string(), kind: z.enum(["reply", "mention"]), read: z.boolean() }),
  ),
});

async function inbox(
  context: BrowserContext,
  commentId: string,
): Promise<z.infer<typeof inboxSchema>["notifications"]> {
  const response = await context.request.get("/api/notifications");
  expect(response.ok()).toBe(true);
  return inboxSchema.parse(await response.json()).notifications.filter((item) => item.commentId === commentId);
}

async function post(
  context: BrowserContext,
  entryId: string,
  text: string,
  parentId: string | null = null,
): Promise<string> {
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

test("keyboard mentions, own comment edits, historical reply links and persistent notification preferences", async ({
  browser,
}) => {
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
    await expect(page.locator(".mention-option")).toContainText("@test_host");
    await composer.press("Enter");
    await expect(composer).toHaveValue("Hello @owner ");
    await composer.press("End");
    await composer.pressSequentially("please check this thread.");
    const created = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/api/streamers/test_host"),
    );
    await page.getByRole("button", { name: "Post", exact: true }).click();
    const rootId: string = mutationSchema.parse(await (await created).json()).id;
    const root = page.locator(`#cm-${rootId}`);
    await expect(root).toContainText("Hello @owner please check this thread.");
    expect(await inbox(owner, rootId)).toHaveLength(1);

    await root.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = root.getByRole("textbox", { name: "Edit comment", exact: true });
    await editor.press("End");
    await editor.pressSequentially(" Please confirm.");
    await root.getByRole("button", { name: "Save", exact: true }).click();
    await expect(root.getByText("Edited", { exact: true })).toBeVisible();
    await expect(root).toContainText("Hello @owner please check this thread. Please confirm.");
    expect(await inbox(owner, rootId)).toHaveLength(1);

    await ownerPage.goto("/notifications");
    await ownerPage.reload();
    const mention = ownerPage
      .locator(".notification-item")
      .filter({ has: ownerPage.getByRole("link", { name: /viewer mentioned you/ }) })
      .first();
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
      ...[0, 1].map(
        (index: number) =>
          `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at,parent_id) VALUES ('${randomUUID()}','${entryId}','${users.reporter.id}','Earlier reply ${index}',${Date.now() + index},'${rootId}');`,
      ),
    ]);
    const replyText = "@viewer a reply and mention are one event.";
    const replyResponse = await owner.request.post("/api/streamers/test_host", {
      data: {
        action: "comment",
        id: entryId,
        text: replyText,
        parentId: rootId,
        mentions: [{ userId: users.viewer.id, start: 0, end: 7 }],
      },
    });
    expect(replyResponse.ok()).toBe(true);
    const replyId: string = mutationSchema.parse(await replyResponse.json()).id;
    const notifications = await inbox(viewer, replyId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.kind).toBe("reply");
    expect(await inbox(owner, replyId)).toHaveLength(0);
    await ownerPage.goto(`/@test_host?entry=${entryId}&comment=${replyId}`);
    const reply = ownerPage.locator(`#cm-${replyId}`);
    const thread = ownerPage.locator("li.thread").filter({ has: ownerPage.locator(`#cm-${rootId}`) });
    await thread.locator(".thread-toggle").click();
    await expect(reply).not.toBeVisible();
    await ownerPage.locator(`#cm-${rootId}`).getByRole("button", { name: "Reply", exact: true }).click();
    await expect(thread.getByRole("textbox", { name: "Write a reply to viewer", exact: true })).toBeVisible();
    await thread.locator(".thread-toggle").click();
    await ownerPage.locator(`#cm-${rootId}`).getByRole("button", { name: "Reply", exact: true }).click();
    await expect(thread.getByRole("textbox", { name: "Write a reply to viewer", exact: true })).toBeVisible();
    await thread.getByRole("button", { name: "Cancel reply", exact: true }).click();
    await reply.getByRole("button", { name: "Edit", exact: true }).click();
    const replyEditor = reply.getByRole("textbox", { name: "Edit comment", exact: true });
    await replyEditor.press("End");
    await replyEditor.pressSequentially(" Please confirm.");
    await reply.getByRole("button", { name: "Save", exact: true }).click();
    await expect(reply.getByText("Edited", { exact: true })).toBeVisible();
    await expect(reply.locator(".reply-mention")).toHaveAttribute("href", `#cm-${rootId}`);
    expect(await inbox(viewer, replyId)).toHaveLength(1);

    await runSql(
      "notifications-historical-roots",
      Array.from(
        { length: 105 },
        (_, index: number) =>
          `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at) VALUES ('${randomUUID()}','${entryId}','${users.reporter.id}','Newer root ${index}',${Date.now() + index + 1000});`,
      ),
    );
    await page.goto("/notifications");
    await page.reload();
    const replyNotice = page
      .locator(".notification-item")
      .filter({ has: page.getByRole("link", { name: /owner replied to your comment/ }) })
      .first();
    await replyNotice.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`comment=${replyId}`));
    await expect(page.locator(`#cm-${replyId}`)).toBeVisible();
    await expect(page.locator(`#cm-${replyId}`)).toContainText(
      "@viewer a reply and mention are one event. Please confirm.",
    );

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
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const owner = await signedIn(browser, "owner", clientIp("discussion-notifications", 167));
  try {
    const page = await newPage(viewer);
    await page.goto(`/@test_host?entry=${entryId}&discussion=1`);
    const composer = page.getByRole("textbox", { name: "Write a comment", exact: true });
    await composer.fill("Touch mention @test_host");
    await page.locator(".mention-option").tap();
    await expect(composer).toHaveValue("Touch mention @owner ");
    const created = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/api/streamers/test_host"),
    );
    await page.getByRole("button", { name: "Post", exact: true }).tap();
    const commentId: string = mutationSchema.parse(await (await created).json()).id;
    expect(await inbox(owner, commentId)).toHaveLength(1);
    const ownerPage = await newPage(owner);
    await ownerPage.goto("/streamers");
    await ownerPage.getByRole("link", { name: /Unread notifications:/ }).click();
    const notice = ownerPage.locator(`.notification-link[href*="comment=${commentId}"]`);
    await expect(notice).toContainText("viewer mentioned you");
    await notice.click();
    await expect(ownerPage.locator(`#cm-${commentId}`)).toBeVisible();
  } finally {
    await Promise.all([close(viewer), close(owner)]);
    await runSql("notifications-touch-cleanup", [`DELETE FROM entries WHERE id='${entryId}';`]);
  }
});

test("duplicate names retain the selected account through draft reload, rename, edit and undo", async ({ browser }) => {
  test.setTimeout(90_000);
  const users = await accounts();
  const entryId: string = await seedEntry("identity", users.viewer.id);
  const candidates = [
    { role: "reporter", id: users.reporter.id },
    { role: "newcomer", id: users.newcomer.id },
  ].sort((left, right) => left.id.localeCompare(right.id));
  const selected = candidates[1];
  const other = candidates[0];
  const viewer = await signedIn(browser, "viewer", clientIp("discussion-notifications", 168));
  const recipient = await signedIn(browser, selected.role, clientIp("discussion-notifications", 169));
  const unselected = await signedIn(browser, other.role, clientIp("discussion-notifications", 169));
  try {
    await runSql("notifications-duplicate-names", [
      `DELETE FROM app_rate_limits WHERE key IN ('content:${users.viewer.id}','write:${users.viewer.id}');`,
      ...candidates.flatMap((candidate) => [
        `UPDATE user SET name='Shared participant' WHERE id='${candidate.id}';`,
        `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at) VALUES ('${randomUUID()}','${entryId}','${candidate.id}','Public participant comment',${Date.now()});`,
      ]),
    ]);
    const page = await newPage(viewer);
    await page.goto(`/@test_host?entry=${entryId}`);
    const composer = page.getByRole("textbox", { name: "Write a comment", exact: true });
    await composer.fill("Identity @Shared participant");
    const suggestions = page.locator(".mention-option");
    await expect(suggestions).toHaveCount(2);
    await expect(suggestions.locator(".mention-label")).toHaveText(candidates.map((candidate) => candidate.id));
    await suggestions.filter({ hasText: selected.id }).click();
    await expect(composer).toHaveValue("Identity @Shared participant ");
    await page.reload();
    await expect(composer).toHaveValue("Identity @Shared participant ");
    await composer.press("End");
    await composer.pressSequentially("please reply.");
    const created = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/api/streamers/test_host"),
    );
    await page.getByRole("button", { name: "Post", exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.ok()).toBe(true);
    const commentId: string = mutationSchema.parse(await createdResponse.json()).id;
    expect(await inbox(recipient, commentId)).toHaveLength(1);
    expect(await inbox(unselected, commentId)).toHaveLength(0);

    await runSql("notifications-rename-recipient", [
      `UPDATE user SET name='Renamed participant' WHERE id='${selected.id}';`,
    ]);
    await page.reload();
    const comment = page.locator(`#cm-${commentId}`);
    await comment.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = comment.getByRole("textbox", { name: "Edit comment", exact: true });
    const originalText: string = "Identity @Shared participant please reply.";
    await expect(editor).toHaveValue(originalText);
    await editor.press("End");
    await editor.pressSequentially("!".repeat(100));
    await expect(editor).toHaveValue(`${originalText}${"!".repeat(100)}`);
    for (let count = 0; count < 100 && (await editor.inputValue()) !== originalText; count++) {
      await editor.press("Control+z");
    }
    await expect(editor).toHaveValue(originalText);
    for (let count = 0; count < 100 && (await editor.inputValue()) !== `${originalText}${"!".repeat(100)}`; count++) {
      await editor.press("Control+Shift+z");
    }
    await expect(editor).toHaveValue(`${originalText}${"!".repeat(100)}`);
    await comment.getByRole("button", { name: "Save", exact: true }).click();
    await expect(comment.getByText("Edited", { exact: true })).toBeVisible();
    await expect(comment.locator(".comment-text")).toHaveText(`${originalText}${"!".repeat(100)}`);
    const persisted = await viewer.request.get(`/api/comments/${commentId}`);
    expect(persisted.ok()).toBe(true);
    const result = z
      .object({
        comment: z.object({ mentions: z.array(z.object({ userId: z.string(), start: z.number(), end: z.number() })) }),
      })
      .parse(await persisted.json());
    expect(result.comment.mentions).toEqual([{ userId: selected.id, start: 9, end: 28 }]);
    expect(await inbox(recipient, commentId)).toHaveLength(1);
    expect(await inbox(unselected, commentId)).toHaveLength(0);
  } finally {
    await Promise.all([close(viewer), close(recipient), close(unselected)]);
    await runSql("notifications-identity-cleanup", [
      `DELETE FROM entries WHERE id='${entryId}';`,
      `UPDATE user SET name='reporter' WHERE id='${users.reporter.id}';`,
      `UPDATE user SET name='newcomer' WHERE id='${users.newcomer.id}';`,
    ]);
  }
});

test("notification refresh, pagination and failed writes preserve the inbox for retry", async ({ browser }) => {
  const users = await accounts();
  const entryId: string = await seedEntry("recovery", users.newcomer.id);
  const commentIds: string[] = Array.from({ length: 51 }, (): string => randomUUID());
  const now: number = Date.now() + 60_000;
  await runSql("notifications-recovery", [
    `DELETE FROM app_rate_limits WHERE key IN ('content:${users.newcomer.id}','write:${users.newcomer.id}');`,
    ...commentIds.flatMap((id: string, index: number): string[] => [
      `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at) VALUES ('${id}','${entryId}','${users.reporter.id}','Inbox recovery ${index}',${now + index});`,
      `INSERT INTO notifications(id,user_id,actor_id,comment_id,kind,created_at) VALUES ('${randomUUID().replaceAll("-", "")}','${users.newcomer.id}','${users.reporter.id}','${id}','reply',${now + index});`,
    ]),
  ]);
  const context = await signedIn(browser, "newcomer", clientIp("discussion-notifications", 169));
  // This recovery case owns 203.0.113.100 to isolate its request quota.
  await context.setExtraHTTPHeaders({ Origin: "http://localhost:5173", "CF-Connecting-IP": "203.0.113.100" });
  try {
    const page = await newPage(context);
    await page.goto("/notifications");
    const notices = page.locator(".notification-item").filter({
      has: page.locator(`a[href*="entry=${entryId}"]`),
    });
    await expect(notices).toHaveCount(50);
    let failedAction: "load" | "read" | "preferences" | null = "load";
    await page.route("**/api/notifications**", async (route) => {
      const request = route.request();
      const action: string =
        request.method() === "GET" ? "load" : z.object({ action: z.string() }).parse(request.postDataJSON()).action;
      if (action === failedAction) {
        await route.fulfill({ status: 503, json: { error: "The request failed. Please try again." } });
        return;
      }
      await route.continue();
    });
    const alert = page.locator(".notifications-page .form-error");
    await page.getByRole("button", { name: "Refresh notifications", exact: true }).click();
    await expect(alert).toHaveText("The request failed. Please try again.");
    await expect(notices).toHaveCount(50);
    failedAction = null;
    await page.getByRole("button", { name: "Refresh notifications", exact: true }).click();
    await expect(alert).toBeEmpty();
    await expect(alert).toBeHidden();
    await page.getByRole("button", { name: "Load more notifications", exact: true }).click();
    await expect(notices).toHaveCount(51);
    const notice = notices.first();
    failedAction = "read";
    await notice.getByRole("button", { name: "Mark read", exact: true }).click();
    await expect(alert).toHaveText("The request failed. Please try again.");
    await expect(notice).toHaveAttribute("data-unread", "true");
    await notice.getByRole("link").click();
    await expect(alert).toHaveText("The request failed. Please try again.");
    await expect(page).toHaveURL(/\/notifications$/u);
    failedAction = null;
    await notice.getByRole("button", { name: "Mark read", exact: true }).click();
    await expect(notice).toHaveAttribute("data-unread", "false");
    const href: string | null = await notice.getByRole("link").getAttribute("href");
    if (!href) throw new Error("Missing notification target.");
    await notice.getByRole("link").click();
    await expect(page).toHaveURL(new URL(href, "http://localhost:5173").href);
    await page.goto("/notifications");
    const mentions = page.getByRole("checkbox", { name: "Mentions", exact: true });
    await mentions.uncheck();
    failedAction = "preferences";
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(alert).toHaveText("The request failed. Please try again.");
    await expect(mentions).not.toBeChecked();
    failedAction = null;
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Notification preferences saved." })).toBeVisible();
    await mentions.check();
    await expect(page.getByRole("status").filter({ hasText: "Notification preferences saved." })).toHaveCount(0);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.reload();
    await expect(mentions).toBeChecked();
  } finally {
    await close(context);
    await runSql("notifications-recovery-cleanup", [
      `DELETE FROM entries WHERE id='${entryId}';`,
      `DELETE FROM notification_preferences WHERE user_id='${users.newcomer.id}';`,
    ]);
  }
});

test("mention lookup recovers and keyboard edits keep only intact account selections", async ({ browser }) => {
  const users = await accounts();
  const entryId: string = await seedEntry("mention-recovery", users.viewer.id);
  await runSql("notifications-mention-recovery-quota", [
    `DELETE FROM app_rate_limits WHERE key IN ('content:${users.suspendedowner.id}','write:${users.suspendedowner.id}');`,
  ]);
  const context = await signedIn(browser, "suspendedowner", clientIp("discussion-notifications", 164));
  // This mention case owns 203.0.113.101 to isolate its request quota.
  await context.setExtraHTTPHeaders({ Origin: "http://localhost:5173", "CF-Connecting-IP": "203.0.113.101" });
  try {
    const page = await newPage(context);
    await page.goto(`/@test_host?entry=${entryId}`);
    let failLookup: boolean = true;
    await page.route(`**/api/entries/${entryId}/mention-candidates?**`, async (route) => {
      if (failLookup) {
        await route.fulfill({ status: 503, json: { error: "The request failed. Please try again." } });
        return;
      }
      await route.continue();
    });
    const composer = page.getByRole("textbox", { name: "Write a comment", exact: true });
    await composer.fill("@test_host");
    await expect(page.locator(".mention-options")).toContainText("The request failed. Please try again.");
    await composer.press("Escape");
    await expect(page.locator(".mention-options")).toHaveCount(0);
    failLookup = false;
    await composer.fill("@no-such-public-profile");
    await expect(page.locator(".mention-options")).toContainText("No matching public profiles.");
    await composer.fill("@test_host");
    await expect(page.locator(".mention-option")).toHaveCount(1);
    await composer.press("ArrowDown");
    await composer.press("ArrowUp");
    await expect(page.locator(".mention-option")).toHaveAttribute("data-active", "true");
    await composer.press("Enter");
    await expect(composer).toHaveValue("@owner ");
    // Deleting outside the label preserves it; deleting within it removes the account selection.
    await composer.press("Home");
    await composer.pressSequentially("Hello ");
    await composer.press("End");
    await composer.press("Backspace");
    await expect(composer).toHaveValue("Hello @owner");
    await composer.press("Home");
    for (let index: number = 0; index < 7; index += 1) await composer.press("ArrowRight");
    await composer.press("Delete");
    await expect(composer).toHaveValue("Hello @wner");
    await composer.press("End");
    await composer.pressSequentially(" @test_host");
    await expect(page.locator(".mention-option")).toHaveCount(1);
    await composer.press("Enter");
    await composer.press("End");
    await composer.pressSequentially("@other_host");
    await expect(page.locator(".mention-option")).toHaveCount(1);
    await composer.press("Enter");
    await composer.press("End");
    await composer.pressSequentially("please check.");
    const posted = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/api/streamers/test_host"),
    );
    await page.getByRole("button", { name: "Post", exact: true }).click();
    const id: string = mutationSchema.parse(await (await posted).json()).id;
    const comment = page.locator(`#cm-${id}`);
    await expect(comment.locator(".comment-mention")).toHaveText(["@owner", "@otherowner"]);
    await expect(comment.locator(".comment-text")).toHaveText("Hello @wner @owner @otherowner please check.");
    const stored = await context.request.get(`/api/comments/${id}`);
    const result = z
      .object({
        comment: z.object({
          mentions: z.array(
            z.object({
              userId: z.string(),
              start: z.number(),
              end: z.number(),
            }),
          ),
        }),
      })
      .parse(await stored.json());
    expect([...result.comment.mentions].sort((left, right): number => left.start - right.start)).toEqual([
      { userId: users.owner.id, start: 12, end: 18 },
      { userId: users.otherowner.id, start: 19, end: 30 },
    ]);
  } finally {
    await close(context);
    await runSql("notifications-mention-recovery-cleanup", [`DELETE FROM entries WHERE id='${entryId}';`]);
  }
});
