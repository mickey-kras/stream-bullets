import { randomUUID } from "node:crypto";
import { close, expect, newPage, test } from "./coverage";
import { accounts, runSql, signedIn } from "./fixtures";
import { clientIp } from "./client-ips";

test("the page owner marks a comment as answered during a stream, and every reader sees the link", async ({
  browser,
}) => {
  const users = await accounts();
  const entryId: string = randomUUID();
  const commentId: string = randomUUID();
  const eventId: string = randomUUID();
  const now: number = Date.now();
  await runSql("comment-answer", [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,created_at) SELECT '${entryId}',id,'${users.viewer.id}','topic','Answered questions','Ask during the stream.','Just chatting',${now} FROM streamers WHERE handle='test_host';`,
    `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at) VALUES ('${commentId}','${entryId}','${users.viewer.id}','Which game is next?',${now});`,
    `INSERT INTO stream_events(id,streamer_id,title,starts_at,duration_min,platform,url,tz,created_at,updated_at) SELECT '${eventId}',id,'Answer stream',${now - 30 * 60_000},120,'youtube','https://www.youtube.com/watch?v=answer1','UTC',${now},${now} FROM streamers WHERE handle='test_host';`,
  ]);
  const owner = await signedIn(browser, "owner", clientIp("comment-answer", 20));
  const viewer = await signedIn(browser, "viewer", clientIp("comment-answer", 21));
  try {
    const ownerPage = await newPage(owner);
    await ownerPage.goto(`/@test_host?view=topics&entry=${entryId}`);
    const comment = ownerPage.locator(`#cm-${commentId}`);
    await comment.getByRole("button", { name: "Mark as answered" }).click();
    const link = comment.getByRole("link", { name: /^Answered on stream: Answer stream/ });
    await expect(link).toHaveAttribute("href", /^https:\/\/www\.youtube\.com\/watch\?v=answer1&t=1[45]\d\ds$/);
    await comment.getByLabel("Time code in seconds").fill("90");
    await comment.getByRole("button", { name: "Save", exact: true }).click();
    await expect(link).toHaveAttribute("href", "https://www.youtube.com/watch?v=answer1&t=90s");

    // The author of the comment sees the mark and no control.
    const page = await newPage(viewer);
    await page.goto(`/@test_host?view=topics&entry=${entryId}`);
    const seen = page.locator(`#cm-${commentId}`);
    await expect(seen.getByRole("link", { name: /^Answered on stream: Answer stream/ })).toHaveAttribute(
      "href",
      "https://www.youtube.com/watch?v=answer1&t=90s",
    );
    await expect(seen.getByRole("button", { name: "Mark as answered" })).toHaveCount(0);
    await expect(seen.getByRole("button", { name: "Remove the answered mark" })).toHaveCount(0);

    // A new time code reaches an open discussion with a refresh, without a page reload.
    await comment.getByLabel("Time code in seconds").fill("120");
    await comment.getByRole("button", { name: "Save", exact: true }).click();
    await expect(link).toHaveAttribute("href", "https://www.youtube.com/watch?v=answer1&t=120s");
    await page.getByRole("button", { name: "Refresh comments" }).click();
    await expect(seen.getByRole("link", { name: /^Answered on stream: Answer stream/ })).toHaveAttribute(
      "href",
      "https://www.youtube.com/watch?v=answer1&t=120s",
    );

    await comment.getByRole("button", { name: "Remove the answered mark" }).click();
    await expect(comment.getByRole("button", { name: "Mark as answered" })).toBeVisible();
    await page.reload();
    await expect(page.locator(`#cm-${commentId}`).getByText(/Answered/)).toHaveCount(0);
  } finally {
    await close(owner);
    await close(viewer);
  }
});

test("the page owner sets the lead of the time code in the page dialog", async ({ browser }) => {
  const owner = await signedIn(browser, "owner", clientIp("comment-answer", 20));
  try {
    const page = await newPage(owner);
    await page.goto("/@test_host?dialog=page");
    const dialog = page.getByRole("dialog", { name: "Edit your page" });
    const lead = dialog.getByLabel("Answered comments: time code before the mark, in minutes");
    await expect(lead).toHaveValue("5");
    await lead.fill("10");
    await dialog.getByRole("button", { name: "Save page" }).click();
    await expect(dialog).toBeHidden();
    expect(await (await owner.request.get("/api/streamer/answer-lead")).json()).toEqual({ leadMinutes: 10 });
  } finally {
    // Other specs expect the default lead.
    await owner.request.put("/api/streamer/answer-lead", { data: { leadMinutes: 5 } });
    await close(owner);
  }
});
