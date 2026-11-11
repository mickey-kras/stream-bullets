import { newPage, close } from "./coverage";
import { expect, test } from "./coverage";
import { dateFromToday, signedIn } from "./fixtures";
import { clientIp } from "./client-ips";

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

test("an open Schedule tab moves a stream from upcoming to live to ended", async ({ page }) => {
  // Mic shootout starts a day after the seed and runs for three hours.
  await page.clock.install({ time: Date.now() });
  await page.goto("/@feature_host?view=schedule");
  const hero = page.locator(".sched-hero");
  await expect(hero).toHaveClass(/status-scheduled/);
  await expect(hero).toContainText("Mic shootout");
  await page.clock.fastForward("25:00:00");
  await expect(hero).toHaveClass(/status-live/);
  await expect(hero).toContainText("Scheduled now");
  await expect(hero).toContainText("Mic shootout");
  await page.clock.fastForward("03:00:00");
  await expect(hero).toContainText("Variety night");
  await expect(page.locator(".sched-past")).toContainText("Mic shootout");
});

test("an open Topics tab shows and hides the live badge as a stream starts and ends", async ({ page }) => {
  await page.clock.install({ time: Date.now() });
  await page.goto("/@feature_host");
  const badge = page.locator(".live-pill");
  const strip = page.locator(".live-strip");
  await expect(page.getByRole("heading", { name: "Feature host" })).toBeVisible();
  await expect(badge).toHaveCount(0);
  await page.clock.fastForward("25:00:00");
  await expect(badge).toContainText("Mic shootout");
  await expect(strip).toContainText("Mic shootout");
  await page.clock.fastForward("03:00:00");
  await expect(badge).toHaveCount(0);
  await expect(strip).toHaveCount(0);
});

test("the owner schedules a weekly stream, edits, cancels and deletes it", async ({ browser }) => {
  const context = await signedIn(browser, "featureowner", clientIp("schedule", 125));
  const page = await newPage(context);
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
  await close(context);
});

test("the calendar keeps far-off streams after the owner creates and cancels them there", async ({ browser }) => {
  const context = await signedIn(browser, "featureowner", clientIp("schedule", 128));
  const page = await newPage(context);
  await page.goto("/@feature_host?view=schedule&mode=month");
  // Five months on, past what the page loads at first: the calendar fetches this range on its own.
  for (let step = 0; step < 5; step += 1) await page.getByRole("button", { name: "Next", exact: true }).click();
  const chip = (title: string) => page.locator(".month-chip").filter({ hasText: title });
  const create = async (title: string, days: number): Promise<void> => {
    await page.locator(".sched-toolbar").getByRole("button", { name: "Schedule a stream" }).click();
    const form = page.getByRole("dialog", { name: "Schedule a stream" });
    await form.getByLabel("Title").fill(title);
    await form.getByLabel("Date").fill(dateFromToday(days));
    await form.getByLabel("Start time").fill("19:30");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form).toBeHidden();
  };
  await create("Far stream one", 160);
  await expect(chip("Far stream one")).toBeVisible();
  await create("Far stream two", 161);
  await expect(chip("Far stream one")).toBeVisible();
  await expect(chip("Far stream two")).toBeVisible();
  await chip("Far stream one").click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel stream" }).click();
  await page
    .getByRole("dialog", { name: "Cancel this stream?" })
    .getByRole("button", { name: "Cancel stream" })
    .click();
  await expect(page.locator(".sb-toast")).toContainText("Stream cancelled.");
  await expect(page.locator(".month-chip.status-cancelled").filter({ hasText: "Far stream one" })).toBeVisible();
  await expect(chip("Far stream two")).toBeVisible();
  // Leave the page as it was.
  const range = `from=${Date.now() + 150 * 86_400_000}&to=${Date.now() + 170 * 86_400_000}`;
  const listed = await context.request.get(`/api/streamers/feature_host/events?${range}`);
  for (const event of ((await listed.json()) as { events: { id: string; title: string }[] }).events)
    if (event.title.startsWith("Far stream"))
      expect((await context.request.delete(`/api/events/${event.id}`)).status()).toBe(200);
  await close(context);
});

test("switching from Day to Week far ahead fetches the rest of the week", async ({ browser }) => {
  const context = await signedIn(browser, "featureowner", clientIp("schedule", 129));
  const page = await newPage(context);
  await page.goto("/@feature_host?view=schedule&mode=week");
  // 22 weeks on, past what the page loads at first, then the Day view of the same weekday as today.
  for (let step = 0; step < 22; step += 1) await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Day", exact: true }).click();
  await expect(page.getByRole("button", { name: "Day", exact: true })).toHaveAttribute("aria-pressed", "true");
  // A stream two days away in the same week, saved after that week was fetched: only a new fetch can show it.
  const day = new Date(Date.now() + 22 * 7 * 86_400_000);
  day.setDate(day.getDate() + (day.getDay() <= 4 ? 2 : -2));
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const stream = { title: "Midweek far stream", date, time: "12:00", tz, durationMin: 60 };
  const created = await context.request.post("/api/events", {
    data: { ...stream, platform: "twitch", url: "https://twitch.tv/x" },
  });
  expect(created.status()).toBe(200);
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(page.locator(".cal-grid .cal-event").filter({ hasText: "Midweek far stream" })).toBeVisible();
  const { event } = (await created.json()) as { event: { id: string } };
  expect((await context.request.delete(`/api/events/${event.id}`)).status()).toBe(200);
  await close(context);
});

test("a page with only far-off streams keeps the calendar open to them", async ({ browser, page }) => {
  const owner = await signedIn(browser, "paginationowner", clientIp("schedule", 132));
  const stream = { title: "Distant premiere", date: dateFromToday(120), time: "12:00", tz: "UTC", durationMin: 60 };
  const created = await owner.request.post("/api/events", {
    data: { ...stream, platform: "twitch", url: "https://twitch.tv/x" },
  });
  expect(created.status()).toBe(200);
  // Nothing falls in the range the page loads: the Feed shows the empty state and the views stay one click away.
  await page.goto("/@pagination_host?view=schedule");
  await expect(page.getByText("No streams in this date range.")).toBeVisible();
  await page.getByRole("button", { name: "Month", exact: true }).click();
  const today = new Date();
  const target = new Date(Date.now() + 120 * 86_400_000);
  const months = (target.getFullYear() - today.getFullYear()) * 12 + target.getMonth() - today.getMonth();
  for (let step = 0; step < months; step += 1) await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".month-chip").filter({ hasText: "Distant premiere" })).toBeVisible();
  await page.goto("/@pagination_host?view=schedule&mode=month");
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeVisible();
  const { event } = (await created.json()) as { event: { id: string } };
  expect((await owner.request.delete(`/api/events/${event.id}`)).status()).toBe(200);
  await close(owner);
});

test("the Day view gives early streams their own rows", async ({ browser }) => {
  const context = await signedIn(browser, "featureowner", clientIp("schedule", 131));
  const page = await newPage(context);
  await page.goto("/@feature_host?view=schedule&mode=day");
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  // One daily series (the page owner may create only six streams a minute), then two of its streams moved onto
  // the first day at 04:00 and 07:00 with "This stream".
  const stream = { title: "Early", date: dateFromToday(2), time: "01:00", tz, durationMin: 60 };
  const link = { platform: "twitch", url: "https://twitch.tv/x" };
  const created = await context.request.post("/api/events", { data: { ...stream, ...link, repeatDays: 127 } });
  expect(created.status()).toBe(200);
  const first = ((await created.json()) as { event: { id: string; startsAt: number } }).event;
  const range = `from=${first.startsAt}&to=${first.startsAt + 5 * 86_400_000}`;
  const listed = (await (await context.request.get(`/api/streamers/feature_host/events?${range}`)).json()) as {
    events: { id: string; title: string }[];
  };
  const others = listed.events.filter((event) => event.title === "Early" && event.id !== first.id).slice(0, 2);
  for (const [index, time] of ["04:00", "07:00"].entries()) {
    const edit = { action: "edit", scope: "one", ...stream, ...link, time };
    expect((await context.request.patch(`/api/events/${others[index].id}`, { data: edit })).status()).toBe(200);
  }
  for (let step = 0; step < 2; step += 1) await page.getByRole("button", { name: "Next", exact: true }).click();
  const blocks = page.locator(".cal-grid .cal-event").filter({ hasText: "Early" });
  await expect(blocks).toHaveCount(3);
  const boxes = await Promise.all([0, 1, 2].map(async (index: number) => (await blocks.nth(index).boundingBox())!));
  boxes.sort((a, b) => a.y - b.y);
  for (let index = 1; index < boxes.length; index += 1)
    expect(boxes[index].y).toBeGreaterThanOrEqual(boxes[index - 1].y + boxes[index - 1].height);

  // A fourth stream moved onto 04:00 sits beside the one there, and a real click on each opens its own stream.
  const clash = listed.events.find((event) => event.title === "Early" && ![first.id, ...others.map((o) => o.id)].includes(event.id))!;
  const moved = { action: "edit", scope: "one", ...stream, ...link, time: "04:00", title: "Early clash" };
  expect((await context.request.patch(`/api/events/${clash.id}`, { data: moved })).status()).toBe(200);
  await page.reload();
  for (let step = 0; step < 2; step += 1) await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(blocks).toHaveCount(4);
  const pair = await Promise.all(
    ["Early clash", "Early"].map(async (title: string) => {
      const block = blocks.filter({ has: page.getByText(title, { exact: true }) });
      return { title, block, box: await block.nth(title === "Early" ? 1 : 0).boundingBox() };
    }),
  );
  const [a, b] = [pair[0].box!, pair[1].box!];
  expect(Math.abs(a.y - b.y)).toBeLessThan(1);
  expect(Math.max(a.x, b.x)).toBeGreaterThanOrEqual(Math.min(a.x + a.width, b.x + b.width));
  for (const { title, block } of pair) {
    await block.nth(title === "Early" ? 1 : 0).click();
    await expect(page.getByRole("dialog", { name: title })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }

  // A fifth stream moved onto 23:00 for four hours goes on at the top of the next day, which has no other stream.
  const used = [first.id, clash.id, ...others.map((other) => other.id)];
  const night = listed.events.find((event) => event.title === "Early" && !used.includes(event.id))!;
  const owl = { title: "Night owl", time: "23:00", durationMin: 240 };
  const late = { action: "edit", scope: "one", ...stream, ...link, ...owl };
  expect((await context.request.patch(`/api/events/${night.id}`, { data: late })).status()).toBe(200);
  await page.reload();
  for (let step = 0; step < 3; step += 1) await page.getByRole("button", { name: "Next", exact: true }).click();
  const rest = page.locator(".cal-grid .cal-event").filter({ hasText: "Night owl" });
  await expect(rest).toBeVisible();
  const [restBox, topHour] = [await rest.boundingBox(), await page.locator(".cal-hour").first().boundingBox()];
  expect(Math.abs(restBox!.y - topHour!.y)).toBeLessThan(2);
  const deleted = await context.request.delete(`/api/events/${first.id}`, { data: { scope: "following" } });
  expect(deleted.status()).toBe(200);
  await close(context);
});

test("schedule writes are owner-only and refused on frozen pages", async ({ browser }) => {
  const viewer = await signedIn(browser, "viewer", clientIp("schedule", 126));
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
  const frozen = await signedIn(browser, "frozenowner", clientIp("schedule", 127));
  expect((await frozen.request.post("/api/events", { data: body })).status()).toBe(423);
  await close(viewer);
  await close(frozen);
});
