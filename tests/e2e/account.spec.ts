import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { z } from "zod";

const origin: string = "http://localhost:5173";
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));
const boardSchema = z.object({ entries: z.array(z.object({ id: z.string(), title: z.string() })) });
const commentsSchema = z.object({
  comments: z.array(z.object({ text: z.string(), parentId: z.string().nullable() })),
});

test("a member downloads their data, deletes their account, and is signed out", async ({ browser, request }) => {
  const sessions = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
  const leaver = sessions.leaver;
  if (!leaver) throw new Error("Unknown test account.");
  const context = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { "CF-Connecting-IP": "192.0.2.40" } });
  await context.addCookies([
    {
      name: "stream-bullets.session_token",
      value: leaver.cookie,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Your data" })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download my data" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^streambullets-data-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = await readFile(await download.path(), "utf8");
  const data = JSON.parse(exported) as {
    account: { id: string; email: string };
    streamerPage: { handle: string } | null;
    comments: { text: string }[];
  };
  expect(data.account).toMatchObject({ id: leaver.id, email: "leaver@example.test" });
  expect(data.streamerPage?.handle).toBe("leaver_host");
  expect(data.comments.map((comment) => comment.text)).toEqual(["Leaver comment"]);
  expect(exported).not.toContain(decodeURIComponent(leaver.cookie).split(".")[0]);

  await page.getByRole("button", { name: "Delete my account" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete your account?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep my account" })).toBeFocused();
  await expect(dialog).toContainText("Replies other people wrote under your comments stay");
  const confirm = dialog.getByRole("button", { name: "Delete my account" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Type DELETE to confirm").fill("delete");
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
  await confirm.click();
  await page.waitForURL(`${origin}/`);

  const cookies = await context.cookies();
  expect(cookies.find((cookie) => cookie.name === "stream-bullets.session_token")).toBeUndefined();
  const stale = await request.get("/api/me", {
    headers: { Cookie: `stream-bullets.session_token=${leaver.cookie}` },
  });
  expect(((await stale.json()) as { viewer: unknown }).viewer).toBeNull();
  const exportAfter = await request.get("/api/account/export", {
    headers: { Cookie: `stream-bullets.session_token=${leaver.cookie}` },
  });
  expect(exportAfter.status()).toBe(401);
  expect((await request.get("/api/streamers/leaver_host")).status()).toBe(404);

  const board = boardSchema.parse(await (await request.get("/api/streamers/other_host")).json());
  const topic = board.entries.find((entry) => entry.title === "Leaver discussion");
  if (!topic) throw new Error("The discussion should remain.");
  const discussion = commentsSchema.parse(await (await request.get(`/api/entries/${topic.id}/comments`)).json());
  expect(discussion.comments).toEqual([expect.objectContaining({ text: "Reply that stays", parentId: null })]);
  await context.close();
});
