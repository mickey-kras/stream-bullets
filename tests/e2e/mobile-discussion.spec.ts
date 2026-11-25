import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { close, expect, newPage, test } from "./coverage";
import { accounts, commentBox, expectCommentText, runSql, signedIn } from "./fixtures";
import { clientIp } from "./client-ips";

async function discussion(): Promise<string> {
  const entryId: string = randomUUID();
  const userId: string = (await accounts()).viewer.id;
  const authorId: string = randomUUID();
  const parentId: string = randomUUID();
  const now: number = Date.now();
  const longText: string = `A long discussion message https://example.com/${"longpath".repeat(25)}`;
  const statements: string[] = [
    `INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('${authorId}','${"LongViewerName".repeat(3)}','${authorId}@example.test',1,${now},${now});`,
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,created_at) SELECT '${entryId}',id,'${userId}','topic','Mobile discussion','Read comments or vote on this topic.','Just chatting',${now} FROM streamers WHERE handle='test_host';`,
  ];
  for (let index = 0; index < 24; index += 1) {
    const id: string = index === 0 ? parentId : randomUUID();
    const parent: string = index === 1 ? `'${parentId}'` : "NULL";
    statements.push(
      `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at,parent_id) VALUES ('${id}','${entryId}','${authorId}','${longText} ${index}',${now + index},${parent});`,
    );
  }
  await runSql(`mobile-discussion-${entryId}`, statements);
  return entryId;
}

async function touchScroll(page: Page, from: number, to: number): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 200, y: from }] });
    for (let step = 1; step <= 8; step += 1) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 200, y: from + ((to - from) * step) / 8 }],
      });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await client.detach();
  }
}

for (const width of [320, 390]) {
  test(`mobile discussion at ${width}px wraps content and retains draft, reading position, and voting`, async ({
    browser,
  }) => {
    const entryId: string = await discussion();
    const context = await signedIn(browser, "viewer", clientIp("mobile-discussion", width === 320 ? 170 : 171), {
      viewport: { width, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    try {
      const page = await newPage(context);
      await page.goto(`/@test_host?entry=${entryId}`);
      await expect(page.locator("article.comment")).toHaveCount(24);
      const composer = commentBox(page, "Write a comment");
      await composer.fill("Keep this mobile draft.");
      // The comment field takes the full row. The Post button is below it.
      const field = await page.locator(".discussion > .composer > .comment-input").boundingBox();
      const post = await page.locator(".discussion > .composer > button").boundingBox();
      const row = await page.locator(".discussion > .composer").boundingBox();
      expect(field?.width ?? 0).toBeGreaterThanOrEqual((row?.width ?? width) - 1);
      expect(post?.y ?? 0).toBeGreaterThanOrEqual((field?.y ?? 0) + (field?.height ?? 0));
      // The delete control is an icon at the right of the Open discussion row.
      const open = await page.getByRole("button", { name: "Open discussion", exact: true }).boundingBox();
      const remove = await page.getByRole("button", { name: "Delete topic", exact: true }).boundingBox();
      expect(remove?.width ?? 0).toBe(44);
      expect(remove?.x ?? 0).toBeGreaterThanOrEqual((open?.x ?? 0) + (open?.width ?? 0));
      expect(remove?.y ?? 0).toBeLessThan((open?.y ?? 0) + (open?.height ?? 0));
      expect((remove?.y ?? 0) + (remove?.height ?? 0)).toBeGreaterThan(open?.y ?? 0);
      await page.getByRole("button", { name: "Open discussion", exact: true }).tap();
      await expect(page).toHaveURL(/discussion=1/);
      await expect(page.getByRole("button", { name: "Back to topic", exact: true })).toBeFocused();
      await expect(page.locator(".site-footer")).toBeHidden();
      await expect(page.locator(".topic-content .votes")).toBeHidden();
      await expectCommentText(composer, "Keep this mobile draft.");
      expect(
        await page.locator("#detail").evaluate((element: HTMLElement) => element.clientWidth),
      ).toBeGreaterThanOrEqual(width - 2);
      expect(
        await page.locator("#detail").evaluate((element: HTMLElement) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(1);
      expect(
        await page
          .locator(".comment-body")
          .first()
          .evaluate((element: HTMLElement) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(1);

      await page.locator("#detail").evaluate((element: HTMLElement) => {
        element.scrollTop = 500;
      });
      await expect
        .poll(() => page.locator("#detail").evaluate((element: HTMLElement) => element.scrollTop))
        .toBeGreaterThan(400);
      const readAt: number = await page.locator("#detail").evaluate((element: HTMLElement) => element.scrollTop);
      await page.goBack();
      await expect(page).not.toHaveURL(/discussion=1/);
      await expect(page.locator(".topic-content .votes")).toBeVisible();
      await expect(page.locator(".site-footer")).toBeVisible();
      await expect(
        page.locator(".site-footer").getByRole("link", { name: "Privacy", exact: true }).last(),
      ).toBeVisible();
      await expectCommentText(composer, "Keep this mobile draft.");
      await page.goForward();
      await expect(page).toHaveURL(/discussion=1/);
      await expect
        .poll(() => page.locator("#detail").evaluate((element: HTMLElement) => element.scrollTop))
        .toBeCloseTo(readAt, 0);
      await page.getByRole("button", { name: "Back to topic", exact: true }).tap();
      await expect(page).not.toHaveURL(/discussion=1/);
    } finally {
      await close(context);
    }
  });
}

test("focused composer permits touch scrolling after reduced-height and orientation changes", async ({ browser }) => {
  const entryId: string = await discussion();
  const context = await signedIn(browser, "viewer", clientIp("mobile-discussion", 172), {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await newPage(context);
    await page.goto(`/@test_host?entry=${entryId}&discussion=1`);
    await expect(page.locator("article.comment")).toHaveCount(24);
    const composer = commentBox(page, "Write a comment");
    await composer.fill("Long draft line\n".repeat(90));
    await composer.focus();
    // A smaller viewport exercises layout recovery; desktop emulation does not open a real keyboard.
    await page.setViewportSize({ width: 390, height: 430 });
    await expect
      .poll(async () => Math.round((await page.locator(".discussion-focus").boundingBox())?.height ?? 0))
      .toBe(430);
    const bounds = await composer.boundingBox();
    expect(bounds).not.toBeNull();
    expect((bounds?.y ?? 430) + (bounds?.height ?? 430)).toBeLessThan(430);
    await page.locator("#detail").evaluate((element: HTMLElement) => {
      element.scrollTop = 300;
    });
    const before: number = await page.locator("#detail").evaluate((element: HTMLElement) => element.scrollTop);
    await touchScroll(page, 395, 275);
    await expect
      .poll(() => page.locator("#detail").evaluate((element: HTMLElement) => element.scrollTop))
      .toBeGreaterThan(before);
    await expect(composer).toBeFocused();
    await composer.evaluate((element: HTMLElement) => {
      element.scrollTop = 0;
    });
    const textarea = await composer.boundingBox();
    if (!textarea) throw new Error("Composer is not visible.");
    await touchScroll(page, textarea.y + textarea.height - 15, textarea.y + 15);
    await expect.poll(() => composer.evaluate((element: HTMLElement) => element.scrollTop)).toBeGreaterThan(0);
    await page.setViewportSize({ width: 670, height: 390 });
    await expect(composer).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to topic", exact: true })).toBeVisible();
    expect(
      await page.locator("#detail").evaluate((element: HTMLElement) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectCommentText(composer, "Long draft line\n".repeat(90));
  } finally {
    await close(context);
  }
});

for (const width of [1280, 390]) {
  test(`header language switch at ${width}px keeps the comment draft and the reading position`, async ({ browser }) => {
    const entryId: string = await discussion();
    const context = await signedIn(browser, "viewer", clientIp("mobile-discussion", width === 390 ? 173 : 174), {
      viewport: { width, height: 844 },
    });
    try {
      const page = await newPage(context);
      await page.goto(`/@test_host?entry=${entryId}`);
      await expect(page.locator("article.comment")).toHaveCount(24);
      const composer = page.locator("#detail .ed-content[data-composer]").first();
      await composer.fill("Keep this draft in every language.");
      const detail = page.locator("#detail");
      const top = (): Promise<number> => detail.evaluate((element: HTMLElement) => element.scrollTop);
      await detail.evaluate((element: HTMLElement) => {
        element.scrollTop = 900;
      });
      await expect.poll(top).toBeGreaterThan(800);
      const readAt: number = await top();
      const address: string = page.url();
      await page.locator(".site-header").getByRole("button", { name: "Language: English" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Русский" }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "ru");
      expect(page.url()).toBe(address);
      await expect(page.locator("article.comment")).toHaveCount(24);
      await expectCommentText(composer, "Keep this draft in every language.");
      // Translated labels change the height of rows, so the position holds within one row.
      await expect.poll(async () => Math.abs((await top()) - readAt)).toBeLessThanOrEqual(48);
    } finally {
      // The viewer account is shared; later specs expect its seeded English setting.
      await context.request.patch("/api/me/locale", { data: { locale: "en" } });
      await close(context);
    }
  });
}

test("an open discussion moves each comment age without the page clock", async ({ page }) => {
  const entryId: string = await discussion();
  await page.clock.install({ time: Date.now() });
  await page.goto(`/@test_host?entry=${entryId}`);
  const age = page.locator("article.comment time").first();
  await expect(age).toHaveText(/seconds? ago|now/);
  await page.clock.runFor(150_000);
  await expect(age).toHaveText("2 minutes ago");
});
