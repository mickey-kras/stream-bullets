import { newPage, close } from "./coverage";
import { randomUUID } from "node:crypto";
import { expect, test } from "./coverage";
import { accounts, commentBox, expectCommentText, runSql, signedIn } from "./fixtures";
import { clientIp } from "./client-ips";
import { z } from "zod";

// The root comment of the seeded thread, for links to it.
let seededRoot = "";

async function seedThreads(): Promise<string> {
  const users = await accounts();
  const entryId = randomUUID();
  const root = randomUUID();
  seededRoot = root;
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
  await expect(page.locator(".ed-content[data-composer]")).toHaveCount(2);
  await replies.nth(0).getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.locator(".ed-content[data-composer]")).toHaveCount(2);
  const box = thread.locator(".inline-reply");
  await expect(box).toContainText("Replying to reporter");
  await commentBox(box, "Write a reply to reporter").fill("Agreed with the first reply.");
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
    // The author types Markdown and the editor shows each format at once. The stored text is the same Markdown.
    const composer = commentBox(page, "Write a comment");
    await composer.click();
    const typed: readonly (readonly string[])[] = [
      ["**bold** *italic* ~~struck~~ `inline` [site](https://example.com/page)"],
      // The second Enter on an empty list item ends the list.
      ["- first", "second", ""],
      ["1. one", "two", ""],
      ["> quoted"],
      // Three backticks and a space start a code block. Two empty lines end it.
      [`\`\`\` const wide = "${"x".repeat(300)}";`, "", ""],
    ];
    for (const block of typed) {
      for (const line of block) {
        await page.keyboard.type(line);
        await page.keyboard.press("Enter");
      }
      await page.keyboard.press("Enter");
    }
    await page.keyboard.type("# no heading <script>window.pwned = true</script>");
    await page.keyboard.press("Enter");
    await page.keyboard.type("plain line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("next line");
    await expect(composer.locator("strong")).toHaveText("bold");
    await expect(composer.locator("em")).toHaveText("italic");
    await expect(composer.locator(".ed-strike")).toHaveText("struck");
    await expect(composer.locator("p > code")).toHaveText("inline");
    await expect(composer.locator('a[href="https://example.com/page"]')).toHaveText("site");
    await expect(composer.locator("ul > li")).toHaveText(["first", "second"]);
    await expect(composer.locator("ol > li")).toHaveText(["one", "two"]);
    await expect(composer.locator("blockquote")).toHaveText("quoted");
    await expect(composer.locator(":scope > code")).toContainText("const wide");
    await expect(composer.locator("h1, script, img")).toHaveCount(0);
    const created = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/api/streamers/other_host"),
    );
    await page.getByRole("button", { name: "Post", exact: true }).click();
    const commentId: string = z.object({ id: z.string() }).parse(await (await created).json()).id;
    const storedText = async (): Promise<string> =>
      z
        .object({ comment: z.object({ text: z.string() }) })
        .parse(await (await context.request.get(`/api/comments/${commentId}`)).json()).comment.text;
    expect(await storedText()).toBe(text);
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
    // The edit field shows the same formats, and a save without a change keeps the same Markdown.
    const editBox = commentBox(posted, "Edit comment");
    await expect(editBox.locator("strong")).toHaveText("bold");
    await expect(editBox.locator("em")).toHaveText("italic");
    await expect(editBox.locator(".ed-strike")).toHaveText("struck");
    await expect(editBox.locator("p > code")).toHaveText("inline");
    await expect(editBox.locator('a[href="https://example.com/page"]')).toHaveText("site");
    await expect(editBox.locator("ul > li")).toHaveText(["first", "second"]);
    await expect(editBox.locator("ol > li")).toHaveText(["one", "two"]);
    await expect(editBox.locator("blockquote")).toHaveText("quoted");
    await expect(editBox.locator(":scope > code")).toContainText("const wide");
    await expect(editBox).toContainText("# no heading <script>window.pwned = true</script>");
    const saved = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/api/comments"),
    );
    await posted.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    expect(await storedText()).toBe(text);
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
    const composer = commentBox(page, "Write a comment");
    await composer.fill("A recoverable comment draft.");
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.locator(".discussion > .form-error")).toHaveText("The request failed. Please try again.");
    await expectCommentText(composer, "A recoverable comment draft.");
    failedAction = null;
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByText("A recoverable comment draft.", { exact: true })).toBeVisible();
    await expect(composer).toHaveText("");

    await root.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = commentBox(root, "Edit comment");
    await expect(editor).toBeFocused();
    await editor.fill("Cancelled edit");
    await root.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(root.locator(".comment-text")).toHaveText("Root comment");
    await expect(root.getByRole("button", { name: "Like comment by frozenowner", exact: true })).toBeFocused();
    await root.getByRole("button", { name: "Edit", exact: true }).click();
    await expectCommentText(editor, "Root comment");
    await editor.fill("Root comment after retry");
    failedAction = "edit";
    await root.getByRole("button", { name: "Save", exact: true }).click();
    await expect(root.getByRole("alert")).toHaveText("The request failed. Please try again.");
    await expectCommentText(editor, "Root comment after retry");
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

test("the link field adds a link and does not post the comment", async ({ browser }) => {
  const entryId: string = await seedThreads();
  const context = await signedIn(browser, "viewer", clientIp("threads", 100));
  const page = await newPage(context);
  try {
    await page.goto(`/@other_host?entry=${entryId}`);
    const comments = page.locator("article.comment");
    // Each write to the page of the streamer. Enter in the link field must not start one.
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/streamers/")) posts.push(request.url());
    });
    const composer = commentBox(page, "Write a comment");
    await composer.click();
    await page.keyboard.type("See the guide");
    await page.keyboard.press("Shift+Home");
    await page.getByRole("button", { name: "Add link", exact: true }).click();
    const address = page.getByRole("textbox", { name: "Link address", exact: true });
    await address.fill("https://example.com/guide");
    await address.press("Enter");
    // Enter in the link field applies the link. The comment stays in the editor.
    await expect(address).toHaveCount(0);
    await expect(composer.getByRole("link", { name: "See the guide" })).toHaveAttribute(
      "href",
      "https://example.com/guide",
    );
    expect(posts).toEqual([]);
    await expect(comments.filter({ hasText: "See the guide" })).toHaveCount(0);
    await page.getByRole("button", { name: "Post", exact: true }).click();
    const posted = comments.filter({ hasText: "See the guide" }).first();
    await expect(posted.getByRole("link", { name: "See the guide" })).toHaveAttribute(
      "href",
      "https://example.com/guide",
    );
  } finally {
    await close(context);
  }
});

test("a link to a thread keeps its loaded replies when the discussion refreshes", async ({ browser }) => {
  const entryId: string = await seedThreads();
  const users = await accounts();
  await runSql("threads-link-quota", [
    `DELETE FROM app_rate_limits WHERE key IN ('content:${users.viewer.id}','write:${users.viewer.id}');`,
  ]);
  const context = await signedIn(browser, "viewer", clientIp("threads", 100));
  try {
    const page = await newPage(context);
    await page.goto(`/@other_host?entry=${entryId}&comment=${seededRoot}`);
    const thread = page.locator("li.thread").filter({ has: page.getByText("Root comment", { exact: true }) });
    const replies = thread.locator(".replies > li > article.comment");
    await expect(replies).toHaveCount(2);
    await thread.getByRole("button", { name: "View 2 more replies" }).click();
    await expect(replies).toHaveCount(4);
    // A new comment refreshes the discussion; the linked thread keeps the four replies it loaded.
    await commentBox(page, "Write a comment").fill("A comment that refreshes the list.");
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByText("A comment that refreshes the list.", { exact: true })).toBeVisible();
    // A post refreshes the list more than once, and each refresh reads the linked comment again: wait for the last.
    await page.waitForLoadState("networkidle");
    await expect(replies).toHaveCount(4);
    await expect(thread.getByRole("button", { name: "View 2 more replies" })).toHaveCount(0);
  } finally {
    await close(context);
  }
});

// A topic whose root comment has `count` replies, "Long reply 1" to "Long reply <count>", oldest first.
async function seedLongThread(count: number = 80): Promise<string> {
  const users = await accounts();
  const entryId = randomUUID();
  const root = randomUUID();
  const now = Date.now() - 600_000;
  await runSql("threads-window", [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,created_at) SELECT '${entryId}',id,'${users.viewer.id}','topic','A long thread','Many replies.','Just chatting',${now} FROM streamers WHERE handle='other_host';`,
    `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at,parent_id) VALUES ('${root}','${entryId}','${users.viewer.id}','The long root',${now},NULL);`,
    `DELETE FROM entry_comments WHERE id LIKE '00000000-0000-4000-8000-%';`,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
      INSERT INTO entry_comments(id,entry_id,author_id,text,created_at,parent_id)
      SELECT printf('00000000-0000-4000-8000-%012d', i), '${entryId}', '${users.reporter.id}', 'Long reply ' || i, ${now} + i, '${root}' FROM n;`,
    `DELETE FROM app_rate_limits WHERE key IN ('content:${users.viewer.id}','write:${users.viewer.id}');`,
  ]);
  return entryId;
}

function longReply(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

test("a linked reply's window keeps the earlier page the reader loaded when the discussion refreshes", async ({ browser }) => {
  const entryId: string = await seedLongThread();
  const context = await signedIn(browser, "viewer", clientIp("threads", 100));
  try {
    const page = await newPage(context);
    await page.goto(`/@other_host?entry=${entryId}&comment=${longReply(75)}`);
    const thread = page.locator("li.thread").filter({ has: page.getByText("The long root", { exact: true }) });
    const replies = thread.locator(".replies > li > article.comment");
    // The link brings replies 65 to 80; 64 come before them.
    await expect(replies).toHaveCount(16);
    await thread.getByRole("button", { name: "View 64 earlier replies" }).click();
    await expect(replies).toHaveCount(66);
    await expect(thread.getByRole("button", { name: "View 14 earlier replies" })).toBeVisible();
    await commentBox(page, "Write a comment").fill("A comment that refreshes the long thread.");
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(page.getByText("A comment that refreshes the long thread.", { exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(replies).toHaveCount(66);
    await expect(replies.first()).toContainText("Long reply 15");
    await expect(thread.getByRole("button", { name: "View 14 earlier replies" })).toBeVisible();
  } finally {
    await close(context);
  }
});

test("a reply the reader posts in a long thread shows with the replies already loaded", async ({ browser }) => {
  const entryId: string = await seedLongThread(120);
  const context = await signedIn(browser, "viewer", clientIp("threads", 100));
  try {
    const page = await newPage(context);
    await page.goto(`/@other_host?entry=${entryId}`);
    const thread = page.locator("li.thread").filter({ has: page.getByText("The long root", { exact: true }) });
    const replies = thread.locator(".replies > li > article.comment");
    await expect(replies).toHaveCount(2);
    await thread.getByRole("button", { name: "View 118 more replies" }).click();
    await expect(replies).toHaveCount(52);
    await replies.nth(51).getByRole("button", { name: "Reply", exact: true }).click();
    const box = thread.locator(".inline-reply");
    await commentBox(box, "Write a reply to reporter").fill("A reply at the end of a long thread.");
    await box.getByRole("button", { name: "Post", exact: true }).click();
    await expect(thread.getByText("A reply at the end of a long thread.", { exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle");
    // The refresh loads the reader's replies again (whole pages: 100), and one more page reaches the new reply.
    await expect(replies).toHaveCount(121);
    await expect(replies.first()).toContainText("Long reply 1");
    await expect(replies.last()).toContainText("A reply at the end of a long thread.");
  } finally {
    await close(context);
  }
});

test("the reply link of a reply outside the loaded replies opens its parent", async ({ browser }) => {
  const entryId: string = await seedLongThread();
  // Reply 75 answers reply 10, far outside the window of a link to reply 75.
  await runSql("threads-parent", [
    `UPDATE entry_comments SET parent_id='${longReply(10)}' WHERE id='${longReply(75)}';`,
  ]);
  const context = await signedIn(browser, "viewer", clientIp("threads", 100));
  try {
    const page = await newPage(context);
    await page.goto(`/@other_host?entry=${entryId}&comment=${longReply(75)}`);
    const linked = page.locator(`#cm-${longReply(75)}`);
    await expect(linked).toBeVisible();
    await expect(page.locator(`#cm-${longReply(10)}`)).toHaveCount(0);
    await linked.locator(".reply-mention").click();
    await expect(page).toHaveURL(new RegExp(`comment=${longReply(10)}`));
    const parent = page.locator(`#cm-${longReply(10)}`);
    await expect(parent).toContainText("Long reply 10");
    await expect(parent).toBeFocused();
  } finally {
    await close(context);
  }
});
