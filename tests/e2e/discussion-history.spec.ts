import { newPage, close } from "./coverage";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type BrowserContext } from "./coverage";
import { z } from "zod";
import { clientAddress, clientIp } from "./client-ips";
import { accounts, commentBox, expectCommentText, runSql, signedIn } from "./fixtures";

const origin = "http://localhost:5173";
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));

async function seedHistory(userId: string): Promise<{ entryId: string; remoteParentId: string }> {
  const entryId: string = randomUUID();
  const parentId: string = randomUUID();
  const remoteParentId: string = randomUUID();
  const now: number = Date.now() - 200_000;
  const statements: string[] = [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,created_at) SELECT '${entryId}',id,'${userId}','topic','Historical discussion','A discussion with more than one page.','Just chatting',${now} FROM streamers WHERE handle='test_host';`,
  ];
  // 110 root comments cross the 100-comment page boundary.
  for (let index = 1; index <= 112; index += 1) {
    const id: string = index === 1 ? parentId : index === 3 ? remoteParentId : randomUUID();
    const parent: string = index === 2 ? `'${parentId}'` : index === 4 ? `'${remoteParentId}'` : "NULL";
    statements.push(
      `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at,parent_id) VALUES ('${id}','${entryId}','${userId}','History comment ${String(index).padStart(3, "0")}',${now + index},${parent});`,
    );
  }
  const seedPath: string = resolve(".wrangler/e2e/discussion-history.sql");
  await writeFile(seedPath, statements.join("\n"));
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/wrangler/bin/wrangler.js"),
      "d1",
      "execute",
      "DB",
      "--local",
      "--config",
      resolve(".wrangler/e2e/wrangler.json"),
      "--env-file",
      resolve(".wrangler/e2e/.env"),
      "--persist-to",
      resolve(".wrangler/e2e/state"),
      "--file",
      seedPath,
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  return { entryId, remoteParentId };
}

test("historical comment mutations stay visible and accurate after refresh", async ({ browser }) => {
  const sessions = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
  const viewer = sessions.viewer;
  const owner = sessions.owner;
  if (!viewer || !owner) throw new Error("Missing discussion test accounts.");
  const { entryId, remoteParentId } = await seedHistory(viewer.id);
  const context: BrowserContext = await browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("discussion-history", 75) },
  });
  const ownerContext: BrowserContext = await browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("discussion-history", 76) },
  });
  await context.addCookies([
    {
      name: "stream-bullets.session_token",
      value: viewer.cookie,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await ownerContext.addCookies([
    {
      name: "stream-bullets.session_token",
      value: owner.cookie,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  try {
    const page = await newPage(context);
    await page.goto(`/@test_host?entry=${entryId}`);
    await page.getByRole("button", { name: "Load more comments" }).click();
    const oldest = page
      .locator("article.comment")
      .filter({ has: page.getByText("History comment 001", { exact: true }) });
    const reply = page
      .locator("article.comment")
      .filter({ has: page.getByText("History comment 002", { exact: true }) });
    await expect(oldest).toBeVisible();
    await expect(reply.locator(".replying")).toHaveCount(1);
    const like = oldest.getByRole("button", { name: "Like comment by viewer" });
    await like.click();
    await expect(like).toHaveAttribute("aria-pressed", "true");
    await expect(like).toHaveText("Like 1");
    await like.click();
    await expect(like).toHaveAttribute("aria-pressed", "false");
    await expect(like).toHaveText("Like 0");
    await commentBox(page, "Write a comment").fill("Keep this unsent draft.");
    await oldest.getByRole("button", { name: "Delete comment", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete comment", exact: true }).click();
    await expect(oldest).toHaveCount(0);
    await expect(reply).toBeVisible();
    // Deleted parents remain as placeholders to preserve threads.
    await expect(page.getByRole("article", { name: "Comment removed" })).toHaveCount(1);
    await expect(reply.locator(".replying")).toContainText("a removed comment");
    await page.getByRole("button", { name: "Refresh comments", exact: true }).click();
    await expect(page.getByText("Loading comments…", { exact: true })).toHaveCount(0);
    await expect(oldest).toHaveCount(0);
    await expect(reply).toBeVisible();
    await expectCommentText(commentBox(page, "Write a comment"), "Keep this unsent draft.");
    const added = await context.request.post("/api/streamers/test_host", {
      headers: { Origin: origin },
      data: { action: "comment", id: entryId, text: "A newer comment arrives." },
    });
    expect(added.ok()).toBe(true);
    await page.getByRole("button", { name: "Refresh comments", exact: true }).click();
    await expect(page.getByText("A newer comment arrives.", { exact: true })).toBeVisible();
    await expect(reply).toHaveCount(1);
    await expect(oldest).toHaveCount(0);
    const remoteParent = page
      .locator("article.comment")
      .filter({ has: page.getByText("History comment 003", { exact: true }) });
    const remoteReply = page
      .locator("article.comment")
      .filter({ has: page.getByText("History comment 004", { exact: true }) });
    const remoteLike = await ownerContext.request.post("/api/comments", {
      headers: { Origin: origin },
      data: { action: "like", id: remoteParentId, liked: true },
    });
    expect(remoteLike.ok()).toBe(true);
    await page.getByRole("button", { name: "Refresh comments", exact: true }).click();
    await expect(remoteParent.getByRole("button", { name: "Like comment by viewer" })).toHaveText("Like 1");
    await expect(remoteParent.getByRole("button", { name: "Like comment by viewer" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await remoteParent.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancel reply", exact: true })).toBeVisible();
    const replyDraft = commentBox(page, "Write a reply to viewer");
    await replyDraft.fill("Keep this historical reply draft.");
    await page.reload();
    await expectCommentText(replyDraft, "Keep this historical reply draft.");
    await expect(remoteParent).toBeVisible();
    await page.getByRole("button", { name: "Load more comments" }).click();
    await expect(reply).toBeVisible();
    const remoteDelete = await ownerContext.request.post("/api/comments", {
      headers: { Origin: origin },
      data: { action: "delete", id: remoteParentId },
    });
    expect(remoteDelete.ok()).toBe(true);
    await page.getByRole("button", { name: "Refresh comments", exact: true }).click();
    await expect(remoteParent).toHaveCount(0);
    await expect(remoteReply).toBeVisible();
    // Deleted parents remain as placeholders to preserve threads.
    await expect(remoteReply.locator(".replying")).toContainText("a removed comment");
    await expect(reply).toBeVisible();
    // The placeholder remains a reply target until the viewer cancels.
    await page.getByRole("button", { name: "Cancel reply", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancel reply", exact: true })).toHaveCount(0);
    await expectCommentText(commentBox(page, "Write a comment"), "Keep this unsent draft.");
    await page.getByRole("button", { name: "Post", exact: true }).click();
    const postedDraft = page
      .locator("article.comment")
      .filter({ has: page.getByText("Keep this unsent draft.", { exact: true }) });
    await expect(postedDraft).toBeVisible();
    await expect(postedDraft.locator(".replying")).toHaveCount(0);
  } finally {
    await close(context);
    await close(ownerContext);
  }
});

for (const change of ["sort", "refresh"] as const) {
  test(`cancels pending comment pagination on ${change}`, async ({ browser }) => {
    const sessions = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
    const viewer = sessions.viewer;
    if (!viewer) throw new Error("Missing discussion test account.");
    const { entryId } = await seedHistory(viewer.id);
    const context: BrowserContext = await browser.newContext({
      baseURL: origin,
      extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("discussion-history", change === "sort" ? 77 : 78) },
    });
    try {
      const page = await newPage(context);
      await page.goto(`/@test_host?entry=${entryId}`);
      const more = page.getByRole("button", { name: "Load more comments" });
      await expect(more).toBeEnabled();
      const pending = page.waitForRequest((request) => request.url().includes("cursor="));
      await page.route(`**/api/entries/${entryId}/comments?**`, async (route) => {
        if (new URL(route.request().url()).searchParams.has("cursor")) return;
        await route.continue();
      });
      await more.click();
      const request = await pending;
      const cancelled = page.waitForEvent("requestfailed", (failed) => failed === request);
      if (change === "sort") {
        await page.getByRole("combobox", { name: "Sort comments" }).click();
        await page.getByRole("option", { name: "Top", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "Refresh comments", exact: true }).click();
      }
      await cancelled;
      await expect(more).toBeEnabled();
      if (change === "sort") {
        await page.getByRole("combobox", { name: "Sort comments" }).click();
        await page.getByRole("option", { name: "Newest", exact: true }).click();
        await expect(more).toBeEnabled();
      }
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await more.click();
      await expect(page.locator(".thread-list > li.thread")).toHaveCount(110);
      await expect(more).toHaveCount(0);
      await expect(page.locator(".discussion .form-error")).toBeEmpty();
    } finally {
      await close(context);
    }
  });
}

test("comment loading and pagination recover without dropping the loaded history", async ({ browser }) => {
  const users = await accounts();
  const { entryId } = await seedHistory(users.viewer.id);
  const foreignEntryId: string = randomUUID();
  const foreignCommentId: string = randomUUID();
  await runSql("discussion-foreign-target", [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,created_at) SELECT '${foreignEntryId}',id,'${users.viewer.id}','topic','Another discussion','','Just chatting',${Date.now()} FROM streamers WHERE handle='test_host';`,
    `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at) VALUES ('${foreignCommentId}','${foreignEntryId}','${users.viewer.id}','Comment in another discussion',${Date.now()});`,
  ]);
  const context = await signedIn(browser, "viewer", clientIp("discussion-history", 75));
  // This loading case owns 203.0.113.103 to isolate its request quota.
  await context.setExtraHTTPHeaders({ Origin: origin, "CF-Connecting-IP": "203.0.113.103" });
  try {
    const page = await newPage(context);
    let failure: "initial" | "page" | null = "initial";
    await page.route(`**/api/entries/${entryId}/comments?**`, async (route) => {
      const paginating: boolean = new URL(route.request().url()).searchParams.has("cursor");
      if (failure === "initial" || (failure === "page" && paginating)) {
        await route.fulfill({ status: 503, json: { error: "The request failed. Please try again." } });
        return;
      }
      await route.continue();
    });
    await page.goto(`/@test_host?entry=${entryId}`);
    const alert = page.locator(".discussion > .form-error");
    await expect(alert).toHaveText("The request failed. Please try again.");
    await expect(page.getByText("Loading comments…", { exact: true })).toHaveCount(0);
    const composer = commentBox(page, "Write a comment");
    await composer.fill("Keep this draft through history retries.");
    failure = null;
    await page.getByRole("button", { name: "Refresh comments", exact: true }).click();
    const roots = page.locator(".thread-list > li.thread");
    await expect(roots).toHaveCount(100);
    await expect(alert).toBeEmpty();
    failure = "page";
    const more = page.getByRole("button", { name: "Load more comments", exact: true });
    await more.click();
    await expect(alert).toHaveText("The request failed. Please try again.");
    await expect(roots).toHaveCount(100);
    await expect(more).toBeEnabled();
    await expectCommentText(composer, "Keep this draft through history retries.");
    failure = null;
    await more.click();
    await expect(roots).toHaveCount(110);
    await expect(more).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh comments", exact: true }).click();
    await expect(alert).toBeEmpty();
    await expect(roots).toHaveCount(110);
    await page.goto(`/@test_host?entry=${entryId}&comment=${foreignCommentId}`);
    await expect(alert).toHaveText("This comment is no longer available.");
    await expect(page.locator(`#cm-${foreignCommentId}`)).toHaveCount(0);
    await expect(roots).toHaveCount(100);
    await expectCommentText(composer, "Keep this draft through history retries.");
  } finally {
    await close(context);
    await runSql("discussion-loading-cleanup", [`DELETE FROM entries WHERE id IN ('${entryId}','${foreignEntryId}');`]);
  }
});
