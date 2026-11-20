import { newPage, close } from "./coverage";
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "./coverage";
import { runSql, signedIn as fixtureSignedIn } from "./fixtures";
import { CHAT_CELL, POLL_CELL, chip, defaultLayers, layersSql, placeLayer, saved, settings } from "./grid-helpers";
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

  await control.goto("/overlay-control");
  await expect(control.getByRole("heading", { level: 1, name: "Overlay control" })).toBeVisible();
  const editor = control.locator("[data-composition-editor]");
  await expect(editor.locator('.ov-layer[data-layer="poll"] [data-overlay-mash]')).toBeVisible();
  await expect(editor.locator("[data-comp-live-note]")).toHaveText("Changes go live right away");
  // The controls from before the studio are gone: no monitors, no Take and no shortcuts.
  await expect(control.locator("[data-ov-monitor]")).toHaveCount(0);
  await expect(control.getByRole("button", { name: /Take/ })).toHaveCount(0);
  await expect(control.locator("kbd")).toHaveCount(0);
  if (shots) await control.screenshot({ path: `${shots}/overlay-control.png`, fullPage: true });

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
  await control.goto("/overlay-control");
  // Step 3 shows the link controls without a click.
  await expect(control.getByRole("region", { name: "3 Add to OBS" })).toBeVisible();
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
    layersSql({ cells: { horizontal: { poll: { c: 8, r: 0, w: 8, h: 5 } } } }),
  ]);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 90));
  // This case owns 203.0.113.140 so asset requests do not share another case's quota.
  await owner.setExtraHTTPHeaders({ "CF-Connecting-IP": "203.0.113.140", Origin: origin });
  try {
    const control = await newPage(owner);
    await control.setViewportSize({ width: 1440, height: 1000 });
    await control.goto("/overlay-control");
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
    // A failed save of a layer setting shows under the settings, and the setting goes back.
    await panel.getByRole("checkbox", { name: "Show on stream" }).uncheck();
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

test("the page is a flow of three numbered steps, with the channels first and collapsed when one is connected", async ({
  browser,
}) => {
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 91));
  const connectionId: string = randomUUID();
  const now: number = Date.now();
  try {
    const control = await newPage(owner);
    await control.goto("/overlay-control");
    // The steps come in order, each a region named by its numbered level 2 heading.
    await expect(control.locator("[data-step]")).toHaveCount(3);
    expect(
      await control.locator("[data-step]").evaluateAll((steps) => steps.map((step) => step.getAttribute("data-step"))),
    ).toEqual(["channels", "build", "obs"]);
    await expect(control.getByRole("heading", { level: 2 })).toHaveText([
      "1 Connect channels",
      "2 Build your overlay",
      "3 Add to OBS",
    ]);
    // Step 2 is the studio: the toolbar, the layers, the grid and the settings of a layer. Step 3 has the link.
    const build = control.getByRole("region", { name: "2 Build your overlay" });
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
    ]);
    await expect(build.getByRole("region", { name: "Composition preview" })).toBeVisible();
    await expect(build.getByRole("region", { name: "No layer selected" })).toBeVisible();
    await expect(
      control
        .getByRole("region", { name: "3 Add to OBS" })
        .getByRole("button", { name: /overlay link|Regenerate link/ }),
    ).toBeVisible();

    // No channel is connected: the first step is open, with the full panel.
    const channels = control.getByRole("region", { name: "1 Connect channels" });
    const details = channels.locator("details.ch-details");
    const summary = channels.locator("[data-channels-summary]");
    const kick = channels.locator('[data-channel="kick"]');
    await expect(details).toHaveAttribute("open", "");
    await expect(summary).toHaveText("No channel connected yet");
    await expect(kick.getByRole("button", { name: "Connect Kick", exact: true })).toBeVisible();

    // Each card has its name and status, one sentence, and its button. The longer notes are in closed details.
    // This site offers only Kick: the other two cards say so and have no notes.
    const cards = channels.locator("[data-channel]");
    await expect(cards.locator(".ch-body")).toHaveText([
      "This platform is not set up on this site yet.",
      "This platform is not set up on this site yet.",
      "Chat starts as soon as the channel is connected.",
    ]);
    const more = cards.locator("details");
    await expect(more).toHaveCount(1);
    await expect(more).not.toHaveAttribute("open");
    await expect(more.locator("summary")).toHaveText("What is read and the limits");
    await expect(more.getByRole("listitem").first()).toBeHidden();
    expect((await more.locator("summary").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // The open notes are below the button: the button does not move.
    const connectKick = kick.getByRole("button", { name: "Connect Kick", exact: true });
    // Measured from the top of the card: a click can scroll the page.
    const fromCard = async (): Promise<number> => (await connectKick.boundingBox())!.y - (await kick.boundingBox())!.y;
    const before: number = await fromCard();
    await more.locator("summary").click();
    await expect(more.getByRole("listitem")).toHaveText([
      "Read: chat messages, bans and timeouts.",
      "Kick emotes show as their names, not as images.",
      "Kick does not report message deletions, chat clears or unbans.",
    ]);
    expect(await fromCard()).toBe(before);
    const button = (await connectKick.boundingBox())!;
    expect((await more.boundingBox())!.y).toBeGreaterThanOrEqual(button.y + button.height);
    await more.locator("summary").click();

    // With a connected channel the step is one status line. It opens by keyboard and by pointer.
    await runSql("channel-flow-seed", [
      `INSERT INTO channel_connections(id,streamer_id,platform,external_id,display_name,scopes,status,status_code,created_at,updated_at,last_event_at) VALUES ('${connectionId}',(SELECT id FROM streamers WHERE handle='feature_host'),'kick','flow-kick','Flow Kick','','active',NULL,${now},${now},NULL);`,
    ]);
    await control.reload();
    await expect(details).not.toHaveAttribute("open");
    await expect(summary).toHaveText("Connected: Kick");
    await expect(kick).toBeHidden();
    expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await summary.focus();
    await control.keyboard.press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await expect(kick).toContainText("Connected as Flow Kick");
    await summary.click();
    await expect(kick).toBeHidden();
    // The "Connect channels" link in the settings of the chat layer opens the panel again.
    await placeLayer(control, build, "chat");
    const link = build.getByRole("region", { name: "Chat" }).getByRole("link", { name: "Connect channels" });
    await link.click();
    await expect(details).toHaveAttribute("open", "");
    await expect(kick).toBeVisible();
    // The address has the fragment now. The same link opens a closed panel again, and so does a load.
    await summary.click();
    await expect(kick).toBeHidden();
    await link.click();
    await expect(details).toHaveAttribute("open", "");
    await summary.click();
    await expect(kick).toBeHidden();
    await control.reload();
    await expect(control).toHaveURL(/#channels-title$/);
    await expect(details).toHaveAttribute("open", "");
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
    `INSERT INTO channel_connections(id,streamer_id,platform,external_id,display_name,scopes,status,status_code,created_at,updated_at,last_event_at) VALUES ('${connectionId}',${FEATURE_HOST},'kick','live-kick','Live Kick','','active',NULL,${now},${now},${now - 100_000});`,
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
    await control.goto("/overlay-control");
    const section = control.getByRole("region", { name: "1 Connect channels" });
    const details = section.locator("details.ch-details");
    const summary = section.locator("[data-channels-summary]");
    const kick = section.locator('[data-channel="kick"]');
    const toast = control.locator(".sb-toast");
    // A healthy channel: one status line, a closed panel, no toast and no warning in the chat settings.
    await expect(summary).toHaveText("Connected: Kick");
    await expect(details).not.toHaveAttribute("open");
    await expect(toast).toHaveCount(0);
    const build = control.locator("[data-composition-editor]");
    await chip(build, "chat").click();
    const chat = settings(build);
    await expect(chat).toHaveAttribute("data-comp-props", "chat");
    await expect(chat.locator("[data-comp-chat-down]")).toHaveCount(0);

    // Kick ends the access during the stream. The next read shows it: the panel opens and a toast names it.
    await runSql("channel-live-stop", [status("needs_reauth", "authorization_revoked")]);
    const stopped = control.waitForResponse((response) => new URL(response.url()).pathname === "/api/channels");
    await control.clock.runFor(20_001);
    expect((await stopped).status()).toBe(200);
    await expect(summary).toHaveText("Needs attention: Kick");
    await expect(details).toHaveAttribute("open", "");
    await expect(kick.locator(".ch-mark")).toHaveText("Needs attention");
    await expect(kick.locator(".ch-mark")).toHaveAttribute("data-health", "attention");
    await expect(kick.getByRole("alert")).toHaveText("Access ended. Reconnect to keep receiving chat.");
    await expect(toast).toHaveText("Kick: Access ended. Reconnect to keep receiving chat.");
    await expect(control.locator("#sb-announce-assertive")).toHaveText(
      "Kick: Access ended. Reconnect to keep receiving chat.",
    );
    // The age of the last chat event is a time element with the absolute time as its title.
    const age = kick.locator("time");
    await expect(age).toHaveText("Last chat event 2 minutes ago");
    await expect(age).toHaveAttribute("datetime", new Date(now - 100_000).toISOString());
    await expect(age).toHaveAttribute("title", /\d/);
    // The chat is on stream and no channel delivers chat: its settings say so, with a link to step 1.
    await expect(chat.locator("[data-comp-chat-down]")).toHaveText("No channel delivers chat right now. See step 1.");
    await expect(chat.locator("[data-comp-chat-down]").getByRole("link", { name: "step 1" })).toHaveAttribute(
      "href",
      "#channels-title",
    );
    // The same state at the next read is no news: the toast goes away by itself and does not come back.
    const same = control.waitForResponse((response) => new URL(response.url()).pathname === "/api/channels");
    await control.clock.runFor(15_000);
    await expect(toast).toHaveCount(0);
    await control.clock.runFor(5001);
    await same;
    await expect(kick.locator(".ch-mark")).toHaveText("Needs attention");
    await expect(toast).toHaveCount(0);

    // The channel works again: the card, the status line and a toast say so. The panel stays open.
    await runSql("channel-live-back", [status("active", null)]);
    const back = control.waitForResponse((response) => new URL(response.url()).pathname === "/api/channels");
    await control.clock.runFor(20_001);
    await back;
    await expect(summary).toHaveText("Connected: Kick");
    await expect(kick.locator(".ch-mark")).toHaveText("Healthy");
    await expect(kick.getByRole("alert")).toHaveCount(0);
    await expect(toast).toHaveText("Kick chat is back.");
    await expect(control.locator("#sb-announce-polite")).toHaveText("Kick chat is back.");
    await expect(details).toHaveAttribute("open", "");
    await expect(chat.locator("[data-comp-chat-down]")).toHaveCount(0);

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
    await expect(kick.locator(".ch-mark")).toHaveText("Healthy");
    // A failed read makes no toast.
    await expect(toast).toHaveCount(0);
    await control.unroute("**/api/channels");
    const works = control.waitForResponse((response) => new URL(response.url()).pathname === "/api/channels");
    await control.clock.runFor(20_001);
    await works;
    await expect(section.locator("[data-channels-stale]")).toHaveCount(0);
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
    `INSERT INTO channel_connections(id,streamer_id,platform,external_id,display_name,scopes,status,status_code,created_at,updated_at,last_event_at) VALUES ('${connectionId}',(SELECT id FROM streamers WHERE handle='feature_host'),'kick','coverage-kick','Conflict Kick','','active',NULL,${now},${now},NULL);`,
  ]);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 91));
  // This case owns 203.0.113.141.
  await owner.setExtraHTTPHeaders({ "CF-Connecting-IP": "203.0.113.141", Origin: origin });
  try {
    const control = await newPage(owner);
    await control.goto("/overlay-control");
    const kick = control.locator('[data-channel="kick"]');
    // A healthy connection: the section starts as one status line. Open it for the full panel.
    await control.getByText("Connected: Kick", { exact: true }).click();
    await expect(kick).toContainText("No chat event yet");
    await expect(kick.locator(".ch-mark")).toHaveText("Healthy");
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
    // Another tab removed it before this tab confirmed its old view.
    await runSql("channel-conflict-removed", [`DELETE FROM channel_connections WHERE id='${connectionId}';`]);
    await control.route("**/api/channels/kick", async (route) => {
      await route.fulfill({ status: 404, json: { error: "This channel is no longer connected." } });
    });
    await kick.getByRole("button", { name: "Disconnect Kick", exact: true }).click();
    await control
      .getByRole("dialog", { name: "Disconnect Kick?" })
      .getByRole("button", { name: "Disconnect Kick", exact: true })
      .click();
    await expect(kick.getByRole("button", { name: "Connect Kick", exact: true })).toBeFocused();
    await expect(kick).toContainText("Not connected");
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
      callbackURL: "/overlay-control",
      errorCallbackURL: "/sign-in?next=%2Foverlay-control",
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
      await route.fulfill({ json: { authorizeUrl: "/overlay-control?channel=kick&result=denied" } });
    });
    await control.goto("/overlay-control");
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
    await control.goto("/overlay-control?connect=kick");
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

test("the grid preview shows its composition only once it is scaled to the frame", async ({ browser }) => {
  const phone = { viewport: { width: 390, height: 844 } };
  // Without JavaScript, hide the unscaled composition to prevent overflow.
  const still = await fixtureSignedIn(browser, "featureowner", 92, { ...phone, javaScriptEnabled: false });
  const before = await newPage(still);
  await before.goto("/overlay-control");
  await expect(before.locator(".ov-comp-frame .ov-scaler")).toBeHidden();
  await close(still);
  const owner = await fixtureSignedIn(browser, "featureowner", 92, phone);
  const page = await newPage(owner);
  await page.goto("/overlay-control");
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
    layersSql({ cells: { horizontal: { next: { c: 0, r: 0, w: 8, h: 3 } } } }),
    `INSERT INTO stream_events(id,streamer_id,series_id,title,notes,starts_at,duration_min,platform,url,status,repeat_days,repeat_until,tz,created_at,updated_at) VALUES ('${id}',${FEATURE_HOST},NULL,'Soon stream','',${now + 20_000},30,'twitch','https://twitch.tv/feature_host','scheduled',0,NULL,'UTC',${now},${now});`,
  ]);
  const owner = await signedIn(browser, "featureowner", clientIp("overlay-control", 94));
  try {
    const control = await newPage(owner);
    await control.goto("/overlay-control");
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
    const section = control.getByRole("region", { name: "1 Connect channels" });
    // A callback result and a connection to repair open the section.
    await expect(section.locator("details.ch-details")).toHaveAttribute("open", "");
    await expect(section.locator("[data-channels-summary]")).toHaveText("Connected: YouTube · Needs attention: Kick");
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
    await expect(youtube.locator("time")).toHaveText(/^Last chat event (just now|\d+ seconds? ago)$/);
    // The site does not offer YouTube, so the card makes no health claim. Kick needs the owner.
    await expect(youtube.locator(".ch-mark")).toHaveCount(0);
    await expect(section.locator('[data-channel="kick"] .ch-mark')).toHaveText("Needs attention");
    await expect(section.locator('[data-channel="twitch"] .ch-mark')).toHaveText("Not connected");
    await expect(section.getByText("This platform is not set up on this site yet.")).toHaveCount(2);
    // Kick is set up: its card shows what happened and how to fix it.
    const kick = section.locator('[data-channel="kick"]');
    await expect(kick.getByRole("alert")).toHaveText("Access ended. Reconnect to keep receiving chat.");
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
    await expect(kick).toContainText("Connected as Feature Kick");
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
