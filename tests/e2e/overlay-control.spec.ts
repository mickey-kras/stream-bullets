import { newPage, close } from "./coverage";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "./coverage";
import { runSql, signedIn as fixtureSignedIn } from "./fixtures";
import { origin, shots, signedIn } from "./live-helpers";
import { clientAddress, clientIp } from "./client-ips";

test.beforeEach(async () => {
  // Reset display state before each test and retry.
  await runSql("overlay-control-reset", [
    `UPDATE overlay_state SET air='{"type":"auto","ref":null}', preview=json_object('type','topic','ref',(SELECT id FROM entries WHERE title='Mic shootout' AND kind='topic')), instant=0, position='lower', size='m', show_results=1, message='', message_style='info', revision=revision+1 WHERE streamer_id=(SELECT id FROM streamers WHERE handle='feature_host');`,
  ]);
});

test("the owner previews, takes and switches what the one OBS URL shows", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 90));
  const control = await newPage(owner);
  await control.setViewportSize({ width: 1440, height: 1000 });
  const obs = await newPage(browser, { viewport: { width: 1920, height: 1080 } });
  await obs.goto("/@feature_host/overlay");
  await expect(obs.locator("[data-overlay-mash]")).toBeVisible();

  await control.goto("/overlay-control");
  await expect(control.getByRole("heading", { level: 1, name: "Overlay control" })).toBeVisible();
  await expect(control.locator('[data-ov-monitor="prev"] [data-overlay-source="topic"]')).toContainText("Mic shootout");
  if (shots) await control.screenshot({ path: `${shots}/overlay-control.png`, fullPage: true });

  await control.getByRole("button", { name: /Take/ }).click();
  await expect(obs.locator('[data-overlay-source="topic"]')).toContainText("Mic shootout");
  await expect(control.getByRole("button", { name: /Take/ })).toBeDisabled();

  // Shortcuts stay disabled until Take completes.
  await expect(control.getByRole("radio", { name: /Message banner/ })).toBeEnabled();
  // Shortcut 5 selects the banner; typing must not switch sources.
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
  await control.getByRole("checkbox", { name: "Instant switch (skip preview)" }).click();
  await expect(control.getByRole("checkbox", { name: "Instant switch (skip preview)" })).toBeChecked();
  await expect(control.locator('[data-ov-monitor="prev"]')).toHaveCount(0);
  await expect(control.getByRole("radio", { name: /^Hidden/ })).toBeEnabled();
  await control.locator("body").press("8");
  await expect(obs.locator('[data-overlay-type="hidden"]')).toBeEmpty();
  if (shots) await obs.screenshot({ path: `${shots}/overlay-hidden.png` });

  // OBS updates can precede save completion and shortcut reactivation.
  await expect(control.getByRole("radio", { name: /^Auto/ })).toBeEnabled();
  // Restore Auto to the newest open poll.
  await control.locator("body").press("1");
  await expect(obs.locator('[data-overlay-type="auto"]')).toBeVisible();
  await control.getByRole("checkbox", { name: "Instant switch (skip preview)" }).click();
  await expect(control.getByRole("checkbox", { name: "Instant switch (skip preview)" })).not.toBeChecked();
  await Promise.all([close(owner), close(obs)]);
});

// Open `count` sockets; classify each by snapshot receipt or refusal.
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
  const control = await newPage(owner);
  await control.goto("/overlay-control");
  await control.getByText("Setup", { exact: true }).click();
  await control.getByRole("button", { name: "Create overlay link" }).click();
  const field = control.locator("[data-ov-url]");
  await expect(field).toHaveValue(/^http:\/\/localhost:5173\/@feature_host\/overlay\?key=[\w-]{43}$/);
  await control.getByRole("button", { name: "Copy overlay URL" }).click();
  const oldUrl: string = await control.evaluate(() => navigator.clipboard.readText());
  expect(oldUrl).toBe(await field.inputValue());
  const oldKey: string = new URL(oldUrl).searchParams.get("key") ?? "";

  // OBS has no session; its network already holds ten guest sockets.
  const obs = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("overlay-control", 94) },
  });
  const crowd = await newPage(obs);
  await crowd.goto("/privacy");
  expect(await liveSockets(crowd, 10)).toEqual(Array.from({ length: 10 }, () => "open"));
  expect(await liveSockets(crowd, 1)).toEqual(["refused"]);
  const source = await newPage(obs);
  await source.goto(oldUrl);
  await expect(source.locator("[data-overlay-type]")).toBeVisible();
  await expect(source.locator(".overlay-connection")).toHaveCount(0);

  await control.getByRole("button", { name: "Regenerate link" }).click();
  const confirm = control.getByRole("dialog", { name: "Regenerate the overlay link?" });
  await expect(confirm).toContainText("OBS");
  await confirm.getByRole("button", { name: "Regenerate link" }).click();
  await expect(field).not.toHaveValue(oldUrl);
  const newKey: string = new URL(await field.inputValue()).searchParams.get("key") ?? "";
  // The revoked link becomes a guest; the full network must refuse it.
  await expect(source.locator(".overlay-connection")).toContainText("Reconnecting");
  expect(await liveSockets(crowd, 1, oldKey)).toEqual(["refused"]);
  expect(await liveSockets(crowd, 1, newKey)).toEqual(["open"]);
  await Promise.all([close(owner), close(obs)]);
});

test("overlay control is for the page owner only", async ({ browser, page }) => {
  await page.goto("/overlay-control");
  await expect(page).toHaveURL(/\/streamers$/);
  const viewer = await signedIn(browser, "viewer", clientIp("overlay-control", 91));
  const viewerPage = await newPage(viewer);
  expect((await viewerPage.goto("/overlay-control"))?.status()).toBe(404);
  expect((await viewer.request.post("/api/overlay", { data: { action: "take" } })).status()).toBe(404);
  const long = "x".repeat(121);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 92));
  const tooLong = await owner.request.post("/api/overlay", { data: { action: "message", text: long, style: "info" } });
  expect(tooLong.status()).toBe(400);
  await Promise.all([close(viewer), close(owner)]);
});

test("a monitor shows its stage only once it is scaled to the frame", async ({ browser }) => {
  const phone = { viewport: { width: 390, height: 844 } };
  // Without JavaScript, hide the unscaled stage to prevent overflow.
  const still = await fixtureSignedIn(browser, "featureowner", 92, { ...phone, javaScriptEnabled: false });
  const before = await newPage(still);
  await before.goto("/overlay-control");
  await expect(before.locator('[data-ov-monitor="air"] .ov-scaler')).toBeHidden();
  await close(still);
  const owner = await fixtureSignedIn(browser, "featureowner", 92, phone);
  const page = await newPage(owner);
  await page.goto("/overlay-control");
  await expect(page.locator('[data-ov-monitor="air"] .ov-scaler')).toBeVisible();
  await close(owner);
});

test("the control page moves Up next on when the stream it shows starts", async ({ browser }) => {
  const page = "(SELECT id FROM streamers WHERE handle='feature_host')";
  const topic = "(SELECT id FROM entries WHERE title='Mic shootout' AND kind='topic')";
  const preview = (source: string): string => `UPDATE overlay_state SET preview=${source} WHERE streamer_id=${page};`;
  // Start a stream in 20 s, before the seeded Mic shootout.
  const id = randomUUID();
  const now = Date.now();
  await runSql("upnext-soon", [
    preview(`'{"type":"next","ref":null}'`),
    `INSERT INTO stream_events(id,streamer_id,series_id,title,notes,starts_at,duration_min,platform,url,status,repeat_days,repeat_until,tz,created_at,updated_at) VALUES ('${id}',${page},NULL,'Soon stream','',${now + 20_000},30,'twitch','https://twitch.tv/feature_host','scheduled',0,NULL,'UTC',${now},${now});`,
  ]);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 94));
  try {
    const control = await newPage(owner);
    await control.goto("/overlay-control");
    const monitor = control.locator('[data-ov-monitor="prev"] [data-overlay-source="next"]');
    await expect(monitor).toContainText("Soon stream");
    // After start, load the next stream as OBS does.
    await expect(monitor).toContainText("Mic shootout", { timeout: 40_000 });
  } finally {
    await runSql("upnext-soon", [
      `DELETE FROM stream_events WHERE id='${id}';`,
      preview(`json_object('type','topic','ref',${topic})`),
    ]);
    await close(owner);
  }
});

test("the owner sees each channel's connection health and the result of a connection attempt", async ({ browser }) => {
  const page = "(SELECT id FROM streamers WHERE handle='feature_host')";
  const youtubeId = randomUUID();
  const kickId = randomUUID();
  const now = Date.now();
  const row = (id: string, platform: string, external: string, name: string, status: string, code: string): string =>
    `INSERT INTO channel_connections(id,streamer_id,platform,external_id,display_name,scopes,status,status_code,created_at,updated_at,last_event_at) VALUES ('${id}',${page},'${platform}','${external}','${name}','','${status}','${code}',${now},${now},${now});`;
  await runSql("channels-seed", [
    row(youtubeId, "youtube", "UCe2e", "Feature Tube", "error", "quota_exhausted"),
    row(kickId, "kick", "4242", "Feature Kick", "needs_reauth", "authorization_revoked"),
    // Disconnect needs a sign-in from the last 10 minutes; a long browser run outlasts the seeded session time.
    `UPDATE session SET created_at=${now} WHERE user_id=(SELECT id FROM user WHERE name='featureowner');`,
    // The overlay link test uses the same account's content quota; start this test with a clear one.
    `DELETE FROM app_rate_limits WHERE key='content:'||(SELECT id FROM user WHERE name='featureowner');`,
  ]);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 93));
  try {
    const control = await newPage(owner);
    await control.goto("/overlay-control?channel=kick&result=channel_taken");
    const section = control.getByRole("region", { name: "Channels" });
    const banner = section.locator(".ch-result");
    // The result is read once: the banner is a status region with focus, and no toast repeats it.
    await expect(banner).toHaveText("This Kick channel is already connected to another StreamBullets page.");
    // An <output> element: a status region by its own role.
    await expect(section.getByRole("status").and(banner)).toBeVisible();
    await expect(banner).toBeFocused();
    await expect(control.locator(".toast").filter({ hasText: "already connected" })).toHaveCount(0);
    // It leaves the address, so a reload does not show it again.
    await expect(control).toHaveURL(/\/overlay-control$/);
    const youtube = section.locator('[data-channel="youtube"]');
    // YouTube is not set up here, so its notes about the YouTube limits stay hidden.
    await expect(youtube).not.toContainText("Chat starts when an overlay");
    await expect(youtube).toContainText("Connected as Feature Tube");
    // YouTube is not set up on this test server, so its card gives no reconnect advice.
    await expect(youtube.getByRole("alert")).toHaveCount(0);
    await expect(youtube).toContainText("Last activity:");
    await expect(section.getByText("This platform is not set up on this site yet.")).toHaveCount(2);
    // Kick is set up: its card shows what happened and how to fix it.
    const kick = section.locator('[data-channel="kick"]');
    await expect(kick.getByRole("alert")).toHaveText("Access ended. Reconnect to keep receiving chat.");
    await expect(kick.getByRole("button", { name: "Reconnect Kick", exact: true })).toBeVisible();
    // Disconnect: after the confirmation, focus lands on the platform's Connect button.
    await kick.getByRole("button", { name: "Disconnect Kick", exact: true }).click();
    const dialog = control.getByRole("dialog", { name: "Disconnect Kick?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Disconnect Kick", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(kick.getByRole("button", { name: "Connect Kick", exact: true })).toBeFocused();
    await expect(kick).toContainText("Not connected");
    // Kick could not confirm the revoke (the stored tokens were seeded without any), so the advice stays.
    await expect(kick).toContainText("Remove StreamBullets in your Kick settings.");
    // A platform the site does not offer has no Connect button: focus goes to the section heading.
    await youtube.getByRole("button", { name: "Disconnect YouTube", exact: true }).click();
    const youtubeDialog = control.getByRole("dialog", { name: "Disconnect YouTube?" });
    await youtubeDialog.getByRole("button", { name: "Disconnect YouTube", exact: true }).click();
    await expect(youtube).toContainText("Not connected");
    await expect(control.locator("#channels-title")).toBeFocused();
  } finally {
    await runSql("channels-seed", [`DELETE FROM channel_connections WHERE id IN ('${youtubeId}','${kickId}');`]);
    await close(owner);
  }
});
