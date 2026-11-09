import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { runSql, signedIn as fixtureSignedIn } from "./fixtures";
import { origin, shots, signedIn } from "./live-helpers";
import { clientAddress, clientIp } from "./client-ips";

test("the owner previews, takes and switches what the one OBS URL shows", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 90));
  const control = await owner.newPage();
  await control.setViewportSize({ width: 1440, height: 1000 });
  const obs = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await obs.goto("/@feature_host/overlay");
  await expect(obs.locator("[data-overlay-mash]")).toBeVisible();

  await control.goto("/overlay-control");
  await expect(control.getByRole("heading", { level: 1, name: "Overlay control" })).toBeVisible();
  await expect(control.locator('[data-ov-monitor="prev"] [data-overlay-source="topic"]')).toContainText("Mic shootout");
  if (shots) await control.screenshot({ path: `${shots}/overlay-control.png`, fullPage: true });

  await control.getByRole("button", { name: /Take/ }).click();
  await expect(obs.locator('[data-overlay-source="topic"]')).toContainText("Mic shootout");
  await expect(control.getByRole("button", { name: /Take/ })).toBeDisabled();

  // Shortcut 5 picks the message banner. Typing in the field never switches the source.
  await control.locator("body").press("5");
  const message = control.locator("[data-ov-message]");
  await expect(message).toHaveAttribute("maxlength", "120");
  await message.fill("Back in 5 minutes 4");
  await expect(control.getByRole("radio", { name: /Message banner/ })).toBeChecked();
  await control.getByRole("button", { name: "Save message" }).click();
  await expect(control.getByRole("button", { name: "Save message" })).toBeDisabled();
  await control.getByRole("button", { name: "Hype" }).click();
  await expect(control.getByRole("button", { name: "Hype" })).toHaveAttribute("aria-pressed", "true");
  await expect(control.getByRole("button", { name: /Take/ })).toBeEnabled();
  await control.locator("body").press("t");
  await expect(obs.locator('[data-overlay-source="message"]')).toContainText("Back in 5 minutes 4");
  await expect(obs.locator(".ov-message.style-hype")).toBeVisible();

  await control.getByRole("button", { name: "Top bar" }).click();
  await expect(obs.locator(".ov-stage.pos-top")).toBeVisible();
  // The box follows the saved state, so it changes once the server answers.
  await control.getByRole("checkbox", { name: "Instant switch (skip preview)" }).click();
  await expect(control.getByRole("checkbox", { name: "Instant switch (skip preview)" })).toBeChecked();
  await expect(control.locator('[data-ov-monitor="prev"]')).toHaveCount(0);
  await control.locator("body").press("8");
  await expect(obs.locator('[data-overlay-type="hidden"]')).toBeEmpty();
  if (shots) await obs.screenshot({ path: `${shots}/overlay-hidden.png` });

  // Back to Auto so the page ends as it started: the newest open poll.
  await control.locator("body").press("1");
  await expect(obs.locator('[data-overlay-type="auto"]')).toBeVisible();
  await control.getByRole("checkbox", { name: "Instant switch (skip preview)" }).click();
  await expect(control.getByRole("checkbox", { name: "Instant switch (skip preview)" })).not.toBeChecked();
  await Promise.all([owner.close(), obs.close()]);
});

/** Opens `count` live sockets from `page` at once: "open" for each that gets a snapshot, "refused" for each closed. */
async function liveSockets(page: Page, count: number, key: string | null = null): Promise<string[]> {
  return page.evaluate(
    ({ count, key }) =>
      Promise.all(
        Array.from(
          { length: count },
          () =>
            new Promise<string>((resolve) => {
              const url = new URL("/api/live/feature_host", globalThis.location.origin.replace(/^http/, "ws"));
              if (key) url.searchParams.set("key", key);
              const socket = new WebSocket(url);
              socket.onmessage = () => resolve("open");
              socket.onclose = () => resolve("refused");
            }),
        ),
      ),
    { count, key },
  );
}

test("the owner copies the private overlay link, and a new link revokes the old one", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 93));
  await owner.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const control = await owner.newPage();
  await control.goto("/overlay-control");
  await control.getByText("Setup", { exact: true }).click();
  await control.getByRole("button", { name: "Create overlay link" }).click();
  const field = control.locator("[data-ov-url]");
  await expect(field).toHaveValue(/^http:\/\/localhost:5173\/@feature_host\/overlay\?key=[\w-]{43}$/);
  await control.getByRole("button", { name: "Copy overlay URL" }).click();
  const oldUrl: string = await control.evaluate(() => navigator.clipboard.readText());
  expect(oldUrl).toBe(await field.inputValue());
  const oldKey: string = new URL(oldUrl).searchParams.get("key") ?? "";

  // OBS is not signed in, and its network already holds the ten signed-out sockets one client may open.
  const obs = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("overlay-control", 94) },
  });
  const crowd = await obs.newPage();
  await crowd.goto("/privacy");
  expect(await liveSockets(crowd, 10)).toEqual(Array.from({ length: 10 }, () => "open"));
  expect(await liveSockets(crowd, 1)).toEqual(["refused"]);
  const source = await obs.newPage();
  await source.goto(oldUrl);
  await expect(source.locator("[data-overlay-type]")).toBeVisible();
  await expect(source.locator(".overlay-connection")).toHaveCount(0);

  await control.getByRole("button", { name: "Regenerate link" }).click();
  const confirm = control.getByRole("dialog", { name: "Regenerate the overlay link?" });
  await expect(confirm).toContainText("OBS");
  await confirm.getByRole("button", { name: "Regenerate link" }).click();
  await expect(field).not.toHaveValue(oldUrl);
  const newKey: string = new URL(await field.inputValue()).searchParams.get("key") ?? "";
  // The old link now counts as one more signed-out socket, so this full network turns it away.
  await expect(source.locator(".overlay-connection")).toContainText("Reconnecting");
  expect(await liveSockets(crowd, 1, oldKey)).toEqual(["refused"]);
  expect(await liveSockets(crowd, 1, newKey)).toEqual(["open"]);
  await Promise.all([owner.close(), obs.close()]);
});

test("overlay control is for the page owner only", async ({ browser, page }) => {
  await page.goto("/overlay-control");
  await expect(page).toHaveURL(/\/streamers$/);
  const viewer = await signedIn(browser, "viewer", clientIp("overlay-control", 91));
  const viewerPage = await viewer.newPage();
  expect((await viewerPage.goto("/overlay-control"))?.status()).toBe(404);
  expect((await viewer.request.post("/api/overlay", { data: { action: "take" } })).status()).toBe(404);
  const long = "x".repeat(121);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 92));
  const tooLong = await owner.request.post("/api/overlay", { data: { action: "message", text: long, style: "info" } });
  expect(tooLong.status()).toBe(400);
  await Promise.all([viewer.close(), owner.close()]);
});

test("a monitor shows its stage only once it is scaled to the frame", async ({ browser }) => {
  const phone = { viewport: { width: 390, height: 844 } };
  // Without script the stage is never scaled, as before hydration. At its default size it would spill out.
  const still = await fixtureSignedIn(browser, "featureowner", 92, { ...phone, javaScriptEnabled: false });
  const before = await still.newPage();
  await before.goto("/overlay-control");
  await expect(before.locator('[data-ov-monitor="air"] .ov-scaler')).toBeHidden();
  await still.close();
  const owner = await fixtureSignedIn(browser, "featureowner", 92, phone);
  const page = await owner.newPage();
  await page.goto("/overlay-control");
  await expect(page.locator('[data-ov-monitor="air"] .ov-scaler')).toBeVisible();
  await owner.close();
});

test("the control page moves Up next on when the stream it shows starts", async ({ browser }) => {
  const page = "(SELECT id FROM streamers WHERE handle='feature_host')";
  const topic = "(SELECT id FROM entries WHERE title='Mic shootout' AND kind='topic')";
  const preview = (source: string): string => `UPDATE overlay_state SET preview=${source} WHERE streamer_id=${page};`;
  // A stream that starts in 20 seconds, ahead of the seeded Mic shootout.
  const id = randomUUID();
  const now = Date.now();
  await runSql("upnext-soon", [
    preview(`'{"type":"next","ref":null}'`),
    `INSERT INTO stream_events(id,streamer_id,series_id,title,notes,starts_at,duration_min,platform,url,status,repeat_days,repeat_until,tz,created_at,updated_at) VALUES ('${id}',${page},NULL,'Soon stream','',${now + 20_000},30,'twitch','https://twitch.tv/feature_host','scheduled',0,NULL,'UTC',${now},${now});`,
  ]);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 94));
  try {
    const control = await owner.newPage();
    await control.goto("/overlay-control");
    const monitor = control.locator('[data-ov-monitor="prev"] [data-overlay-source="next"]');
    await expect(monitor).toContainText("Soon stream");
    // Once it starts, the loader names the stream after it, as the OBS page does.
    await expect(monitor).toContainText("Mic shootout", { timeout: 40_000 });
  } finally {
    await runSql("upnext-soon", [
      `DELETE FROM stream_events WHERE id='${id}';`,
      preview(`json_object('type','topic','ref',${topic})`),
    ]);
    await owner.close();
  }
});
