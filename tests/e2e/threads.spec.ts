import { newPage, close } from "./coverage";
import { randomUUID } from "node:crypto";
import { expect, test } from "./coverage";
import { accounts, runSql, signedIn } from "./fixtures";
import { clientIp } from "./client-ips";
import { z } from "zod";

async function seedThreads(): Promise<string> {
  const users = await accounts();
  const entryId = randomUUID();
  const root = randomUUID();
  const removed = randomUUID();
  const now = Date.now() - 600_000;
  const comment = (id: string, author: string, text: string, at: number, parent: string | null, gone = false): string =>
    `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at,parent_id,removed_at) VALUES ('${id}','${entryId}','${users[author].id}','${gone ? "[removed]" : text}',${now + at},${parent ? `'${parent}'` : "NULL"},${gone ? now : "NULL"});`;
  await runSql("threads", [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,created_at) SELECT '${entryId}',id,'${users.viewer.id}','topic','Threaded discussion','Replies sit under their comment.','Just chatting',${now} FROM streamers WHERE handle='other_host';`,
    comment(root, "viewer", "Root comment", 1, null),
    ...[1, 2, 3, 4].map((n: number) => comment(randomUUID(), "reporter", `Reply number ${n}`, 10 + n, root)),
    comment(removed, "reporter", "", 2, null, true),
    comment(randomUUID(), "viewer", "Reply under a removed comment", 30, removed),
  ]);
  return entryId;
}

test("replies collapse after two, removed comments keep their thread, one reply box", async ({ browser }) => {
  const entryId = await seedThreads();
  const context = await signedIn(browser, "viewer", clientIp("threads", 100));
  const page = await newPage(context);
  await page.goto(`/@other_host?entry=${entryId}`);
  const thread = page.locator("li.thread").filter({ has: page.getByText("Root comment", { exact: true }) });
  const replies = thread.locator(".replies > li > article.comment");
  await expect(replies).toHaveCount(2);
  await expect(replies.nth(0)).toContainText("Reply number 1");
  await expect(replies.nth(1)).toContainText("Reply number 2");
  await expect(replies.nth(0).locator(".reply-mention")).toHaveText("Reply to viewer");
  await thread.getByRole("button", { name: "View 2 more replies" }).click();
  await expect(replies).toHaveCount(4);
  await thread.getByRole("button", { name: "Hide replies (4)" }).click();
  await expect(thread.locator(".replies")).toBeHidden();
  await thread.locator("article.comment").first().getByRole("button", { name: "Reply", exact: true }).click();
  await expect(thread.locator(".inline-reply")).toBeVisible();
  await expect(replies).toHaveCount(4);
  await expect(thread.getByRole("button", { name: "Hide replies (4)" })).toBeVisible();

  const placeholder = page.getByRole("article", { name: "Comment removed" });
  await expect(placeholder).toHaveCount(1);
  await expect(placeholder).toContainText("Comment removed");
  await expect(placeholder.getByRole("button")).toHaveCount(0);
  const orphan = page.locator("article.comment").filter({ hasText: "Reply under a removed comment" });
  await expect(orphan.locator(".reply-mention")).toHaveText("Reply to a removed comment");

  await replies.nth(2).getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.locator("textarea[data-composer]")).toHaveCount(2);
  await replies.nth(0).getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.locator("textarea[data-composer]")).toHaveCount(2);
  const box = thread.locator(".inline-reply");
  await expect(box).toContainText("Replying to reporter");
  await box.getByRole("textbox", { name: "Write a reply to reporter" }).fill("Agreed with the first reply.");
  await box.getByRole("button", { name: "Post", exact: true }).click();
  await expect(thread.locator(".inline-reply")).toHaveCount(0);
  const posted = thread.locator("article.comment").filter({ hasText: "Agreed with the first reply." });
  await expect(posted).toBeVisible();
  await expect(posted.locator(".reply-mention")).toHaveText("Reply to reporter");

  const reported = replies.nth(1);
  await reported.getByRole("button", { name: "Report comment by reporter" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: /Spam or scam/ }).check();
  await dialog.getByRole("button", { name: "Send report" }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(reported.locator(".reported-note")).toHaveText("Reported");
  await expect(reported.getByRole("button", { name: "Report comment by reporter" })).toHaveCount(0);
  await page.reload();
  const again = page.locator("article.comment").filter({ has: page.getByText("Reply number 2", { exact: true }) });
  await expect(again.locator(".reported-note")).toHaveCount(1);
  await close(context);
});

test("a posted comment renders the Markdown subset and keeps markup inert", async ({ browser }) => {
  const entryId: string = await seedThreads();
  const users = await accounts();
  await runSql("threads-markdown-quota", [
    `DELETE FROM app_rate_limits WHERE key IN ('content:${users.viewer.id}','write:${users.viewer.id}');`,
  ]);
  const text: string = [
    "**bold** *italic* ~~struck~~ `inline` [site](https://example.com/page)",
    "",
    "- first",
    "- second",
    "",
    "1. one",
    "2. two",
    "",
    "> quoted",
    "",
    "```",
    `const wide = "${"x".repeat(300)}";`,
    "```",
    "",
    "# no heading <script>window.pwned = true</script>",
    "plain line",
    "next line",
  ].join("\n");
  const context = await signedIn(browser, "viewer", clientIp("threads", 100));
  try {
    const page = await newPage(context);
    await page.goto(`/@other_host?entry=${entryId}`);
    await page.getByRole("textbox", { name: "Write a comment", exact: true }).fill(text);
    await page.getByRole("button", { name: "Post", exact: true }).click();
    const posted = page.locator("article.comment").filter({ hasText: "plain line" });
    const body = posted.locator(".comment-text");
    await expect(body.locator("strong")).toHaveText("bold");
    await expect(body.locator("em")).toHaveText("italic");
    await expect(body.locator("del")).toHaveText("struck");
    await expect(body.locator("p > code")).toHaveText("inline");
    const link = body.getByRole("link", { name: "site", exact: true });
    await expect(link).toHaveAttribute("href", "https://example.com/page");
    await expect(link).toHaveAttribute("rel", "nofollow ugc noopener noreferrer");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(body.locator("ul > li")).toHaveText(["first", "second"]);
    await expect(body.locator("ol > li")).toHaveText(["one", "two"]);
    await expect(body.locator("blockquote")).toHaveText("quoted");
    await expect(body.locator("pre > code")).toContainText("const wide");
    await expect(body.locator("h1, script, img")).toHaveCount(0);
    const last = body.locator("p").last();
    await expect(last).toContainText("# no heading <script>window.pwned = true</script>");
    await expect(last.locator("br")).toHaveCount(2);
    expect(await page.evaluate((): boolean => "pwned" in globalThis)).toBe(false);
    const scroll = await body.locator("pre").evaluate((pre: HTMLElement) => ({
      code: pre.scrollWidth > pre.clientWidth,
      page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      thread: (pre.closest(".comment-body")?.scrollWidth ?? 0) > (pre.closest(".comment-body")?.clientWidth ?? 0),
    }));
    expect(scroll).toEqual({ code: true, page: false, thread: false });

    await page.reload();
    await expect(body.locator("strong")).toHaveText("bold");
    await posted.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(posted.getByRole("textbox", { name: "Edit comment", exact: true })).toHaveValue(text);
  } finally {
    await close(context);
    await runSql("threads-markdown-cleanup", [`DELETE FROM entries WHERE id='${entryId}';`]);
  }
});

test("failed comment actions keep drafts and editors available for retry", async ({ browser }) => {
  const entryId: string = await seedThreads();
  const users = await accounts();
  await runSql("threads-recovery-author", [
    `DELETE FROM app_rate_limits WHERE key IN ('content:${users.frozenowner.id}','write:${users.frozenowner.id}');`,
    `UPDATE entry_comments SET author_id='${users.frozenowner.id}' WHERE entry_id='${entryId}' AND author_id='${users.viewer.id}';`,
  ]);
  const context = await signedIn(browser, "frozenowner", clientIp("threads", 100));
  // This recovery case owns 203.0.113.102 to isolate its request quota.
  await context.setExtraHTTPHeaders({ Origin: "http://localhost:5173", "CF-Connecting-IP": "203.0.113.102" });
  try {
    const page = await newPage(context);
    await page.goto(`/@other_host?entry=${entryId}`);
    const rootId: string | null = await page
      .locator("article.comment")
      .filter({
        has: page.getByText("Root comment", { exact: true }),
      })
      .getAttribute("id");
    if (!rootId) throw new Error("Missing root comment.");
    const root = page.locator(`#${rootId}`);
    let failedAction: string | null = "comment";
    await page.route(/\/api\/(?:comments|streamers\/other_host)$/u, async (route) => {
      if (route.request().method() === "POST") {
        const { action } = z.object({ action: z.string() }).parse(route.request().postDataJSON());
        if (action === failedAction) {
          await route.fulfill({ status: 503, json: { error: "The request failed. Please try again." } });
          return;
        }
      }
      await route.continue();
    });
    const composer = page.getByRole("textbox", { name: "Write a comment", exact: true });
    await composer.fill("A recoverable comment draft.");
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.locator(".discussion > .form-error")).toHaveText("The request failed. Please try again.");
    await expect(composer).toHaveValue("A recoverable comment draft.");
    failedAction = null;
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByText("A recoverable comment draft.", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("");

    await root.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = root.getByRole("textbox", { name: "Edit comment", exact: true });
    await expect(editor).toBeFocused();
    await editor.fill("Cancelled edit");
    await root.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(root.locator(".comment-text")).toHaveText("Root comment");
    await expect(root.getByRole("button", { name: "Like comment by frozenowner", exact: true })).toBeFocused();
    await root.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(editor).toHaveValue("Root comment");
    await editor.fill("Root comment after retry");
    failedAction = "edit";
    await root.getByRole("button", { name: "Save", exact: true }).click();
    await expect(root.getByRole("alert")).toHaveText("The request failed. Please try again.");
    await expect(editor).toHaveValue("Root comment after retry");
    failedAction = null;
    await root.getByRole("button", { name: "Save", exact: true }).click();
    await expect(root.locator(".comment-text")).toHaveText("Root comment after retry");

    // A failed nested like is reconciled with the server rather than leaving its optimistic count.
    const ownReply = page.locator("article.comment").filter({
      has: page.getByText("Reply under a removed comment", { exact: true }),
    });
    const like = ownReply.getByRole("button", { name: "Like comment by frozenowner", exact: true });
    failedAction = "like";
    const rejectedLike = page.waitForResponse(
      (response) => response.url().endsWith("/api/comments") && response.status() === 503,
    );
    await like.click();
    await rejectedLike;
    await expect(like).toHaveAttribute("aria-pressed", "false");
    await expect(like).toHaveText("Like 0");
    failedAction = null;
    await like.click();
    await expect(like).toHaveAttribute("aria-pressed", "true");
    await expect(like).toHaveText("Like 1");

    await ownReply.getByRole("button", { name: "Delete comment", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(ownReply).toBeVisible();
    await ownReply.getByRole("button", { name: "Delete comment", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await ownReply.getByRole("button", { name: "Delete comment", exact: true }).click();
    failedAction = "delete";
    await dialog.getByRole("button", { name: "Delete comment", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText("The request failed. Please try again.");
    await expect(ownReply).toBeVisible();
    failedAction = null;
    await dialog.getByRole("button", { name: "Delete comment", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(ownReply).toHaveCount(0);
  } finally {
    await close(context);
    await runSql("threads-recovery-cleanup", [`DELETE FROM entries WHERE id='${entryId}';`]);
  }
});

test("signed-out readers can expand a removed-parent thread and return from sign in", async ({ browser }) => {
  const entryId: string = await seedThreads();
  // This read-only case owns 203.0.113.104 to isolate its request quota.
  const context = await browser.newContext({
    baseURL: "http://localhost:5173",
    extraHTTPHeaders: { "CF-Connecting-IP": "203.0.113.104" },
  });
  try {
    const page = await newPage(context);
    await page.goto(`/@other_host?entry=${entryId}`);
    const removed = page.locator("li.thread").filter({
      has: page.getByRole("article", { name: "Comment removed", exact: true }),
    });
    await removed.getByRole("button", { name: "Hide replies (1)", exact: true }).click();
    await expect(removed.locator(".replies")).toBeHidden();
    await removed.getByRole("button", { name: "Show 1 reply", exact: true }).click();
    await expect(removed.getByText("Reply under a removed comment", { exact: true })).toBeVisible();
    const root = page.locator("article.comment").filter({ has: page.getByText("Root comment", { exact: true }) });
    await expect(root.getByRole("button", { name: "Like comment by viewer", exact: true })).toBeDisabled();
    await expect(root.getByRole("button", { name: "Reply", exact: true })).toBeDisabled();
    await expect(root.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    const signIn = page.getByRole("button", { name: "Sign in to comment", exact: true });
    await signIn.click();
    const dialog = page.getByRole("dialog", { name: "Sign in or sign up", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(signIn).toBeFocused();
    await expect(root).toBeVisible();
  } finally {
    await close(context);
    await runSql("threads-signed-out-cleanup", [`DELETE FROM entries WHERE id='${entryId}';`]);
  }
});
