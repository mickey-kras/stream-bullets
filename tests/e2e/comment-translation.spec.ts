import { randomUUID } from "node:crypto";
import { close, expect, newPage, test } from "./coverage";
import { clientIp } from "./client-ips";
import { accounts, runSql, signedIn } from "./fixtures";

async function seedComments(): Promise<string> {
  const users = await accounts();
  const entryId: string = randomUUID();
  const now: number = Date.now() - 600_000;
  await runSql("comment-translation", [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,created_at) SELECT '${entryId}',id,'${users.viewer.id}','topic','Translate topic','Body','Just chatting',${now} FROM streamers WHERE handle='other_host';`,
    `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at) VALUES ('${randomUUID()}','${entryId}','${users.reporter.id}','**Hallo** Welt',${now + 1});`,
    `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at) VALUES ('${randomUUID()}','${entryId}','${users.viewer.id}','My own comment',${now + 2});`,
  ]);
  return entryId;
}

test("a reader changes between a comment and its translation with one request", async ({ browser }) => {
  const entryId: string = await seedComments();
  const context = await signedIn(browser, "viewer", clientIp("comment-translation", 101));
  const page = await newPage(context);
  try {
    const locales: unknown[] = [];
    await page.route("**/api/comments/*/translation", async (route) => {
      locales.push(route.request().postDataJSON());
      await route.fulfill({ json: { translation: { text: "**Hello** world", mentions: [] } } });
    });
    await page.goto(`/@other_host?entry=${entryId}`);
    const comment = page.locator("article.comment").filter({ hasText: "reporter" });
    const own = page.locator("article.comment").filter({ hasText: "My own comment" });
    await expect(own.getByRole("button", { name: "Translate", exact: true })).toHaveCount(0);
    await comment.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(comment.locator(".comment-text")).toHaveText("Hello world");
    await expect(comment.locator(".comment-translation")).toContainText("Translated");
    await comment.getByRole("button", { name: "Show original", exact: true }).click();
    await expect(comment.locator(".comment-text")).toHaveText("Hallo Welt");
    await comment.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(comment.locator(".comment-text")).toHaveText("Hello world");
    expect(locales).toEqual([{ locale: "en", text: "**Hallo** Welt" }]);
  } finally {
    await close(context);
  }
});

test("a comment without a translation, and a deployment without translation, show a message", async ({ browser }) => {
  const entryId: string = await seedComments();
  const context = await signedIn(browser, "viewer", clientIp("comment-translation", 102));
  const page = await newPage(context);
  try {
    await page.route("**/api/comments/*/translation", (route) => route.fulfill({ json: { translation: null } }));
    await page.goto(`/@other_host?entry=${entryId}`);
    const comment = page.locator("article.comment").filter({ hasText: "reporter" });
    await comment.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(comment.locator(".comment-translation")).toHaveText("This comment has no translation.");
    await expect(comment.locator(".comment-text")).toHaveText("Hallo Welt");

    // The local server has no Workers AI binding: the real endpoint answers 503.
    await page.unroute("**/api/comments/*/translation");
    await page.reload();
    await comment.getByRole("button", { name: "Translate", exact: true }).click();
    await expect(comment.locator(".comment-translation output")).toHaveText("Translation is not available.");
    await expect(comment.getByRole("button", { name: "Translate", exact: true })).toBeEnabled();
  } finally {
    await close(context);
  }
});
