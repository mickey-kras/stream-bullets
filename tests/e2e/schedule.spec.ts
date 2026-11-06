import { expect, test } from "@playwright/test";
import { dateFromToday, signedIn } from "./fixtures";

test("viewers see the feed, the calendar views on desktop only, and a stable column", async ({ page }) => {
  await page.goto("/@feature_host?view=schedule");
  await expect(page.getByRole("heading", { name: "Stream schedule" })).toBeVisible();
  const hero = page.locator(".sched-hero");
  await expect(hero.getByRole("button", { name: "Mic shootout" })).toBeVisible();
  await expect(hero.getByRole("link", { name: "Mic shootout" })).toHaveAttribute("href", /entry=/);
  await expect(page.locator(".sched-upcoming")).toContainText("Variety night");
  await expect(page.locator(".sched-upcoming .series-note")).toContainText("every");
  await expect(page.locator(".sched-past").getByRole("link", { name: /Watch replay/ })).toHaveAttribute(
    "href",
    "https://twitch.tv/videos/1",
  );
  const width = async (): Promise<number> => (await page.locator(".page-column").boundingBox())?.width ?? 0;
  const feedWidth = await width();
  for (const mode of ["Day", "Week", "Month"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await expect(page.getByRole("button", { name: mode, exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await width()).toBe(feedWidth);
  }
  await expect(page.locator("table.month-grid")).toBeVisible();
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(page.locator(".cal-grid .cal-event").first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Week", exact: true })).toBeHidden();
  await expect(page.getByRole("note")).toContainText("Week and Month views are available on larger screens.");
  await expect(page.locator(".sched-hero")).toBeVisible();
});

test("the event dialog shows the stream and the .ics feed serves the schedule", async ({ page, request }) => {
  await page.goto("/@feature_host?view=schedule");
  await page.locator(".sched-hero").getByRole("button", { name: "Mic shootout" }).click();
  const dialog = page.getByRole("dialog", { name: "Mic shootout" });
  await expect(dialog).toContainText("Bring your questions.");
  await expect(dialog.getByRole("button", { name: "Add to calendar" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page).toHaveURL(/event=/);
  const feed = await request.get("/@feature_host/schedule.ics");
  expect(feed.status()).toBe(200);
  expect(feed.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
  expect(feed.headers()["cache-control"]).toBe("public, max-age=300");
  const text = await feed.text();
  expect(text).toContain("BEGIN:VCALENDAR\r\n");
  expect(text).toMatch(/UID:[0-9a-f-]{36}@streambullets\.com/);
  expect(text).toContain("SUMMARY:Mic shootout");
  expect((await request.get("/@suspended_host/schedule.ics")).status()).toBe(404);
  expect((await request.get("/@nobody_here/schedule.ics")).status()).toBe(404);
});

test("the owner schedules a weekly stream, edits, cancels and deletes it", async ({ browser }) => {
  const context = await signedIn(browser, "featureowner", 90);
  const page = await context.newPage();
  await page.goto("/@feature_host?view=schedule");
  // The header action matches the tab.
  await page.locator("#suggest").click();
  const form = page.getByRole("dialog", { name: "Schedule a stream" });
  await form.getByLabel("Title").fill("Speedrun practice");
  await form.getByLabel("Date").fill(dateFromToday(3));
  await form.getByLabel("Start time").fill("19:30");
  await form.getByLabel("Repeat weekly").check();
  await expect(form.getByRole("group", { name: "Repeat on" }).getByRole("button", { pressed: true })).toHaveCount(1);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toBeHidden();
  await expect(page.locator(".sb-toast")).toContainText("Stream saved.");
  const row = page.locator(".sched-row").filter({ hasText: "Speedrun practice" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("every");
  await row.getByRole("button").first().click();
  const dialog = page.getByRole("dialog", { name: "Speedrun practice" });
  await dialog.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit stream" });
  await edit.getByLabel("Title").fill("Speedrun practice night");
  await edit.getByRole("radio", { name: "This and following streams" }).check();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".sched-row").filter({ hasText: "Speedrun practice night" })).toHaveCount(1);
  await page.locator(".sched-row").filter({ hasText: "Speedrun practice night" }).getByRole("button").first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel stream" }).click();
  await page
    .getByRole("dialog", { name: "Cancel this stream?" })
    .getByRole("button", { name: "Cancel stream" })
    .click();
  await expect(page.locator(".sb-toast")).toContainText("Stream cancelled.");
  const cancelled = page.locator(".sched-row.status-cancelled").filter({ hasText: "Speedrun practice night" });
  await expect(cancelled).toContainText("Cancelled");
  const feed = await context.request.get("/@feature_host/schedule.ics");
  expect(await feed.text()).toContain("STATUS:CANCELLED");
  await cancelled.getByRole("button").first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete this stream?" });
  await confirm.getByRole("radio", { name: "This and following streams" }).check();
  await confirm.getByRole("button", { name: "Delete stream" }).click();
  await expect(page.locator(".sched-row").filter({ hasText: "Speedrun practice" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("button.fab")).toHaveText("Schedule a stream");
  await context.close();
});

test("schedule writes are owner-only and refused on frozen pages", async ({ browser }) => {
  const viewer = await signedIn(browser, "viewer", 91);
  const body = {
    title: "Not mine",
    date: dateFromToday(2),
    time: "18:00",
    tz: "UTC",
    durationMin: 60,
    platform: "twitch",
    url: "https://twitch.tv/x",
  };
  expect((await viewer.request.post("/api/events", { data: body })).status()).toBe(403);
  const frozen = await signedIn(browser, "frozenowner", 92);
  expect((await frozen.request.post("/api/events", { data: body })).status()).toBe(423);
  await viewer.close();
  await frozen.close();
});
