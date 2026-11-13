import { newPage, close } from "./coverage";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type BrowserContext } from "./coverage";
import { z } from "zod";
import { clientAddress } from "./client-ips";

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
    await page.getByRole("textbox", { name: "Write a comment" }).fill("Keep this unsent draft.");
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
    await expect(page.getByRole("textbox", { name: "Write a comment" })).toHaveValue("Keep this unsent draft.");
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
    const replyDraft = page.getByRole("textbox", { name: "Write a reply to viewer", exact: true });
    await replyDraft.fill("Keep this historical reply draft.");
    await page.reload();
    await expect(replyDraft).toHaveValue("Keep this historical reply draft.");
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
    await expect(page.getByRole("textbox", { name: "Write a comment" })).toHaveValue("Keep this unsent draft.");
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
