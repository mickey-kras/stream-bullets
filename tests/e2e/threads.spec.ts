import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { accounts, runSql, signedIn } from "./fixtures";
import { clientIp } from "./client-ips";

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
  const page = await context.newPage();
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
  await thread.getByRole("button", { name: "Show 4 replies" }).click();
  await expect(replies).toHaveCount(4);

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

  // Reporting a comment leaves one "Reported" marker and no second Report button.
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
  await context.close();
});
