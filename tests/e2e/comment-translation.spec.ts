import { randomUUID } from "node:crypto";
import { close, expect, newPage, test } from "./coverage";
import { clientIp } from "./client-ips";
import { accounts, runSql, signedIn } from "./fixtures";

interface Seeded {
  entryId: string;
  commentId: string;
}

async function seedComments(): Promise<Seeded> {
  const users = await accounts();
  const entryId: string = randomUUID();
  const commentId: string = randomUUID();
  const now: number = Date.now() - 600_000;
  await runSql("comment-translation", [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,created_at) SELECT '${entryId}',id,'${users.viewer.id}','topic','Translate topic','Body','Just chatting',${now} FROM streamers WHERE handle='other_host';`,
    `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at) VALUES ('${commentId}','${entryId}','${users.reporter.id}','**Hallo** Welt',${now + 1});`,
    `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at) VALUES ('${randomUUID()}','${entryId}','${users.viewer.id}','Already English',${now + 2});`,
  ]);
  return { entryId, commentId };
}

test("a signed-in reader gets each comment in the site language and can see one original", async ({ browser }) => {
  const { entryId } = await seedComments();
  const context = await signedIn(browser, "viewer", clientIp("comment-translation", 101));
  const page = await newPage(context);
  try {
    const asked: unknown[] = [];
    await page.route("**/api/comments/*/translation", async (route) => {
      const body = route.request().postDataJSON() as { text: string };
      asked.push(body);
      const translation = body.text === "**Hallo** Welt" ? { text: "**Hello** world", mentions: [] } : null;
      await route.fulfill({ json: { translation } });
    });
    await page.goto(`/@other_host?entry=${entryId}`);
    const comment = page.locator("article.comment").filter({ hasText: "reporter" });
    const english = page.locator("article.comment").filter({ hasText: "Already English" });
    // No selection is necessary: the page asks for the translation and shows it.
    await expect(comment.locator(".comment-text")).toHaveText("Hello world");
    await expect(english.locator(".comment-translation")).toHaveCount(0);
    await comment.getByRole("button", { name: "Show original", exact: true }).click();
    await expect(comment.locator(".comment-text")).toHaveText("Hallo Welt");
    await expect(english.locator(".comment-text")).toHaveText("Already English");
    await comment.getByRole("button", { name: "Show translation", exact: true }).click();
    await expect(comment.locator(".comment-text")).toHaveText("Hello world");
    expect(asked).toHaveLength(2);
    expect(asked).toContainEqual({ locale: "en", text: "**Hallo** Welt" });
  } finally {
    await close(context);
  }
});

test("a signed-out reader gets a stored translation and starts no new one", async ({ browser }) => {
  const { entryId, commentId } = await seedComments();
  await runSql("comment-translation", [
    `INSERT INTO comment_translations(comment_id,locale,source_hash,text,created_at) VALUES ('${commentId}','en','hash','**Hello** world',1);`,
  ]);
  const page = await newPage(browser);
  try {
    let asked: number = 0;
    await page.route("**/api/comments/*/translation", async (route) => {
      asked += 1;
      await route.abort();
    });
    await page.goto(`/@other_host?entry=${entryId}`);
    const comment = page.locator("article.comment").filter({ hasText: "reporter" });
    await expect(comment.locator(".comment-text")).toHaveText("Hello world");
    await comment.getByRole("button", { name: "Show original", exact: true }).click();
    await expect(comment.locator(".comment-text")).toHaveText("Hallo Welt");
    await expect(page.locator("article.comment").filter({ hasText: "Already English" })).toBeVisible();
    expect(asked).toBe(0);
  } finally {
    await close(page);
  }
});

test("a deployment without translation shows the original text and stops its requests", async ({ browser }) => {
  const { entryId } = await seedComments();
  const context = await signedIn(browser, "viewer", clientIp("comment-translation", 102));
  const page = await newPage(context);
  try {
    // The local server has no Workers AI binding: the endpoint answers 503.
    const answers: number[] = [];
    page.on("response", (response) => {
      if (response.url().includes("/translation")) answers.push(response.status());
    });
    await page.goto(`/@other_host?entry=${entryId}`);
    const comment = page.locator("article.comment").filter({ hasText: "reporter" });
    await expect(comment.locator(".comment-text")).toHaveText("Hallo Welt");
    await expect.poll(() => answers.length).toBeGreaterThan(0);
    expect(answers.every((status: number): boolean => status === 503)).toBe(true);
    await expect(page.locator(".comment-translation")).toHaveCount(0);
  } finally {
    await close(context);
  }
});
