import type { Request, Route } from "@playwright/test";
import { newPage, close } from "./coverage";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "./coverage";
import { runSql, signedIn as fixtureSignedIn } from "./fixtures";
import {
  CHAT_CELL,
  POLL_CELL,
  chip,
  defaultLayers,
  layersSql,
  noKeysSql,
  placeLayer,
  saved,
  settings,
} from "./grid-helpers";
import { origin, shots, signedIn } from "./live-helpers";
import { clientAddress, clientIp } from "./client-ips";

const FEATURE_HOST = "(SELECT id FROM streamers WHERE handle='feature_host')";

test.beforeEach(async () => {
  // Reset the overlay before each test and retry: the poll layer shows the latest active poll, and nothing else.
  await runSql("overlay-control-reset", [
    layersSql({ cells: { horizontal: { poll: POLL_CELL } } }),
    `UPDATE overlay_state SET show_results=1, message='', message_style='info' WHERE streamer_id=${FEATURE_HOST};`,
  ]);
});

test.afterAll(async () => {
  await runSql("overlay-control-cleanup", [defaultLayers]);
});

test("the owner builds the overlay from layers and the one OBS URL follows at once", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 90));
  const control = await newPage(owner);
  await control.setViewportSize({ width: 1440, height: 1000 });
  const obs = await newPage(browser, { viewport: { width: 1920, height: 1080 } });
  await obs.goto("/@feature_host/overlay");
  // The poll layer shows the latest active poll: the seeded battle.
  await expect(obs.locator('.ov-layer[data-layer="poll"] [data-overlay-mash]')).toBeVisible();

  await control.goto("/tools?view=overlay");
  await expect(control.getByRole("heading", { level: 1, name: "Streamer tools" })).toBeVisible();
  const editor = control.locator("[data-composition-editor]");
  await expect(editor.locator('.ov-layer[data-layer="poll"] [data-overlay-mash]')).toBeVisible();
  await expect(editor.locator("[data-comp-live-note]")).toHaveText("Changes go live right away");
  // The controls from before the studio are gone: no monitors, no Take and no shortcuts.
  await expect(control.locator("[data-ov-monitor]")).toHaveCount(0);
  await expect(control.getByRole("button", { name: /Take/ })).toHaveCount(0);
  await expect(control.locator("kbd")).toHaveCount(0);
  if (shots) await control.screenshot({ path: `${shots}/tools.png`, fullPage: true });

  // A topic layer comes on the grid with the newest topic, and OBS shows it at once.
  await placeLayer(control, editor, "topic");
  await expect(settings(editor)).toHaveAttribute("data-comp-props", "topic");
  await expect(obs.locator('.ov-layer[data-layer="topic"] [data-overlay-source="topic"]')).toContainText(
    "Mic shootout",
  );
  await expect(obs.locator('.ov-layer[data-layer="poll"]')).toBeVisible();

  // The message banner: the text saves with its button, the style at once. A digit in the field is only text.
  await placeLayer(control, editor, "message");
  const message = control.locator("[data-ov-message]");
  await expect(message).toHaveAttribute("maxlength", "120");
  await expect(obs.locator('[data-overlay-source="message"]')).toContainText("Your message");
  await message.fill("Back in 5 minutes 4");
  await control.getByRole("button", { name: "Save message" }).click();
  await expect(control.getByRole("button", { name: "Save message" })).toBeDisabled();
  await expect(obs.locator('[data-overlay-source="message"]')).toContainText("Back in 5 minutes 4");
  await control.getByRole("button", { name: "Hype" }).click();
  await expect(control.getByRole("button", { name: "Hype" })).toHaveAttribute("aria-pressed", "true");
  await expect(obs.locator(".ov-message.style-hype")).toBeVisible();
  // The old shortcuts do nothing: 8 was Hidden and T was Take.
  await control.locator("body").press("8");
  await control.locator("body").press("t");
  await expect(obs.locator('[data-overlay-source="message"]')).toBeVisible();

  // "Show on stream" hides the layer on OBS and keeps it on the grid. The message is then private again.
  const show = settings(editor).getByRole("checkbox", { name: "Show on stream" });
  let done = saved(control);
  await show.uncheck();
  await done;
  await expect(obs.locator('.ov-layer[data-layer="message"]')).toHaveCount(0);
  await expect(editor.locator('[data-grid-box="message"]')).toHaveAttribute("data-off", "true");
  await expect(chip(editor, "message")).toHaveAttribute("data-placed", "true");
  const live = (await (await obs.request.get("/api/live/feature_host")).json()) as { overlay?: { message?: string } };
  expect(live.overlay?.message ?? "").toBe("");
  done = saved(control);
  await show.check();
  await done;
  await expect(obs.locator('[data-overlay-source="message"]')).toContainText("Back in 5 minutes 4");

  // "Remove from grid" takes the layer off OBS. The focus goes to its chip, which offers the layer again.
  done = saved(control);
  await settings(editor).getByRole("button", { name: "Remove from grid" }).click();
  await done;
  await expect(obs.locator('.ov-layer[data-layer="message"]')).toHaveCount(0);
  await expect(chip(editor, "message")).toBeFocused();
  await expect(chip(editor, "message")).not.toHaveAttribute("data-placed");
  await expect(settings(editor)).toContainText("No layer selected");
  if (shots) await obs.screenshot({ path: `${shots}/overlay-layers.png` });
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
  await control.goto("/tools?view=overlay");
  // Step 2 shows the link controls without a click.
  await expect(control.getByRole("region", { name: "2 Add to OBS" })).toBeVisible();
  // Each output has its own link. This is the link of the horizontal output.
  const link = control.getByRole("region", { name: "Horizontal output" });
  await link.getByRole("button", { name: "Create overlay link" }).click();
  const field = link.locator("[data-ov-url]");
  await expect(field).toHaveValue(/^http:\/\/localhost:5173\/@feature_host\/overlay\?key=[\w-]{43}$/);
  await link.getByRole("button", { name: "Copy overlay URL: Horizontal output" }).click();
  const oldUrl: string = await control.evaluate(() => navigator.clipboard.readText());
  expect(oldUrl).toBe(await field.inputValue());
  const oldKey: string = new URL(oldUrl).searchParams.get("key") ?? "";
  // After a reload the link is hidden, and the owner can see the same link again.
  await control.reload();
  await expect(field).toHaveCount(0);
  await link.getByRole("button", { name: "Show link", exact: true }).click();
  await expect(field).toHaveValue(oldUrl);
  await expect(link.getByRole("button", { name: "Show link", exact: true })).toHaveCount(0);

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
  // The control page shows the OBS source that came in with the key.
  const sources = link.locator("[data-ov-sources]");
  await expect(sources).toHaveText("OBS is connected: 1 source.");

  await link.getByRole("button", { name: "Regenerate link" }).click();
  const confirm = control.getByRole("dialog", { name: "Regenerate the overlay link?" });
  await expect(confirm).toContainText("OBS");
  await expect(confirm).toContainText("The link of the other output keeps working.");
  await confirm.getByRole("button", { name: "Regenerate link" }).click();
  await expect(field).not.toHaveValue(oldUrl);
  const newKey: string = new URL(await field.inputValue()).searchParams.get("key") ?? "";
  // The revoked link becomes a guest; the full network must refuse it.
  await expect(source.locator(".overlay-connection")).toContainText("Reconnecting");
  await expect(sources).toContainText("OBS is not connected. Last seen");
  expect(await liveSockets(crowd, 1, oldKey)).toEqual(["refused"]);
  expect(await liveSockets(crowd, 1, newKey)).toEqual(["open"]);
  await Promise.all([close(owner), close(obs)]);
  await runSql("overlay-control-link-restore", [noKeysSql]);
});

test("each output has its own link: both are on stream, and a new link for one leaves the other connected", async ({
  browser,
}) => {
  // The poll is on the grid of the two outputs, at different cells. The editor shows the horizontal output.
  const tall = { c: 2, r: 2, w: 14, h: 8 };
  await runSql("overlay-control-outputs", [
    noKeysSql,
    layersSql({ cells: { horizontal: { poll: POLL_CELL }, vertical: { poll: tall } } }),
  ]);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 97));
  const control = await newPage(owner);
  await control.goto("/tools?view=overlay");
  const wide = control.getByRole("region", { name: "Horizontal output" });
  const high = control.getByRole("region", { name: "Vertical output" });
  await expect(wide.locator("[data-ov-sources]")).toHaveCount(0);
  await wide.getByRole("button", { name: "Create overlay link" }).click();
  await expect(wide.locator("[data-ov-url]")).toHaveValue(/\?key=[\w-]{43}$/);
  const wideUrl: string = await wide.locator("[data-ov-url]").inputValue();
  await high.getByRole("button", { name: "Create overlay link" }).click();
  await expect(high.locator("[data-ov-url]")).toHaveValue(/\?key=[\w-]{43}$/);
  const highUrl: string = await high.locator("[data-ov-url]").inputValue();
  expect(highUrl).not.toBe(wideUrl);
  // The new vertical link did not change the horizontal link.
  await expect(wide.locator("[data-ov-url]")).toHaveValue(wideUrl);
  // No source uses a link yet. The room can hold the time of a source of an earlier spec.
  await expect(wide.locator("[data-ov-sources]")).toHaveAttribute("data-ov-sources", "0");
  await expect(high.locator("[data-ov-sources]")).toHaveAttribute("data-ov-sources", "0");

  // Two OBS sources at the same time: each link shows the layout of its output, at half size.
  const obs = await browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("overlay-control", 98) },
  });
  const wideSource = await newPage(obs);
  await wideSource.setViewportSize({ width: 960, height: 540 });
  await wideSource.goto(wideUrl);
  const highSource = await newPage(obs);
  await highSource.setViewportSize({ width: 540, height: 960 });
  await highSource.goto(highUrl);
  const pollBox = async (page: Page): Promise<{ x: number; y: number; width: number; height: number }> => {
    const layer = page.locator('.ov-layer[data-layer="poll"]');
    await expect(layer).toBeVisible();
    const box = await layer.boundingBox();
    if (!box) throw new Error("The poll layer has no box.");
    return box;
  };
  const near = (actual: number, expected: number): void => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);
  const wideBox = await pollBox(wideSource);
  near(wideBox.x, (POLL_CELL.c * 60) / 2);
  near(wideBox.width, (POLL_CELL.w * 60) / 2);
  const highBox = await pollBox(highSource);
  near(highBox.x, (tall.c * 60) / 2);
  near(highBox.y, (tall.r * 60) / 2);
  near(highBox.width, (tall.w * 60) / 2);
  near(highBox.height, (tall.h * 60) / 2);
  await expect(wide.locator("[data-ov-sources]")).toHaveText("OBS is connected: 1 source.");
  await expect(high.locator("[data-ov-sources]")).toHaveText("OBS is connected: 1 source.");

  // The switch of the editor selects the output to edit. OBS does not change.
  const editor = control.locator("[data-composition-editor]");
  const save = saved(control);
  await editor.getByRole("button", { name: "Vertical 18 × 32" }).click();
  await save;
  await expect(editor.getByRole("region", { name: "Composition preview" })).toHaveAttribute(
    "data-orientation",
    "vertical",
  );
  near((await pollBox(wideSource)).width, (POLL_CELL.w * 60) / 2);
  near((await pollBox(highSource)).width, (tall.w * 60) / 2);

  // A new vertical link stops the old vertical link only.
  await high.getByRole("button", { name: "Regenerate link" }).click();
  await control
    .getByRole("dialog", { name: "Regenerate the overlay link?" })
    .getByRole("button", { name: "Regenerate link" })
    .click();
  await expect(high.locator("[data-ov-url]")).not.toHaveValue(highUrl);
  await expect(highSource.locator(".overlay-connection")).toContainText("Reconnecting");
  await expect(high.locator("[data-ov-sources]")).toContainText("OBS is not connected. Last seen");
  await expect(wide.locator("[data-ov-sources]")).toHaveText("OBS is connected: 1 source.");
  await expect(wideSource.locator(".overlay-connection")).toHaveCount(0);
  await Promise.all([close(owner), close(obs)]);
  await runSql("overlay-control-outputs-restore", [noKeysSql, defaultLayers]);
});

test("the Twitch switch of one output saves that output only, in a section that is closed at first", async ({
  browser,
}) => {
  await runSql("overlay-control-twitch", [layersSql({})]);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 97));
  const control = await newPage(owner);
  await control.goto("/tools?view=overlay");
  const section = control.locator("[data-ov-twitch]");
  const wide = section.getByRole("checkbox", { name: "Show Twitch chat only on the horizontal output" });
  const high = section.getByRole("checkbox", { name: "Show Twitch chat only on the vertical output" });
  // The section is closed: a streamer on one platform does not need it.
  await expect(section).not.toHaveAttribute("open");
  await expect(high).toBeHidden();
  await section.getByText("Streaming to Twitch and other platforms at once?").click();
  await expect(section).toContainText("The Twitch rules for simulcasts do not allow chat from other platforms");
  await expect(wide).not.toBeChecked();
  await expect(high).not.toBeChecked();
  const bodies: unknown[] = [];
  control.on("request", (request: Request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/overlay")
      bodies.push(request.postDataJSON());
  });
  // The switch shows the saved state: it changes when the save returns.
  let save = saved(control);
  await high.click();
  await save;
  await expect(high).toBeChecked();
  await expect(wide).not.toBeChecked();
  expect(bodies).toEqual([{ action: "layers", twitchOnly: { vertical: true } }]);
  // The state holds after a load, and the other output did not change.
  await control.reload();
  await control.locator("[data-ov-twitch]").getByText("Streaming to Twitch and other platforms at once?").click();
  await expect(high).toBeChecked();
  await expect(wide).not.toBeChecked();
  save = saved(control);
  await high.click();
  await save;
  await expect(high).not.toBeChecked();
  await close(owner);
  await runSql("overlay-control-twitch-restore", [defaultLayers]);
});

test("the guide for a first use of OBS is closed at first and shows its steps when the owner opens it", async ({
  browser,
}) => {
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 97));
  const control = await newPage(owner);
  await control.goto("/tools?view=overlay");
  const guide = control.locator("[data-ov-guide]");
  const steps = guide.getByRole("listitem");
  await expect(guide).not.toHaveAttribute("open");
  await expect(steps.first()).toBeHidden();
  await guide.getByText("First time in OBS? Set it up step by step").click();
  await expect(steps).toHaveCount(14);
  await expect(guide.locator('[data-ov-guide-group="overlay"]')).toContainText("Add the overlay");
  await expect(guide.locator('[data-ov-guide-group="overlay"]').getByRole("listitem").nth(2)).toHaveText(
    "Paste the link into URL. Set Width to 1920 and Height to 1080. Select OK.",
  );
  await expect(guide.locator('[data-ov-guide-group="vertical"]').getByRole("listitem")).toHaveCount(4);
  await expect(guide.locator('[data-ov-guide-group="platforms"]').getByRole("listitem")).toHaveCount(4);
  // The guide fits a phone: no step is wider than the screen.
  await control.setViewportSize({ width: 390, height: 844 });
  const overflow: number = await control.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // The keyboard closes and opens it: the summary is a control.
  await guide.locator("summary").focus();
  await control.keyboard.press("Enter");
  await expect(guide).not.toHaveAttribute("open");
  await close(owner);
});

test("an OBS source with a refused key stops its chat feed retries", async ({ browser }) => {
  await runSql("overlay-control-refused-key", [
    layersSql({ chat: { enabled: true }, cells: { horizontal: { chat: CHAT_CELL } } }),
  ]);
  const obs = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("overlay-control", 91) },
  });
  const source = await newPage(obs);
  const tries: string[] = [];
  source.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/api/activity/")) tries.push(socket.url());
  });
  await source.goto(`/@feature_host/overlay?key=${"A".repeat(43)}`);
  await expect(source.locator("main")).toHaveAttribute("data-feed-status", "refused");
  // The first wait before a retry is 1 second at most: no second socket opens.
  await source.waitForTimeout(2500);
  expect(tries).toHaveLength(1);
  await close(obs);
});

test("overlay control is for the page owner only", async ({ browser, page }) => {
  await page.goto("/tools?view=overlay");
  await expect(page).toHaveURL(/\/streamers$/);
  const viewer = await signedIn(browser, "viewer", clientIp("overlay-control", 91));
  const viewerPage = await newPage(viewer);
  expect((await viewerPage.goto("/tools?view=overlay"))?.status()).toBe(404);
  const hide = { action: "showResults", on: false };
  expect((await viewer.request.post("/api/overlay", { data: hide })).status()).toBe(404);
  const long = "x".repeat(121);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 92));
  const tooLong = await owner.request.post("/api/overlay", { data: { action: "message", text: long, style: "info" } });
  expect(tooLong.status()).toBe(400);
  // The actions from before the overlay studio are gone.
  for (const action of [{ action: "take" }, { action: "preview", source: { type: "hidden", ref: null } }])
    expect((await owner.request.post("/api/overlay", { data: action })).status()).toBe(400);
  expect((await owner.request.post("/api/overlay", { data: { action: "layout", position: "top" } })).status()).toBe(
    400,
  );
  await Promise.all([close(viewer), close(owner)]);
});

test("the pickers of a layer change what it shows, hide poll results and recover from a failed save", async ({
  browser,
}) => {
  const topicId: string = randomUUID();
  const pollId: string = randomUUID();
  const now: number = Date.now();
  await runSql("overlay-picker-seed", [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed) VALUES ('${topicId}',${FEATURE_HOST},(SELECT id FROM user WHERE name='featureowner'),'topic','Overlay picker topic','Preview only','Tech & setups','[]',${now},0);`,
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed) VALUES ('${pollId}',${FEATURE_HOST},(SELECT id FROM user WHERE name='featureowner'),'choice','Overlay picker poll','','','["Tea","Coffee"]',${now},0);`,
    `DELETE FROM app_rate_limits WHERE key='content:'||(SELECT id FROM user WHERE name='featureowner');`,
    // A smaller poll cell leaves room for the other layers of this test.
    layersSql({ cells: { horizontal: { poll: { c: 16, r: 0, w: 16, h: 10 } } } }),
  ]);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 90));
  // This case owns 203.0.113.140 so asset requests do not share another case's quota.
  await owner.setExtraHTTPHeaders({ "CF-Connecting-IP": "203.0.113.140", Origin: origin });
  try {
    const control = await newPage(owner);
    await control.setViewportSize({ width: 1440, height: 1000 });
    await control.goto("/tools?view=overlay");
    const editor = control.locator("[data-composition-editor]");
    const preview = editor.getByRole("region", { name: "Composition preview" });
    const panel = settings(editor);

    // The poll layer: the latest active poll by default, then a poll of the page.
    await chip(editor, "poll").click();
    await expect(panel).toHaveAttribute("data-comp-props", "poll");
    const pollPicker = panel.getByRole("combobox", { name: "Poll", exact: true });
    await expect(pollPicker).toHaveText("Latest active poll");
    await expect(preview.getByRole("heading", { name: "Overlay picker poll" })).toBeVisible();
    await pollPicker.click();
    await expect(control.getByRole("option", { name: "Latest active poll", exact: true })).toBeVisible();
    let done = saved(control);
    await control.getByRole("option", { name: "Mash Battle: Which boss first?", exact: true }).click();
    await done;
    await expect(pollPicker).toHaveText("Mash Battle: Which boss first?");
    await expect(preview.locator('.ov-layer[data-layer="poll"] [data-overlay-mash]')).toBeVisible();
    await pollPicker.click();
    done = saved(control);
    await control.getByRole("option", { name: "Overlay picker poll", exact: true }).click();
    await done;
    await expect(preview.getByRole("heading", { name: "Overlay picker poll" })).toBeVisible();
    const results = panel.getByRole("checkbox", { name: "Show results", exact: true });
    await results.click();
    await expect(results).not.toBeChecked();
    await expect(preview).toContainText("Results hidden");

    // The topic layer takes the newest topic when it comes on the grid. The picker changes it.
    await placeLayer(control, editor, "topic");
    const topicPicker = panel.getByRole("combobox", { name: "Topic", exact: true });
    await expect(topicPicker).toHaveText("Overlay picker topic");
    await topicPicker.click();
    done = saved(control);
    await control.getByRole("option", { name: "Mic shootout", exact: true }).click();
    await done;
    await expect(preview.locator('[data-overlay-source="topic"]')).toContainText("Mic shootout");
    await expect(preview).toContainText("Overlay picker poll");

    // The card layer shows the first card until the owner picks one.
    await placeLayer(control, editor, "card");
    const cardPicker = panel.getByRole("combobox", { name: "Community card", exact: true });
    await expect(preview.locator('[data-overlay-source="card"]')).toBeVisible();
    await cardPicker.click();
    done = saved(control);
    await control.getByRole("option", { name: "Join the Discord", exact: true }).click();
    await done;
    await expect(cardPicker).toHaveText("Join the Discord");
    await expect(preview).toContainText("discord.gg/feature_host");

    // A failed save of the results switch shows the reason and keeps the saved value.
    await chip(editor, "poll").click();
    await control.route("**/api/overlay", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({ status: 503, json: { error: "The request failed. Please try again." } });
    });
    await results.click();
    await expect(control.locator(".sb-toast")).toHaveText("The request failed. Please try again.");
    await expect(results).toBeEnabled();
    await expect(results).not.toBeChecked();
    // A failed save of a layer setting shows under the settings, and the setting goes back. A click, not `uncheck`:
    // the setting can go back before `uncheck` reads it, and `uncheck` then reports that the click changed nothing.
    await panel.getByRole("checkbox", { name: "Show on stream" }).click();
    await expect(editor.locator("[data-comp-error]")).toContainText("Layout not saved");
    await expect(panel.getByRole("checkbox", { name: "Show on stream" })).toBeChecked();
    await control.unroute("**/api/overlay");
    await results.click();
    await expect(results).toBeChecked();
    await expect(preview).not.toContainText("Results hidden");

    await placeLayer(control, editor, "support");
    await expect(preview.locator('[data-overlay-source="support"]')).toContainText("ko-fi.com/feature_host");
    // Up next and the support banner have no picker.
    await expect(panel).toHaveAttribute("data-comp-props", "support");
    await expect(panel.getByRole("combobox")).toHaveCount(0);
  } finally {
    await close(owner);
    await runSql("overlay-picker-cleanup", [`DELETE FROM entries WHERE id IN ('${topicId}','${pollId}');`]);
  }
});

test("Streamer tools has the Overlay section with two numbered steps and the Channels section with its cards in view", async ({
  browser,
}) => {
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 91));
  const connectionId: string = randomUUID();
  const now: number = Date.now();
  try {
    const control = await newPage(owner);
    await control.goto("/tools?view=overlay");
    // The page has one title and the links to its sections. The address names the Overlay section.
    await expect(control.getByRole("heading", { level: 1 })).toHaveAccessibleName("Streamer tools");
    const sections = control.getByRole("navigation", { name: "Streamer tools sections" });
    await expect(sections.getByRole("link")).toHaveText(["Live", "Overlay", "Channels"]);
    await expect(sections.getByRole("link", { name: "Overlay" })).toHaveAttribute("aria-current", "page");
    await expect(sections.getByRole("link", { name: "Channels" })).not.toHaveAttribute("aria-current", "page");
    // The steps of the section come in order, each a region named by its numbered level 2 heading.
    const steps = (): Promise<(string | null)[]> =>
      control.locator("[data-step]").evaluateAll((items) => items.map((item) => item.getAttribute("data-step")));
    await expect(control.locator("[data-step]")).toHaveCount(2);
    expect(await steps()).toEqual(["build", "obs"]);
    await expect(control.getByRole("heading", { level: 2 })).toHaveText(["1 Build your overlay", "2 Add to OBS"]);
    // Step 1 is the studio: the toolbar, the layers, the grid and the settings of a layer. Step 2 has the link.
    const build = control.getByRole("region", { name: "1 Build your overlay" });
    await expect(build.getByRole("group", { name: "Screen orientation" })).toBeVisible();
    await expect(build.getByRole("group", { name: "Preview background" })).toBeVisible();
    await expect(build.getByRole("button", { name: "Start test" })).toBeVisible();
    await expect(build.getByRole("group", { name: "Layers · one of each" }).getByRole("button")).toHaveText([
      "+ Chat",
      "+ Characters",
      "PollPlaced",
      "+ Topic",
      "+ Up next",
      "+ Message banner",
      "+ Community card",
      "+ Support banner",
      "+ Camera frame",
    ]);
    await expect(build.getByRole("region", { name: "Composition preview" })).toBeVisible();
    await expect(build.getByRole("region", { name: "No layer selected" })).toBeVisible();
    await expect(
      control
        .getByRole("region", { name: "2 Add to OBS" })
        .getByRole("button", { name: /overlay link|Regenerate link/ }),
    ).toHaveCount(2);

    // The Channels section has the channel cards alone, without a step number. No document loads for it.
    let documents: number = 0;
    control.on("request", (request) => {
      if (request.isNavigationRequest()) documents += 1;
    });
    await sections.getByRole("link", { name: "Channels" }).click();
    await expect(control).toHaveURL(/\/tools\?view=channels$/);
    await expect(sections.getByRole("link", { name: "Channels" })).toHaveAttribute("aria-current", "page");
    await expect(control.getByRole("heading", { level: 1 })).toHaveAccessibleName("Streamer tools");
    await expect(control.getByRole("heading", { level: 2 })).toHaveText(["Connect channels"]);
    expect(await steps()).toEqual(["channels"]);
    expect(documents).toBe(0);
    // No channel is connected. The cards show: no disclosure is around them.
    const channels = control.getByRole("region", { name: "Connect channels" });
    const kick = channels.locator('[data-channel="kick"]');
    const cards = channels.locator("[data-channel]");
    await expect(channels.locator("details.ch-details, [data-channels-summary]")).toHaveCount(0);
    await expect(cards.locator(".ch-pill")).toHaveText(["Twitch", "YouTube", "Kick"]);
    // The cards are in one row and have one height.
    const frames = async (): Promise<{ y: number; height: number }[]> =>
      cards.evaluateAll((items: Element[]): { y: number; height: number }[] =>
        items.map((item: Element): { y: number; height: number } => {
          const box: DOMRect = item.getBoundingClientRect();
          return { y: Math.round(box.y), height: Math.round(box.height) };
        }),
      );
    const level = (boxes: { y: number; height: number }[]): number[] => [
      new Set(boxes.map((box) => box.y)).size,
      new Set(boxes.map((box) => box.height)).size,
    ];
    expect(level(await frames())).toEqual([1, 1]);

    // A card without a connection has the platform and Connect on one line, then the closed notes.
    // This site offers only Kick: the other two cards say so, and they have no button and no notes.
    await expect(channels.getByText("This platform is not set up on this site yet.")).toHaveCount(2);
    await expect(channels.getByRole("button")).toHaveCount(1);
    const connectKick = kick.getByRole("button", { name: "Connect Kick", exact: true });
    await expect(connectKick).toHaveText("Connect");
    await expect(kick.locator(".ch-state")).toHaveCount(0);
    const middle = (box: { y: number; height: number }): number => box.y + box.height / 2;
    const pill = (await kick.locator(".ch-pill").boundingBox())!;
    const connectBox = (await connectKick.boundingBox())!;
    expect(Math.abs(middle(pill) - middle(connectBox))).toBeLessThanOrEqual(1);
    expect(connectBox.x).toBeGreaterThan(pill.x + pill.width);
    const more = cards.locator("details");
    await expect(more).toHaveCount(1);
    await expect(more).not.toHaveAttribute("open");
    await expect(more.locator("summary")).toHaveText("What is read and the limits");
    await expect(more.getByRole("listitem").first()).toBeHidden();
    expect((await more.locator("summary").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // The open notes are below the button: the button does not move.
    // Measured from the top of the card: a click can scroll the page.
    const fromCard = async (): Promise<number> => (await connectKick.boundingBox())!.y - (await kick.boundingBox())!.y;
    const before: number = await fromCard();
    await more.locator("summary").click();
    await expect(more.getByRole("listitem")).toHaveText([
      "Chat starts as soon as the channel is connected.",
      "Read: chat messages, bans and timeouts.",
      "For alerts and goals: follows, subscriptions, gifted subscriptions and KICKs.",
      "Kick emotes show as their names, not as images.",
      "Kick does not report message deletions, chat clears or unbans.",
    ]);
    expect(await fromCard()).toBe(before);
    const button = (await connectKick.boundingBox())!;
    expect((await more.boundingBox())!.y).toBeGreaterThanOrEqual(button.y + button.height);
    // The cards of the row keep one height while the notes of one card are open.
    expect(level(await frames())).toEqual([1, 1]);
    await more.locator("summary").click();

    // With a connected channel the cards still show. The connected card has three lines.
    await runSql("channel-flow-seed", [
      `INSERT INTO channel_connections(id,streamer_id,platform,external_id,display_name,scopes,status,status_code,created_at,updated_at,last_event_at,support_events) VALUES ('${connectionId}',(SELECT id FROM streamers WHERE handle='feature_host'),'kick','flow-kick','Flow Kick','','active',NULL,${now},${now},NULL,1);`,
    ]);
    await control.reload();
    await expect(kick).toBeVisible();
    expect(level(await frames())).toEqual([1, 1]);
    // Line 1: the platform at the left. At the right, the status icon and the account name, on one line.
    const state = kick.locator(".ch-state");
    await expect(state).toHaveText("Healthy. No chat event yet.");
    await expect(state).toHaveAttribute("title", "Healthy. No chat event yet.");
    await expect(state).toHaveAttribute("data-state", "healthy");
    await expect(state.locator("svg")).toHaveClass(/icon-success/);
    await expect(kick.locator(".ch-account")).toHaveText("Flow Kick");
    // The words are for the tooltip and for a screen reader: the card shows no line of text for the status.
    await expect(kick.locator("p")).toHaveCount(0);
    expect((await state.locator(".sr-only").boundingBox())!.width).toBeLessThanOrEqual(1);
    const card = (await kick.boundingBox())!;
    const pillBox = (await kick.locator(".ch-pill").boundingBox())!;
    const stateBox = (await state.boundingBox())!;
    const nameBox = (await kick.locator(".ch-account").boundingBox())!;
    expect(Math.abs(middle(pillBox) - middle(stateBox))).toBeLessThanOrEqual(1);
    expect(Math.abs(middle(stateBox) - middle(nameBox))).toBeLessThanOrEqual(1);
    expect(pillBox.x).toBeLessThan(stateBox.x);
    expect(stateBox.x).toBeLessThan(nameBox.x);
    // Line 2: Reconnect and Disconnect in two equal columns that fill the card.
    const reconnect = kick.getByRole("button", { name: "Reconnect Kick", exact: true });
    const disconnect = kick.getByRole("button", { name: "Disconnect Kick", exact: true });
    await expect(reconnect).toHaveText("Reconnect");
    await expect(disconnect).toHaveText("Disconnect");
    await expect(reconnect.locator("svg")).toHaveClass(/icon-refresh/);
    await expect(disconnect.locator("svg")).toHaveClass(/icon-close/);
    await expect(disconnect).toHaveClass(/danger/);
    const left = (await reconnect.boundingBox())!;
    const right = (await disconnect.boundingBox())!;
    expect(Math.abs(left.width - right.width)).toBeLessThanOrEqual(1);
    expect(left.y).toBe(right.y);
    expect(left.height).toBe(right.height);
    expect(left.height).toBeGreaterThanOrEqual(44);
    expect(right.x).toBeGreaterThan(left.x + left.width);
    // The two columns start at the left edge of the first line and end at its right edge.
    expect(Math.abs(left.x - pillBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(left.x - card.x - (card.x + card.width - right.x - right.width))).toBeLessThanOrEqual(1);
    // Line 3: the closed notes, at the bottom of the card.
    const notes = kick.locator("details");
    await expect(notes).not.toHaveAttribute("open");
    expect((await notes.boundingBox())!.y).toBeGreaterThanOrEqual(left.y + left.height);
    // The "Connect channels" link in the settings of the chat layer opens the Channels section at its heading.
    await sections.getByRole("link", { name: "Overlay" }).click();
    await placeLayer(control, build, "chat");
    const link = build.getByRole("region", { name: "Chat" }).getByRole("link", { name: "Connect channels" });
    await expect(link).toHaveAttribute("href", "/tools?view=channels#channels-title");
    await link.click();
    await expect(control).toHaveURL(/\/tools\?view=channels#channels-title$/);
    await expect(control.locator("#channels-title")).toBeInViewport();
    await expect(kick).toBeVisible();
    // The address has the fragment now: a load shows the heading and the cards again.
    await control.reload();
    await expect(control).toHaveURL(/#channels-title$/);
    await expect(control.locator("#channels-title")).toBeInViewport();
    await expect(kick).toBeVisible();
  } finally {
    await close(owner);
    await runSql("channel-flow-cleanup", [`DELETE FROM channel_connections WHERE id='${connectionId}';`]);
  }
});

test("the channel panel follows a platform that stops and works again while the page is open", async ({ browser }) => {
  const connectionId: string = randomUUID();
  const now: number = Date.now();
  const status = (value: string, code: string | null): string =>
    `UPDATE channel_connections SET status='${value}', status_code=${code ? `'${code}'` : "NULL"}, updated_at=${Date.now()} WHERE id='${connectionId}';`;
  await runSql("channel-live-seed", [
    // The chat layer is on stream, and the last chat event is 100 seconds old.
    layersSql({ chat: { enabled: true }, cells: { horizontal: { chat: CHAT_CELL, poll: POLL_CELL } } }),
    `INSERT INTO channel_connections(id,streamer_id,platform,external_id,display_name,scopes,status,status_code,created_at,updated_at,last_event_at,support_events) VALUES ('${connectionId}',${FEATURE_HOST},'kick','live-kick','Live Kick','','active',NULL,${now},${now},${now - 100_000},1);`,
  ]);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 94));
  try {
    const control = await newPage(owner);
    // The page reads the channels every 20 seconds. The test moves the page clock in place of a wait.
    await control.clock.install({ time: now });
    let documents: number = 0;
    control.on("request", (request) => {
      if (request.isNavigationRequest()) documents += 1;
    });
    await control.goto("/tools?view=channels");
    const sections = control.getByRole("navigation", { name: "Streamer tools sections" });
    const section = control.getByRole("region", { name: "Connect channels" });
    const kick = section.locator('[data-channel="kick"]');
    // The status of the card: an icon with a tooltip, and the same words as text for a screen reader.
    const state = kick.locator(".ch-state");
    const toast = control.locator(".sb-toast");
    // A healthy channel: the icon names the health and the age of the last chat event. No toast, and no warning in
    // the chat settings.
    await expect(state).toHaveText("Healthy. Last chat event 1 minute ago.");
    await expect(state).toHaveAttribute("title", "Healthy. Last chat event 1 minute ago.");
    await expect(state).toHaveAttribute("data-state", "healthy");
    await expect(toast).toHaveCount(0);
    await sections.getByRole("link", { name: "Overlay" }).click();
    const build = control.locator("[data-composition-editor]");
    await chip(build, "chat").click();
    const chat = settings(build);
    await expect(chat).toHaveAttribute("data-comp-props", "chat");
    await expect(chat.locator("[data-comp-chat-down]")).toHaveCount(0);

    // Kick ends the access during the stream. The next read shows it, also in the Overlay section: a toast names
    // it, and the settings of the chat on stream say that no channel delivers chat, with a link to the cards.
    await runSql("channel-live-stop", [status("needs_reauth", "authorization_revoked")]);
    const stopped = control.waitForResponse((response) => new URL(response.url()).pathname === "/api/channels");
    await control.clock.runFor(20_001);
    expect((await stopped).status()).toBe(200);
    await expect(toast).toHaveText("Kick: Access ended. Reconnect to keep receiving chat.");
    await expect(control.locator("#sb-announce-assertive")).toHaveText(
      "Kick: Access ended. Reconnect to keep receiving chat.",
    );
    await expect(chat.locator("[data-comp-chat-down]")).toHaveText("No channel delivers chat right now. See Channels.");
    await expect(chat.locator("[data-comp-chat-down]").getByRole("link", { name: "Channels" })).toHaveAttribute(
      "href",
      "/tools?view=channels#channels-title",
    );
    // The card in the Channels section shows the problem as its status icon. The problem is the tooltip of the icon
    // and its text for a screen reader: the card has no line of text for it.
    await sections.getByRole("link", { name: "Channels" }).click();
    await expect(state).toHaveText("Access ended. Reconnect to keep receiving chat.");
    await expect(state).toHaveAttribute("title", "Access ended. Reconnect to keep receiving chat.");
    await expect(state).toHaveAttribute("data-state", "problem");
    await expect(state.locator("svg")).toHaveClass(/icon-rejected/);
    await expect(kick.getByRole("alert")).toHaveCount(0);
    await expect(kick.locator("p")).toHaveCount(0);
    await expect(kick.getByRole("button", { name: "Reconnect Kick", exact: true })).toBeVisible();
    // The same state at the next read is no news: the toast goes away by itself and does not come back.
    const same = control.waitForResponse((response) => new URL(response.url()).pathname === "/api/channels");
    await control.clock.runFor(15_000);
    await expect(toast).toHaveCount(0);
    await control.clock.runFor(5001);
    await same;
    await expect(state).toHaveAttribute("data-state", "problem");
    await expect(toast).toHaveCount(0);

    // The channel works again: the icon of the card and a toast say so.
    await runSql("channel-live-back", [status("active", null)]);
    const back = control.waitForResponse((response) => new URL(response.url()).pathname === "/api/channels");
    await control.clock.runFor(20_001);
    await back;
    await expect(state).toHaveAttribute("data-state", "healthy");
    await expect(state.locator("svg")).toHaveClass(/icon-success/);
    // The last chat event is 160 seconds old now.
    await expect(state).toHaveText("Healthy. Last chat event 2 minutes ago.");
    await expect(toast).toHaveText("Kick chat is back.");
    await expect(control.locator("#sb-announce-polite")).toHaveText("Kick chat is back.");

    // Reads that fail keep the last list. After the third failure in a row, the panel says so, until a read works.
    await control.route("**/api/channels", (route) => route.abort());
    for (let attempt: number = 1; attempt <= 3; attempt += 1) {
      await expect(section.locator("[data-channels-stale]")).toHaveCount(0);
      const failed = control.waitForEvent("requestfailed", (request) => request.url().endsWith("/api/channels"));
      await control.clock.runFor(20_001);
      await failed;
    }
    await expect(section.locator("[data-channels-stale]")).toHaveText(
      "Status could not be refreshed. Next try in a moment.",
    );
    await expect(state).toHaveAttribute("data-state", "healthy");
    // A failed read makes no toast.
    await expect(toast).toHaveCount(0);
    await control.unroute("**/api/channels");
    const works = control.waitForResponse((response) => new URL(response.url()).pathname === "/api/channels");
    await control.clock.runFor(20_001);
    await works;
    await expect(section.locator("[data-channels-stale]")).toHaveCount(0);
    // Back in the Overlay section, the chat settings have no warning now.
    await sections.getByRole("link", { name: "Overlay" }).click();
    await chip(build, "chat").click();
    await expect(settings(build).locator("[data-comp-chat-down]")).toHaveCount(0);
    // All of it without a reload of the page.
    expect(documents).toBe(1);
  } finally {
    await runSql("channel-live-cleanup", [`DELETE FROM channel_connections WHERE id='${connectionId}';`]);
    await close(owner);
  }
});

test("channel conflicts reload the list and expired authentication leaves a sign-in prompt", async ({ browser }) => {
  const connectionId: string = randomUUID();
  const now: number = Date.now();
  const accountId: string = randomUUID();
  await runSql("channel-conflict-seed", [
    // The account signs in with Google: the prompt for a new sign-in offers that provider.
    `INSERT INTO account(id,account_id,provider_id,user_id,created_at,updated_at) VALUES ('${accountId}','e2e-google-owner','google',(SELECT id FROM user WHERE name='featureowner'),${now},${now});`,
    `INSERT INTO channel_connections(id,streamer_id,platform,external_id,display_name,scopes,status,status_code,created_at,updated_at,last_event_at,support_events) VALUES ('${connectionId}',(SELECT id FROM streamers WHERE handle='feature_host'),'kick','coverage-kick','Conflict Kick','','active',NULL,${now},${now},NULL,1);`,
  ]);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 91));
  // This case owns 203.0.113.141.
  await owner.setExtraHTTPHeaders({ "CF-Connecting-IP": "203.0.113.141", Origin: origin });
  try {
    const control = await newPage(owner);
    // The reloads of the page data that are in flight. The live connection starts one soon after the load.
    let reloads: number = 0;
    const held: Route[] = [];
    const reload = (request: Request): boolean => new URL(request.url()).pathname === "/tools.data";
    control.on("request", (request) => {
      if (reload(request)) reloads += 1;
    });
    const ended = (request: Request): void => {
      if (reload(request)) reloads -= 1;
    };
    control.on("requestfinished", ended);
    control.on("requestfailed", ended);
    await control.goto("/tools?view=channels");
    const kick = control.locator('[data-channel="kick"]');
    // A healthy connection: its card shows at once, with the account and the status icon.
    await expect(kick.locator(".ch-account")).toHaveText("Conflict Kick");
    await expect(kick.locator(".ch-state")).toHaveText("Healthy. No chat event yet.");
    // This tab keeps its old view for this case: hold the reads that keep the panel live.
    await control.route("**/api/channels", (route) => route.abort());
    await control.route("**/api/channels/kick", async (route) => {
      await route.fulfill({ status: 409, json: { error: "The connection changed. Try again." } });
    });
    await kick.getByRole("button", { name: "Disconnect Kick", exact: true }).click();
    await control
      .getByRole("dialog", { name: "Disconnect Kick?" })
      .getByRole("button", { name: "Disconnect Kick", exact: true })
      .click();
    await expect(control.getByRole("dialog", { name: "Disconnect Kick?" })).toBeHidden();
    await expect(control.locator(".sb-toast").filter({ hasText: "The connection changed. Try again." })).toBeVisible();
    await expect(kick.getByRole("button", { name: "Disconnect Kick", exact: true })).toBeEnabled();
    await control.unroute("**/api/channels/kick");
    // Another tab removed it before this tab confirmed its old view. A reload of the page data must not show the
    // removal to this tab first: hold new reloads, and let the ones in flight end, before the removal.
    await control.route("**/tools.data*", (route) => {
      reloads -= 1;
      held.push(route);
    });
    await expect.poll((): number => reloads).toBe(0);
    await runSql("channel-conflict-removed", [`DELETE FROM channel_connections WHERE id='${connectionId}';`]);
    await control.route("**/api/channels/kick", async (route) => {
      await route.fulfill({ status: 404, json: { error: "This channel is no longer connected." } });
    });
    await kick.getByRole("button", { name: "Disconnect Kick", exact: true }).click();
    await control
      .getByRole("dialog", { name: "Disconnect Kick?" })
      .getByRole("button", { name: "Disconnect Kick", exact: true })
      .click();
    await control.unroute("**/tools.data*");
    for (const route of held) await route.continue();
    await expect(kick.getByRole("button", { name: "Connect Kick", exact: true })).toBeFocused();
    // The card has no connection now: no account, no status icon and no Disconnect button.
    await expect(kick.locator(".ch-who")).toHaveCount(0);
    await expect(kick.locator(".ch-state")).toHaveCount(0);
    await expect(kick.getByRole("button")).toHaveCount(1);
    await control.unroute("**/api/channels");
    await control.route("**/api/channels/kick/connect", async (route) => {
      await route.fulfill({ status: 401, json: { error: "Sign in again.", code: "reauth_required" } });
    });
    await kick.getByRole("button", { name: "Connect Kick", exact: true }).click();
    // The prompt is in the card of the platform. It names the platform, the reason and the sign-in provider.
    const prompt = kick.locator(".ch-reauth");
    await expect(prompt).toHaveAttribute("role", "alert");
    await expect(prompt.locator("p").first()).toHaveText(
      "To connect Kick, first confirm that it is you. Sign in to StreamBullets again with Google. The Kick connection then continues by itself.",
    );
    await expect(control.locator(".ch-reauth")).toHaveCount(1);
    // The owner has an account: no display name, no eligibility checkbox, no hint and no legal line.
    await expect(prompt.getByRole("button")).toHaveText(["Continue with Google"]);
    await expect(prompt.getByRole("textbox")).toHaveCount(0);
    await expect(prompt.getByRole("checkbox")).toHaveCount(0);
    await expect(prompt.getByRole("link")).toHaveCount(0);
    await expect(prompt).not.toContainText("Watching on YouTube?");
    // A normal button, not one as wide as the prompt.
    const button = (await prompt.getByRole("button").boundingBox())!;
    expect(button.width).toBeLessThan((await prompt.boundingBox())!.width - 40);
    expect(button.height).toBeGreaterThanOrEqual(44);
    // The request has no eligibility consent and no display name. The tab keeps the intent for the return.
    const signIn = control.waitForRequest("**/api/auth/sign-in/social");
    await control.route("**/api/auth/sign-in/social", async (route) => {
      await route.fulfill({ status: 500, json: {} });
    });
    await prompt.getByRole("button").click();
    expect((await signIn).postDataJSON()).toEqual({
      provider: "google",
      callbackURL: "/tools?view=channels",
      errorCallbackURL: "/sign-in?next=%2Ftools%3Fview%3Dchannels",
    });
    await expect(prompt).toContainText("Sign-in failed. Please try again.");
    const stored = JSON.parse((await control.evaluate(() => sessionStorage.getItem("sb-channel-intent"))) ?? "{}") as {
      platform?: string;
      action?: string;
    };
    expect(stored).toMatchObject({ platform: "kick", action: "connect" });
    // Back from the sign-in: the connect goes on to the provider without a second click, and only once.
    await control.unroute("**/api/channels/kick/connect");
    let connects: number = 0;
    await control.route("**/api/channels/kick/connect", async (route) => {
      connects += 1;
      await route.fulfill({ json: { authorizeUrl: "/tools?view=channels&channel=kick&result=denied" } });
    });
    await control.goto("/tools?view=channels");
    await expect(control.locator(".ch-result")).toHaveText("The Kick authorization was cancelled.");
    expect(connects).toBe(1);
    expect(await control.evaluate(() => sessionStorage.getItem("sb-channel-intent"))).toBeNull();
    await control.reload();
    await expect(kick.getByRole("button", { name: "Connect Kick", exact: true })).toBeVisible();
    expect(connects).toBe(1);
    // An intent that the tab did not store itself, or an old one, starts nothing.
    await control.evaluate(() => {
      sessionStorage.setItem(
        "sb-channel-intent",
        JSON.stringify({ platform: "kick", action: "connect", at: Date.now() - 11 * 60 * 1000 }),
      );
    });
    await control.goto("/tools?view=channels&connect=kick");
    await expect(kick.getByRole("button", { name: "Connect Kick", exact: true })).toBeVisible();
    await expect(kick.getByRole("button", { name: "Connect Kick", exact: true })).toBeEnabled();
    expect(connects).toBe(1);
    await expect(kick.getByRole("button", { name: "Connect Kick", exact: true })).toBeEnabled();
  } finally {
    await close(owner);
    await runSql("channel-conflict-cleanup", [
      `DELETE FROM channel_connections WHERE id='${connectionId}';`,
      `DELETE FROM account WHERE id='${accountId}';`,
    ]);
  }
});

test("a channel without support events shows it on its card only, and the icon of a problem that ends by itself turns", async ({
  browser,
}) => {
  interface Listed {
    platform: string;
    available: boolean;
    connection: Record<string, string | number | null> | null;
    support: boolean;
  }
  const connectionId: string = randomUUID();
  const now: number = Date.now();
  await runSql("channel-support-seed", [
    // The provider refused the support events of this Kick channel: it reads chat only.
    `INSERT INTO channel_connections(id,streamer_id,platform,external_id,display_name,scopes,status,status_code,created_at,updated_at,last_event_at,support_events) VALUES ('${connectionId}',(SELECT id FROM streamers WHERE handle='feature_host'),'kick','support-kick','Support Kick','','active',NULL,${now},${now},NULL,0);`,
  ]);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 92));
  try {
    const page = await newPage(owner);
    // The page reads the channels every 20 seconds. The test moves the page clock in place of a wait.
    await page.clock.install({ time: now });
    await page.goto("/tools?view=channels");
    const section = page.getByRole("region", { name: "Connect channels" });
    const kick = section.locator('[data-channel="kick"]');
    const kickState = kick.locator(".ch-state");
    const toast = page.locator(".sb-toast");
    // No card has a switch: each connected channel reads the support events.
    await expect(kick.locator(".ch-account")).toHaveText("Support Kick");
    await expect(section.getByRole("checkbox")).toHaveCount(0);
    // The card says with its status icon that this channel reads none, and what the owner does about it.
    const refused: string = "Kick does not send the events for alerts and goals. Reconnect Kick to try again.";
    await expect(kickState).toHaveText(refused);
    await expect(kickState).toHaveAttribute("title", refused);
    await expect(kickState).toHaveAttribute("data-state", "support_missing");
    await expect(kickState.locator("svg")).toHaveClass(/icon-rejected/);
    await expect(kick.getByRole("button", { name: "Reconnect Kick", exact: true })).toBeVisible();
    await expect(toast).toHaveCount(0);

    // This test server offers only Kick. The next reads of the channels give the list of a site that also offers
    // Twitch: a Twitch channel from before the support events, without the three permissions for them.
    await page.waitForLoadState("networkidle");
    const connection = { status: "active", code: null, connectedAt: now, lastEventAt: null, updatedAt: now };
    let list: Listed[] = [
      { platform: "twitch", available: true, connection: { ...connection, displayName: "Old Twitch" }, support: false },
      { platform: "youtube", available: false, connection: null, support: false },
      { platform: "kick", available: true, connection: { ...connection, displayName: "Support Kick" }, support: true },
    ];
    await page.route("**/api/channels", (route: Route) => route.fulfill({ json: { channels: list } }));
    const read = async (): Promise<void> => {
      const response = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/channels");
      await page.clock.runFor(20_001);
      await response;
    };
    await read();
    const twitch = section.locator('[data-channel="twitch"]');
    const state = twitch.locator(".ch-state");
    const once: string = "Reconnect Twitch one time so alerts and goals can read follows, subscriptions and Bits.";
    await expect(state).toHaveText(once);
    await expect(state).toHaveAttribute("title", once);
    await expect(state).toHaveAttribute("data-state", "support_missing");
    await expect(state.locator("svg")).toHaveClass(/icon-rejected/);
    // The card keeps its three lines: the account, the two buttons and the closed notes. Reconnect is the fix.
    await expect(twitch.locator(".ch-account")).toHaveText("Old Twitch");
    await expect(twitch.getByRole("button", { name: "Reconnect Twitch", exact: true })).toBeVisible();
    await expect(twitch.getByRole("button", { name: "Disconnect Twitch", exact: true })).toBeVisible();
    await expect(twitch.locator("details")).not.toHaveAttribute("open");
    await expect(twitch.getByRole("alert")).toHaveCount(0);
    await expect(twitch.locator("p")).toHaveCount(0);
    // The Kick channel reads the support events now: its icon is the healthy one.
    await expect(kickState).toHaveAttribute("data-state", "healthy");
    await expect(kickState.locator("svg")).toHaveClass(/icon-success/);
    // The state is on the card only. It is no news in either direction: no toast and no announcement.
    await expect(toast).toHaveCount(0);
    await expect(page.locator("#sb-announce-assertive")).toBeEmpty();
    await expect(page.locator("#sb-announce-polite")).toBeEmpty();

    // A problem that ends without the owner: the icon is the sync icon, and it turns.
    list = list.map(
      (item: Listed): Listed =>
        item.platform === "kick"
          ? { ...item, connection: { ...item.connection, status: "error", code: "webhooks_rejected" } }
          : item,
    );
    await read();
    await expect(kickState).toHaveAttribute("data-state", "repairing");
    await expect(kickState).toHaveText(
      "The feed cannot accept events from the platform right now. It checks again on its own: you do not need to reconnect.",
    );
    const icon = kickState.locator("svg");
    await expect(icon).toHaveClass(/icon-sync/);
    const animation = (): Promise<string> =>
      icon.evaluate((element: Element): string => getComputedStyle(element).animationName);
    expect(await animation()).toBe("sb-spin");
    // The icon of the other card does not turn.
    expect(
      await state.locator("svg").evaluate((element: Element): string => getComputedStyle(element).animationName),
    ).toBe("none");
    // It stays still for reduced motion: in the system, and in the display settings of the site.
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await animation()).toBe("none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(animation).toBe("sb-spin");
    await page.locator("html").evaluate((root: Element): void => {
      root.setAttribute("data-reduced", "true");
    });
    expect(await animation()).toBe("none");
  } finally {
    await close(owner);
    await runSql("channel-support-cleanup", [`DELETE FROM channel_connections WHERE id='${connectionId}';`]);
  }
});

test("the grid preview shows its composition only once it is scaled to the frame", async ({ browser }) => {
  const phone = { viewport: { width: 390, height: 844 } };
  // Without JavaScript, hide the unscaled composition to prevent overflow.
  const still = await fixtureSignedIn(browser, "featureowner", 92, { ...phone, javaScriptEnabled: false });
  const before = await newPage(still);
  await before.goto("/tools?view=overlay");
  await expect(before.locator(".ov-comp-frame .ov-scaler")).toBeHidden();
  await close(still);
  const owner = await fixtureSignedIn(browser, "featureowner", 92, phone);
  const page = await newPage(owner);
  await page.goto("/tools?view=overlay");
  await expect(page.locator(".ov-comp-frame .ov-scaler")).toBeVisible();
  await close(owner);
});

test("an unattended OBS error stays transparent, retries and reloads into recovered content", async ({ browser }) => {
  // This case owns 203.0.113.142. A missing poll is a real loader failure, with no shared fixture damage.
  const context = await browser.newContext({
    baseURL: origin,
    extraHTTPHeaders: { "CF-Connecting-IP": "203.0.113.142" },
  });
  try {
    const page = await newPage(context);
    const now: number = Date.now();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now + 60_000);
    let failedLoads: number = 0;
    let recoveredDocuments: number = 0;
    await page.route("**/@feature_host/overlay*", async (route) => {
      const request = route.request();
      if (failedLoads < 7) {
        failedLoads += 1;
        await route.continue();
        return;
      }
      // The service recovers after the initial failure and six failed data retries.
      const url = new URL(request.url());
      url.searchParams.delete("poll");
      const response = await route.fetch({ url: url.href });
      if (request.isNavigationRequest()) recoveredDocuments += 1;
      await route.fulfill({ response });
    });
    expect((await page.goto(`/@feature_host/overlay?poll=${randomUUID()}`))?.status()).toBe(404);
    const screen = page.locator("main.overlay-screen");
    await expect(screen).toHaveAttribute("aria-busy", "true");
    await expect(screen).toBeEmpty();
    for (let attempt: number = 1; attempt <= 6; attempt += 1) {
      const response = page.waitForResponse((result) => new URL(result.url()).pathname.endsWith("/overlay.data"));
      await page.clock.runFor(60_001);
      expect((await response).status()).toBe(404);
      await expect.poll(() => failedLoads).toBe(attempt + 1);
      await expect(screen).toBeEmpty();
    }
    const reload = page.waitForEvent("domcontentloaded");
    await page.clock.runFor(60_001);
    await reload;
    await expect.poll(() => recoveredDocuments).toBe(1);
    await expect(page.locator("[data-overlay-type]")).toBeVisible();
    await expect(screen).not.toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("button", { name: /retry|reload/i })).toHaveCount(0);
  } finally {
    await close(context);
  }
});

test("the control page moves Up next on when the stream it shows starts", async ({ browser }) => {
  // Start a stream in 20 s, before the seeded Mic shootout. The Up next layer is on the grid.
  const id = randomUUID();
  const now = Date.now();
  await runSql("upnext-soon", [
    layersSql({ cells: { horizontal: { next: { c: 0, r: 0, w: 16, h: 6 } } } }),
    `INSERT INTO stream_events(id,streamer_id,series_id,title,notes,starts_at,duration_min,platform,url,status,repeat_days,repeat_until,tz,created_at,updated_at) VALUES ('${id}',${FEATURE_HOST},NULL,'Soon stream','',${now + 20_000},30,'twitch','https://twitch.tv/feature_host','scheduled',0,NULL,'UTC',${now},${now});`,
  ]);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 94));
  try {
    const control = await newPage(owner);
    await control.goto("/tools?view=overlay");
    const layer = control.locator(
      '[data-composition-editor] .ov-layer[data-layer="next"] [data-overlay-source="next"]',
    );
    await expect(layer).toContainText("Soon stream");
    // After start, load the next stream as OBS does.
    await expect(layer).toContainText("Mic shootout", { timeout: 40_000 });
  } finally {
    await runSql("upnext-soon", [`DELETE FROM stream_events WHERE id='${id}';`]);
    await close(owner);
  }
});

test("the owner sees each channel's connection health and the result of a connection attempt", async ({ browser }) => {
  const page = "(SELECT id FROM streamers WHERE handle='feature_host')";
  const youtubeId = randomUUID();
  const kickId = randomUUID();
  const now = Date.now();
  const row = (id: string, platform: string, external: string, name: string, status: string, code: string): string =>
    `INSERT INTO channel_connections(id,streamer_id,platform,external_id,display_name,scopes,status,status_code,created_at,updated_at,last_event_at,support_events) VALUES ('${id}',${page},'${platform}','${external}','${name}','','${status}','${code}',${now},${now},${now},1);`;
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
    await control.goto("/tools?view=channels&channel=kick&result=channel_taken");
    const section = control.getByRole("region", { name: "Connect channels" });
    // The cards show without a disclosure around them, and the result of the callback is above them.
    await expect(section.locator("details.ch-details, [data-channels-summary]")).toHaveCount(0);
    await expect(section.locator("[data-channel]")).toHaveCount(3);
    const banner = section.locator(".ch-result");
    // The result is read once: the banner is a status region with focus, and no toast repeats it.
    await expect(banner).toHaveText("This Kick channel is already connected to another StreamBullets page.");
    // An <output> element: a status region by its own role.
    await expect(section.getByRole("status").and(banner)).toBeVisible();
    await expect(banner).toBeFocused();
    await expect(control.locator(".toast").filter({ hasText: "already connected" })).toHaveCount(0);
    // It leaves the address, so a reload does not show it again.
    await expect(control).toHaveURL(/\/tools\?view=channels$/);
    const youtube = section.locator('[data-channel="youtube"]');
    // YouTube is not set up here, so its notes about the YouTube limits stay hidden.
    await expect(youtube).not.toContainText("Chat starts when an overlay");
    await expect(youtube.locator("details")).toHaveCount(0);
    await expect(youtube.locator(".ch-account")).toHaveText("Feature Tube");
    // YouTube is not set up on this test server, so its card makes no health claim and gives no reconnect advice:
    // no status icon and no Reconnect button. The connection can still go.
    await expect(youtube.locator(".ch-state")).toHaveCount(0);
    await expect(youtube.getByRole("alert")).toHaveCount(0);
    await expect(youtube.getByRole("button")).toHaveText(["Disconnect"]);
    // Twitch is not set up either, and it has no connection: no status icon and no button.
    const twitch = section.locator('[data-channel="twitch"]');
    await expect(twitch.locator(".ch-state")).toHaveCount(0);
    await expect(twitch.getByRole("button")).toHaveCount(0);
    await expect(section.getByText("This platform is not set up on this site yet.")).toHaveCount(2);
    // Kick is set up and needs the owner: its status icon says what happened and how to fix it.
    const kick = section.locator('[data-channel="kick"]');
    const state = kick.locator(".ch-state");
    await expect(state).toHaveText("Access ended. Reconnect to keep receiving chat.");
    await expect(state).toHaveAttribute("title", "Access ended. Reconnect to keep receiving chat.");
    await expect(state).toHaveAttribute("data-state", "problem");
    await expect(state.locator("svg")).toHaveClass(/icon-rejected/);
    await expect(kick.getByRole("button", { name: "Reconnect Kick", exact: true })).toBeVisible();
    // A failed provider handoff restores the controls and clears the callback banner.
    await control.route("**/api/channels/kick/reconnect", async (route) => {
      await route.fulfill({ status: 503, json: { error: "The request failed. Please try again." } });
    });
    await kick.getByRole("button", { name: "Reconnect Kick", exact: true }).click();
    await expect(control.locator(".sb-toast")).toHaveText("The request failed. Please try again.");
    await expect(kick.getByRole("button", { name: "Reconnect Kick", exact: true })).toBeEnabled();
    await expect(banner).toHaveCount(0);
    await control.unroute("**/api/channels/kick/reconnect");
    await kick.getByRole("button", { name: "Disconnect Kick", exact: true }).click();
    await control
      .getByRole("dialog", { name: "Disconnect Kick?" })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(kick.getByRole("button", { name: "Disconnect Kick", exact: true })).toBeFocused();
    await expect(kick.locator(".ch-account")).toHaveText("Feature Kick");
    // Disconnect: after the confirmation, focus lands on the platform's Connect button.
    await kick.getByRole("button", { name: "Disconnect Kick", exact: true }).click();
    const dialog = control.getByRole("dialog", { name: "Disconnect Kick?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Disconnect Kick", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(kick.getByRole("button", { name: "Connect Kick", exact: true })).toBeFocused();
    await expect(kick.locator(".ch-who")).toHaveCount(0);
    await expect(kick.locator(".ch-state")).toHaveCount(0);
    // Kick could not confirm the revoke (the stored tokens were seeded without any), so the advice stays.
    await expect(kick).toContainText("Remove StreamBullets in your Kick settings.");
    // A platform the site does not offer has no Connect button: focus goes to the section heading.
    await youtube.getByRole("button", { name: "Disconnect YouTube", exact: true }).click();
    const youtubeDialog = control.getByRole("dialog", { name: "Disconnect YouTube?" });
    await youtubeDialog.getByRole("button", { name: "Disconnect YouTube", exact: true }).click();
    await expect(youtube.locator(".ch-who")).toHaveCount(0);
    await expect(youtube.getByRole("button")).toHaveCount(0);
    await expect(control.locator("#channels-title")).toBeFocused();
  } finally {
    await runSql("channels-seed", [`DELETE FROM channel_connections WHERE id IN ('${youtubeId}','${kickId}');`]);
    await close(owner);
  }
});
