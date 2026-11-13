import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { close, expect, newPage, test } from "./coverage";
import { accounts, runSql, signedIn } from "./fixtures";
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
  test(`mobile discussion at ${width}px wraps content and retains draft, reading position, and voting`, async ({ browser }) => {
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
      const composer = page.getByRole("textbox", { name: "Write a comment" });
      await composer.fill("Keep this mobile draft.");
      await page.getByRole("button", { name: "Open discussion", exact: true }).tap();
      await expect(page).toHaveURL(/discussion=1/);
      await expect(page.getByRole("button", { name: "Back to topic", exact: true })).toBeFocused();
      await expect(page.locator(".site-footer")).toBeHidden();
      await expect(page.locator(".topic-content .votes")).toBeHidden();
      await expect(composer).toHaveValue("Keep this mobile draft.");
      expect(await page.locator("#detail").evaluate((element: HTMLElement) => element.clientWidth)).toBeGreaterThanOrEqual(width - 2);
      expect(await page.locator("#detail").evaluate((element: HTMLElement) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.locator(".comment-body").first().evaluate((element: HTMLElement) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

      await page.locator("#detail").evaluate((element: HTMLElement) => { element.scrollTop = 500; });
      await expect.poll(() => page.locator("#detail").evaluate((element: HTMLElement) => element.scrollTop)).toBeGreaterThan(400);
      const readAt: number = await page.locator("#detail").evaluate((element: HTMLElement) => element.scrollTop);
      await page.goBack();
      await expect(page).not.toHaveURL(/discussion=1/);
      await expect(page.locator(".topic-content .votes")).toBeVisible();
      await expect(page.locator(".site-footer")).toBeVisible();
      await expect(page.locator(".site-footer").getByRole("link", { name: "Privacy", exact: true }).last()).toBeVisible();
      await expect(composer).toHaveValue("Keep this mobile draft.");
      await page.goForward();
      await expect(page).toHaveURL(/discussion=1/);
      await expect.poll(() => page.locator("#detail").evaluate((element: HTMLElement) => element.scrollTop)).toBeCloseTo(readAt, 0);
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
    const composer = page.getByRole("textbox", { name: "Write a comment" });
    await composer.fill("Long draft line\n".repeat(90));
    await composer.focus();
    // A smaller viewport exercises layout recovery; desktop emulation does not open a real keyboard.
    await page.setViewportSize({ width: 390, height: 430 });
    await expect.poll(async () => Math.round((await page.locator(".discussion-focus").boundingBox())?.height ?? 0)).toBe(430);
    const bounds = await composer.boundingBox();
    expect(bounds).not.toBeNull();
    expect((bounds?.y ?? 430) + (bounds?.height ?? 430)).toBeLessThan(430);
    await page.locator("#detail").evaluate((element: HTMLElement) => { element.scrollTop = 300; });
    const before: number = await page.locator("#detail").evaluate((element: HTMLElement) => element.scrollTop);
    await touchScroll(page, 395, 275);
    await expect.poll(() => page.locator("#detail").evaluate((element: HTMLElement) => element.scrollTop)).toBeGreaterThan(before);
    await expect(composer).toBeFocused();
    await composer.evaluate((element: HTMLTextAreaElement) => { element.scrollTop = 0; });
    const textarea = await composer.boundingBox();
    if (!textarea) throw new Error("Composer is not visible.");
    await touchScroll(page, textarea.y + textarea.height - 15, textarea.y + 15);
    await expect.poll(() => composer.evaluate((element: HTMLTextAreaElement) => element.scrollTop)).toBeGreaterThan(0);
    await page.setViewportSize({ width: 670, height: 390 });
    await expect(composer).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to topic", exact: true })).toBeVisible();
    expect(await page.locator("#detail").evaluate((element: HTMLElement) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toHaveValue("Long draft line\n".repeat(90));
  } finally {
    await close(context);
  }
});
