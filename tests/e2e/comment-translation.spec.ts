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
    await page.route("**/api/entries/*/translation", (route) => route.fulfill({ json: { translation: null } }));
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

test("a reader who reads a language sees its comments in the original text", async ({ browser }) => {
  const users = await accounts();
  const entryId: string = randomUUID();
  const now: number = Date.now() - 600_000;
  const ukrainian: string = "Дякую за стрім, було дуже цікаво!";
  await runSql("comment-translation", [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,created_at) SELECT '${entryId}',id,'${users.viewer.id}','topic','Keep topic','Body','Just chatting',${now} FROM streamers WHERE handle='other_host';`,
    `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at) VALUES ('${randomUUID()}','${entryId}','${users.reporter.id}','${ukrainian}',${now + 1});`,
  ]);
  const context = await signedIn(browser, "viewer", clientIp("comment-translation", 102));
  const page = await newPage(context);
  try {
    let asked: number = 0;
    await page.route("**/api/comments/*/translation", async (route) => {
      asked += 1;
      await route.fulfill({ json: { translation: { text: "Thanks for the stream!", mentions: [] } } });
    });
    await page.route("**/api/entries/*/translation", (route) => route.fulfill({ json: { translation: null } }));
    await page.goto(`/@other_host?entry=${entryId}`);
    const comment = page.locator("article.comment").filter({ hasText: "reporter" });
    await expect(comment.locator(".comment-text")).toHaveText("Thanks for the stream!");
    await page.goto(`/@other_host?entry=${entryId}&dialog=language`);
    // Each save replaces the whole list, so the other choices wait while one save runs.
    let release: () => void = (): void => {};
    const held = new Promise<void>((resolve): void => {
      release = resolve;
    });
    await page.route("**/api/me/keep-original", async (route) => {
      await held;
      await route.continue();
    });
    const saved = page.waitForResponse("**/api/me/keep-original");
    await page.getByRole("checkbox", { name: "Українська" }).check();
    await expect(page.getByRole("checkbox", { name: "Deutsch" })).toBeDisabled();
    release();
    expect((await saved).status()).toBe(200);
    await expect(page.getByRole("checkbox", { name: "Deutsch" })).toBeEnabled();
    const before: number = asked;
    // The open discussion loads its comments again, without a reload of the page.
    await page.keyboard.press("Escape");
    await expect(comment.locator(".comment-text")).toHaveText(ukrainian);
    await expect(comment.locator(".comment-translation")).toHaveCount(0);
    await page.goto(`/@other_host?entry=${entryId}`);
    await expect(comment.locator(".comment-text")).toHaveText(ukrainian);
    await expect(comment.locator(".comment-translation")).toHaveCount(0);
    // The server marks the comment as one that needs no translation, so the page asks for none.
    expect(asked).toBe(before);
  } finally {
    await runSql("comment-translation", [`UPDATE user SET keep_original=NULL WHERE id='${users.viewer.id}';`]);
    await close(context);
  }
});

test("a signed-out reader gets a stored translation and starts no new one", async ({ browser }) => {
  const { entryId, commentId } = await seedComments();
  await runSql("comment-translation", [
    `INSERT INTO comment_translations(comment_id,locale,source_hash,text,created_at) VALUES ('${commentId}','en','b50519076d50f1ce7796177e2ab3f8d9ee6a75faeb38ae6cb97b7b7aa0220092','**Hello** world',1);`,
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

test("a signed-in reader gets a topic in the site language and can see its original", async ({ browser }) => {
  const users = await accounts();
  const entryId: string = randomUUID();
  await runSql("comment-translation", [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,created_at) SELECT '${entryId}',id,'${users.reporter.id}','topic','Welches Spiel zuerst','Sagt es mir.','Just chatting',${Date.now() - 600_000} FROM streamers WHERE handle='other_host';`,
  ]);
  const context = await signedIn(browser, "viewer", clientIp("comment-translation", 101));
  const page = await newPage(context);
  try {
    const asked: unknown[] = [];
    await page.route("**/api/entries/*/translation", async (route) => {
      const body = route.request().postDataJSON() as { title: string };
      asked.push(body);
      const translation =
        body.title === "Welches Spiel zuerst" ? { title: "Which game first", body: "Tell me.", options: [] } : null;
      await route.fulfill({ json: { translation } });
    });
    await page.route("**/api/comments/*/translation", (route) => route.fulfill({ json: { translation: null } }));
    await page.goto(`/@other_host?entry=${entryId}`);
    const title = page.locator("h2.detail-title");
    await expect(title).toHaveText("Which game first");
    await expect(page.locator("p.description")).toHaveText("Tell me.");
    // The list of topics has the same text.
    await expect(page.getByText("Which game first").first()).toBeVisible();
    await page.getByRole("button", { name: "Show original", exact: true }).click();
    await expect(title).toHaveText("Welches Spiel zuerst");
    await expect(page.locator("p.description")).toHaveText("Sagt es mir.");
    await page.getByRole("button", { name: "Show translation", exact: true }).click();
    await expect(title).toHaveText("Which game first");
    expect(asked).toContainEqual({ locale: "en", title: "Welches Spiel zuerst", body: "Sagt es mir.", options: [] });
    expect(
      asked.filter((body: unknown): boolean => (body as { title: string }).title === "Welches Spiel zuerst"),
    ).toHaveLength(1);
  } finally {
    await close(context);
  }
});

test("a signed-out reader gets a stored translation of a poll and starts no new one", async ({ browser }) => {
  const users = await accounts();
  const entryId: string = randomUUID();
  await runSql("comment-translation", [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at) SELECT '${entryId}',id,'${users.reporter.id}','choice','Was kochen wir','','Just chatting','["Suppe","Kuchen"]',${Date.now() - 600_000} FROM streamers WHERE handle='other_host';`,
    `INSERT INTO entry_translations(entry_id,locale,source_hash,title,body,options,created_at) VALUES ('${entryId}','en','hash','What do we cook','','["Soup","Cake"]',1);`,
  ]);
  const page = await newPage(browser);
  try {
    let asked: number = 0;
    await page.route("**/translation", async (route) => {
      asked += 1;
      await route.abort();
    });
    await page.goto(`/@other_host?view=polls&entry=${entryId}`);
    await expect(page.getByRole("heading", { name: "What do we cook" }).first()).toBeVisible();
    await expect(page.getByText("Soup", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Cake", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Show original", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Was kochen wir" }).first()).toBeVisible();
    await expect(page.getByText("Suppe", { exact: true }).first()).toBeVisible();
    expect(asked).toBe(0);
  } finally {
    await close(page);
  }
});

test("the page asks again when a different reader has the translation in progress", async ({ browser }) => {
  const { entryId } = await seedComments();
  const context = await signedIn(browser, "viewer", clientIp("comment-translation", 102));
  const page = await newPage(context);
  try {
    let answers: number = 0;
    await page.route("**/api/comments/*/translation", async (route) => {
      const body = route.request().postDataJSON() as { text: string };
      if (body.text !== "**Hallo** Welt") return route.fulfill({ json: { translation: null } });
      answers += 1;
      if (answers === 1)
        return route.fulfill({ status: 409, json: { error: "The translation is not ready. Try again in a moment." } });
      return route.fulfill({ json: { translation: { text: "**Hello** world", mentions: [] } } });
    });
    await page.route("**/api/entries/*/translation", (route) => route.fulfill({ json: { translation: null } }));
    await page.goto(`/@other_host?entry=${entryId}`);
    const comment = page.locator("article.comment").filter({ hasText: "reporter" });
    await expect(comment.locator(".comment-text")).toHaveText("Hello world");
    expect(answers).toBe(2);
  } finally {
    await close(context);
  }
});
