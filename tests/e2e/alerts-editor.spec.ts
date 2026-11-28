import { createHash } from "node:crypto";
import type { Locator, Request, Response, Route, WebSocket } from "@playwright/test";
import { close, expect, newPage, test, type Browser, type BrowserContext, type Page } from "./coverage";
import { clientIp } from "./client-ips";
import { runSql, signedIn } from "./fixtures";
import {
  FEATURE_HOST,
  chip,
  defaultLayers,
  layersSql,
  noKeysSql,
  placeLayer,
  resetLayers,
  saved,
  settings,
  storedLayers,
} from "./grid-helpers";

// The Alerts layer and the Goal layer in the overlay editor (issue #1043): their place on the grid, their settings,
// a test alert that reaches a real OBS page, the count of the goal, the keyboard, and a phone.
const ALERTS_IP = clientIp("alerts-editor", 68);
const GOAL_IP = clientIp("alerts-editor", 69);
const KEYS_IP = clientIp("alerts-editor", 70);
const PHONE_IP = clientIp("alerts-editor", 71);
const OBS_IP = clientIp("alerts-editor", 72);
const shotDir: string | undefined = process.env.ALERTS_EDITOR_SHOTS;

/** A key of the horizontal output, in the form of a real key, so that a real OBS page opens its activity socket. */
const HORIZONTAL_KEY: string = "H".repeat(43);
const horizontalKeySql: string = `${noKeysSql}
INSERT INTO overlay_keys (streamer_id, output, key_hash, created_at) VALUES (${FEATURE_HOST}, 'horizontal', '${createHash("sha256").update(HORIZONTAL_KEY).digest("hex")}', 0);`;

test.beforeEach(async () => {
  await runSql("alerts-editor-reset", [resetLayers]);
});

test.afterAll(async () => {
  await runSql("alerts-editor-cleanup", [defaultLayers, noKeysSql]);
});

async function openEditor(
  browser: Browser,
  ip: number,
  viewport: { width: number; height: number } = { width: 1440, height: 1000 },
  locale: string | null = null,
): Promise<{ owner: BrowserContext; page: Page; editor: Locator; frame: Locator }> {
  const owner = await signedIn(browser, "featureowner", ip, { viewport });
  if (locale)
    await owner.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/", sameSite: "Lax" }]);
  const page = await newPage(owner);
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  const frame = editor.locator(".ov-comp-frame");
  await expect(frame).toHaveAttribute("data-scaled", "true");
  return { owner, page, editor, frame };
}

/** The OBS page of the horizontal output, with its real activity socket. It resolves when the socket has its snapshot. */
async function obsPage(browser: Browser): Promise<Page> {
  const page = await newPage(browser, {
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${OBS_IP}` },
  });
  const socket: Promise<WebSocket> = page.waitForEvent("websocket", (ws: WebSocket) =>
    ws.url().includes("/api/activity/feature_host"),
  );
  await page.goto(`/@feature_host/overlay?key=${HORIZONTAL_KEY}`);
  await (await socket).waitForEvent("framereceived");
  return page;
}

/** The request bodies of the layer saves of a page. */
function layerSaves(page: Page): unknown[] {
  const bodies: unknown[] = [];
  page.on("request", (request: Request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/overlay") {
      // Each editor sends its own write order: leave it out.
      const body = request.postDataJSON() as Record<string, unknown>;
      bodies.push(Object.fromEntries(Object.entries(body).filter(([key]) => key !== "write")));
    }
  });
  return bodies;
}

/** The alert controls of a page, as they reach the server. */
function alertControls(page: Page): unknown[] {
  const bodies: unknown[] = [];
  page.on("request", (request: Request) => {
    if (new URL(request.url()).pathname === "/api/overlay/alerts") bodies.push(request.postDataJSON());
  });
  return bodies;
}

function answered(page: Page): Promise<Response> {
  return page.waitForResponse((response) => new URL(response.url()).pathname === "/api/overlay/alerts");
}

async function pick(page: Page, list: Locator, option: string): Promise<void> {
  await list.click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/** A screenshot of one part of the page, for the review. Only with ALERTS_EDITOR_SHOTS set. */
async function shot(page: Page, name: string): Promise<void> {
  if (!shotDir) return;
  // The page scrolls in its main part: one picture from the top of the studio and one of the settings.
  const parts: [string, Locator][] = [
    ["studio", page.locator("[data-composition-editor]")],
    ["settings", page.locator("[data-comp-props]")],
  ];
  for (const [part, target] of parts) {
    await target.evaluate((element: Element) => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `${shotDir}/${name}-${part}.png`, animations: "disabled" });
  }
}

/** The name of the focused element: its own name, the text of its label, or its text. */
function focusedName(page: Page): Promise<string> {
  return page.evaluate((): string => {
    const element: Element | null = document.activeElement;
    const label: string | null | undefined =
      element instanceof HTMLInputElement && element.type === "checkbox" ? element.labels?.[0]?.textContent : null;
    return (element?.getAttribute("aria-label") ?? label ?? element?.textContent ?? "").trim();
  });
}

test("the owner places the Alerts layer, changes its rules, and a test from the editor shows on the OBS page", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  await runSql("alerts-editor-key", [horizontalKeySql]);
  const { owner, page, editor, frame } = await openEditor(browser, ALERTS_IP);
  const saves: unknown[] = layerSaves(page);
  const controls: unknown[] = alertControls(page);
  // The palette has the Recognition group between Picture and Content.
  const palette = editor.locator("[data-comp-palette]");
  await expect(palette.locator("summary")).toHaveText(["Picture · 3", "Recognition · 2", "Content · 6"]);
  await placeLayer(page, editor, "alerts");
  const panel = settings(editor);
  await expect(panel).toHaveAttribute("data-comp-props", "alerts");
  await expect(frame.locator('[data-grid-box="alerts"]')).toContainText("Alerts · 480 × 180");
  // The preview shows a sample banner, not an alert of the page.
  await expect(frame.locator('.ov-layer [data-overlay-alert="gift"]')).toContainText("Mad Maxine");
  await expect(panel.getByRole("checkbox", { name: "Show on stream" })).toBeChecked();
  const send = panel.getByRole("button", { name: "Send test" });
  await expect(send).toHaveAttribute("aria-disabled", "false");

  // The table has a header row and one row for each rule that the server makes today. The topic credit has none.
  const table = panel.getByRole("table", { name: "What each event does" });
  await expect(table.getByRole("columnheader")).toHaveText(["Event", "Starts at", "Banner", "In chat", "Character"]);
  await expect(table.getByRole("rowheader")).toHaveText([
    "Follow Twitch, Kick",
    "Subscription, membership Twitch, YouTube, Kick",
    "Gift One alert for the bundle",
    "Bits, KICKs Twitch, Kick",
    "Super Chat, Super Sticker YouTube",
    "Raid Twitch · viewers",
  ]);
  await expect(table.getByRole("textbox")).toHaveCount(3);
  const bits = table.getByRole("textbox", { name: "Starts at: smallest amount for Bits, KICKs" });
  await expect(bits).toHaveValue("100");
  // A threshold saves after a pause in typing, as one field.
  saves.length = 0;
  let save = saved(page);
  await bits.fill("250");
  await save;
  expect(saves).toEqual([{ action: "layers", alerts: { rules: { bits: { min: 250 } } } }]);
  expect((await storedLayers(page)).alerts.rules.bits.min).toBe(250);
  // An invalid amount does not save. The field tells the limits when the focus leaves it.
  const raid = table.getByRole("textbox", { name: "Starts at: smallest amount for Raid" });
  await raid.fill("0");
  await raid.blur();
  await expect(raid).toHaveAttribute("aria-invalid", "true");
  await expect(raid).toHaveAccessibleDescription("Enter a whole number from 1 to 1,000,000.");
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 600)));
  expect(saves).toHaveLength(1);
  save = saved(page);
  await raid.fill("12");
  await save;
  await expect(raid).not.toHaveAttribute("aria-invalid");
  // A value typed on the way never saves: 25, then two quick Backspaces leave the field empty, and 2 does not save.
  const before: number = saves.length;
  await raid.fill("");
  await raid.pressSequentially("25");
  await raid.press("Backspace");
  await raid.press("Backspace");
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 600)));
  await raid.blur();
  await expect(raid).toHaveAttribute("aria-invalid", "true");
  expect(saves).toHaveLength(before);
  expect((await storedLayers(page)).alerts.rules.raid.min).toBe(12);
  await raid.fill("12");
  await raid.blur();
  await expect(raid).not.toHaveAttribute("aria-invalid");
  // A switch saves one field at once.
  save = saved(page);
  await table.getByRole("checkbox", { name: "Banner for Follow" }).check();
  await save;
  await expect.poll(() => saves.at(-1)).toEqual({ action: "layers", alerts: { rules: { follow: { banner: true } } } });
  const stored = (await storedLayers(page)).alerts.rules;
  expect(stored.follow.banner).toBe(true);
  expect(stored.raid.min).toBe(12);
  await expect(table.getByRole("checkbox", { name: "Character action for Raid: All cheer" })).toBeChecked();
  // The help is closed, with the behaviour that the owner decided.
  const help = panel.locator("[data-alert-help]");
  await expect(help).toHaveJSProperty("open", false);
  await help.locator("summary").click();
  await expect(help.locator("li")).toHaveCount(6);
  await expect(help).toContainText("Mute stops the alert on stream and discards the alerts that wait.");
  await shot(page, "1440-h-alerts");

  // A test from the editor plays on the OBS page, with the TEST mark.
  const obs = await obsPage(browser);
  await pick(page, panel.getByRole("combobox", { name: "Test alert" }), "Raid with 38 viewers");
  const answer = answered(page);
  await send.click();
  expect((await answer).status()).toBe(200);
  expect(controls).toEqual([{ op: "test", kind: "raid" }]);
  await expect(send).toBeFocused();
  await expect(panel.locator("[data-alert-news]")).toHaveText("Test alert sent.");
  const banner = obs.locator('[data-overlay-alert="raid"]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Long Haul Trucker");
  await expect(banner.locator("[data-alert-test]")).toHaveText("TEST");
  if (shotDir) await obs.screenshot({ path: `${shotDir}/obs-test-alert-from-editor.png` });
  await close(obs);

  // A refusal of the server shows its reason under the button.
  await page.route("**/api/overlay/alerts", (route: Route) =>
    route.fulfill({ status: 409, json: { error: "Alerts are muted. Turn the mute off first.", code: "alerts_muted" } }),
  );
  await send.click();
  await expect(panel.locator("[data-alert-failed]")).toHaveText(
    "Test alert not sent: Alerts are muted. Turn the mute off in Live or in the OBS dock first.",
  );
  await expect(panel.getByRole("alert")).toHaveCount(1);
  await page.unroute("**/api/overlay/alerts");
  // Off stream: the button is unavailable, with its reason in view, and a press sends nothing.
  save = saved(page);
  await panel.getByRole("checkbox", { name: "Show on stream" }).uncheck();
  await save;
  await expect(send).toHaveAttribute("aria-disabled", "true");
  await expect(send).toHaveAccessibleDescription("Turn on “Show on stream” to send a test.");
  await expect(panel.locator("[data-alert-needs-layer]")).toBeVisible();
  // The reason of the old refusal goes: the reason in view is the layer.
  await expect(panel.locator("[data-alert-failed]")).toHaveCount(0);
  const sent: number = controls.length;
  // A pointer press on the unavailable button (Playwright waits for an enabled element, so dispatch it).
  await send.dispatchEvent("click");
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
  expect(controls).toHaveLength(sent);
  await close(owner);
});

test("Start test also sends one test alert while the Alerts layer is on stream", async ({ browser }) => {
  await runSql("alerts-editor-start", [
    layersSql({ alerts: { enabled: true }, cells: { horizontal: { alerts: { c: 8, r: 0, w: 16, h: 3 } } } }),
  ]);
  const { owner, page, editor } = await openEditor(browser, ALERTS_IP);
  const controls: unknown[] = alertControls(page);
  await page.route("**/api/overlay/alerts", (route: Route) =>
    route.fulfill({ json: { at: 1, muted: false, current: null, waiting: 0, goal: null } }),
  );
  const toggle = editor.locator(".ov-comp-bar").getByRole("button", { name: "Start test" });
  await expect(toggle).toHaveAttribute("aria-disabled", "false");
  await expect(toggle).toHaveAccessibleDescription("Shows one test alert in OBS. Nothing goes to your channels.");
  await toggle.click();
  await expect.poll(() => controls).toEqual([{ op: "test" }]);
  // An alert has no time to stop: the button stays Start test, and a polite region tells the result.
  await expect(editor.locator("[data-test-news]")).toHaveText("Test alert sent.");
  await expect(toggle).toBeVisible();
  // A refusal shows in a toast.
  await page.unroute("**/api/overlay/alerts");
  await page.route("**/api/overlay/alerts", (route: Route) =>
    route.fulfill({ status: 409, json: { error: "No page shows alerts now.", code: "alerts_unwatched" } }),
  );
  await toggle.click();
  await expect(page.locator(".sb-toast")).toHaveText(
    "Test alert not sent: No page shows alerts now. Open the overlay in OBS first.",
  );
  await close(owner);
});

test("a threshold typed just before the owner reloads the page still saves", async ({ browser }) => {
  await runSql("alerts-editor-leave", [
    layersSql({ alerts: { enabled: true }, cells: { horizontal: { alerts: { c: 8, r: 0, w: 16, h: 3 } } } }),
  ]);
  const { owner, page, editor } = await openEditor(browser, ALERTS_IP);
  await chip(editor, "alerts").click();
  const raid = settings(editor).getByRole("textbox", { name: "Starts at: smallest amount for Raid" });
  await expect(raid).toBeVisible();
  // The reload comes well inside the pause of the field, and the field keeps the focus.
  await raid.fill("37");
  await page.reload();
  await expect.poll(async () => (await storedLayers(page)).alerts.rules.raid.min).toBe(37);
  await close(owner);
});

test("the owner places the Goal layer, edits it, sees its count, and starts the count again", async ({ browser }) => {
  test.setTimeout(90_000);
  await runSql("alerts-editor-key", [horizontalKeySql]);
  const owner = await signedIn(browser, "featureowner", GOAL_IP, { viewport: { width: 1440, height: 1000 } });
  const page = await newPage(owner);
  // The settings of the goal open the owner's activity socket: the count comes from the server.
  const ownerSocket: Promise<WebSocket> = page.waitForEvent("websocket", (ws: WebSocket) =>
    ws.url().includes("/api/activity/feature_host"),
  );
  await page.goto("/tools?view=overlay");
  const editor = page.locator("[data-composition-editor]");
  const frame = editor.getByRole("region", { name: "Composition preview" });
  await expect(frame).toHaveAttribute("data-scaled", "true");
  const saves: unknown[] = layerSaves(page);
  const controls: unknown[] = alertControls(page);
  await placeLayer(page, editor, "goal");
  const panel = settings(editor);
  await expect(panel).toHaveAttribute("data-comp-props", "goal");
  expect(new URL((await ownerSocket).url()).searchParams.get("key")).toBeNull();
  await expect(frame.locator('[data-grid-box="goal"]')).toContainText("Goal · 480 × 120");

  // The title saves after a pause in typing. It has a limit.
  const title = panel.getByRole("textbox", { name: "Title on stream" });
  await expect(title).toHaveAttribute("maxlength", "60");
  saves.length = 0;
  let save = saved(page);
  await title.fill("New subscribers");
  await save;
  expect(saves).toEqual([{ action: "layers", goal: { title: "New subscribers" } }]);
  // On a low box the name and the size of the grid do not cover the title of the goal.
  const tag = await frame.locator('[data-grid-box="goal"] .ov-grid-tag').boundingBox();
  const shown = await frame.locator(".ov-layer [data-goal-title]").boundingBox();
  if (!tag || !shown) throw new Error("No tag or title.");
  expect(tag.y >= shown.y + shown.height || tag.y + tag.height <= shown.y).toBe(true);

  // The list offers each thing that the server counts, also the poll votes and the new topics.
  const counts = panel.getByRole("combobox", { name: "Counts" });
  await expect(counts).toHaveText("Subscriptions, memberships, and gifts");
  await counts.click();
  await expect(page.getByRole("option")).toHaveText([
    "Subscriptions, memberships, and gifts",
    "Follows",
    "Bits",
    "KICKs",
    "People who chat",
    "Poll votes and new topics",
  ]);
  save = saved(page);
  await page.getByRole("option", { name: "Bits", exact: true }).click();
  await save;
  expect(saves.at(-1)).toEqual({ action: "layers", goal: { counts: "bits" } });
  const target = panel.getByRole("textbox", { name: "Target" });
  save = saved(page);
  await target.fill("40");
  await save;
  expect((await storedLayers(page)).goal).toMatchObject({ title: "New subscribers", counts: "bits", target: 40 });
  await expect(panel.locator("[data-goal-progress]")).toHaveText("0 of 40");
  await expect(panel.getByRole("progressbar", { name: "Count of the goal" })).toHaveAttribute(
    "aria-valuetext",
    "0 of 40",
  );
  await expect(panel).toContainText("A goal counts one thing. Bits, KICKs, and currencies do not convert.");
  await shot(page, "1440-h-goal");

  // The OBS page shows the goal with its title.
  const obs = await obsPage(browser);
  await expect(obs.locator("[data-overlay-goal]")).toContainText("New subscribers · 0 of 40");
  await close(obs);

  // Start again asks first. Cancel sends nothing; the confirmation sends one control.
  const reset = panel.getByRole("button", { name: "Start again" });
  await reset.click();
  const dialog = page.getByRole("dialog", { name: "Start the count again?" });
  await expect(dialog).toContainText("The count goes back to 0. Events from before do not count.");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(reset).toBeFocused();
  expect(controls).toEqual([]);
  await reset.click();
  const answer = answered(page);
  await dialog.getByRole("button", { name: "Start again" }).click();
  expect((await answer).status()).toBe(200);
  expect(controls).toEqual([{ op: "goalReset" }]);
  await expect(dialog).toHaveCount(0);
  await expect(panel.locator("[data-goal-news]")).toHaveText("The count starts again at 0.");
  await expect(reset).toBeFocused();
  // A refusal shows its reason under the button.
  await page.route("**/api/overlay/alerts", (route: Route) => route.fulfill({ status: 429, json: { error: "Slow" } }));
  await reset.click();
  await dialog.getByRole("button", { name: "Start again" }).click();
  await expect(panel.locator("[data-goal-failed]")).toHaveText(/^Count not started again: \S/);
  await close(owner);
});

test("a goal for poll votes counts each vote and each new topic one time", async ({ browser }) => {
  await runSql("alerts-editor-votes", [
    layersSql({ goal: { target: 10 }, cells: { horizontal: { goal: { c: 0, r: 4, w: 8, h: 2 } } } }),
  ]);
  const { owner, page, editor } = await openEditor(browser, GOAL_IP);
  await chip(editor, "goal").click();
  const panel = settings(editor);
  // The saved change tells the server what the goal counts.
  const counts = panel.getByRole("combobox", { name: "Counts" });
  await counts.click();
  const save = saved(page);
  await page.getByRole("option", { name: "Poll votes and new topics", exact: true }).click();
  await save;
  await expect(counts).toHaveText("Poll votes and new topics");
  const progress = panel.locator("[data-goal-progress]");
  await expect(progress).toHaveText("0 of 10");
  /** One write to the public page, as the owner. It gives the ID in the answer. */
  async function write(data: Record<string, unknown>): Promise<string> {
    const response = await owner.request.post("/api/streamers/feature_host", { data });
    expect(response.status(), JSON.stringify(data)).toBe(200);
    return ((await response.json()) as { id: string }).id;
  }
  const created: string[] = [];
  try {
    const poll: string = await write({ action: "create", kind: "binary", title: "A poll for the goal of votes" });
    created.push(poll);
    // A new poll is not a vote.
    await write({ action: "vote", id: poll, choice: 0 });
    await expect(progress).toHaveText("1 of 10");
    // A changed vote counts for nothing. A new topic counts.
    await write({ action: "vote", id: poll, choice: 1 });
    created.push(
      await write({ action: "create", kind: "topic", title: "A goal topic", body: "Details.", category: "Gaming" }),
    );
    await expect(progress).toHaveText("2 of 10");
  } finally {
    for (const id of created) await write({ action: "delete", id });
  }
  await close(owner);
});

test("the keyboard alone places the Alerts layer and reaches and changes each of its settings", async ({ browser }) => {
  const { owner, page, editor } = await openEditor(browser, KEYS_IP);
  const grid = editor.locator("[data-comp-grid]");
  const controls: unknown[] = alertControls(page);
  await chip(editor, "alerts").focus();
  let save = saved(page);
  await page.keyboard.press("Enter");
  await save;
  await expect(grid).toBeFocused();
  await expect(editor.locator("[data-grid-status]")).toHaveText("Alerts placed at column 1, row 1, 8 × 3 cells.");
  const panel = settings(editor);
  // Tab goes from the grid through the settings in their visual sequence.
  const names: string[] = [];
  for (let step = 0; step < 10; step += 1) {
    await page.keyboard.press("Tab");
    names.push(await focusedName(page));
  }
  expect(names).toEqual([
    "Gift of 5 subscriptions",
    "Send test",
    "Show on stream",
    "Banner for Follow",
    "Mark in chat for Follow",
    "Character action for Follow: Wave",
    "Banner for Subscription, membership",
    "Mark in chat for Subscription, membership",
    "Character action for Subscription, membership: Jump",
    "Starts at: smallest amount for Gift",
  ]);
  // The amount takes typed digits and saves after a pause.
  save = saved(page);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("3");
  await save;
  expect((await storedLayers(page)).alerts.rules.gift.min).toBe(3);
  // Space changes a switch.
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("checkbox", { name: "Banner for Gift" })).toBeFocused();
  save = saved(page);
  await page.keyboard.press("Space");
  await save;
  expect((await storedLayers(page)).alerts.rules.gift.banner).toBe(false);
  // The list of tests opens and takes a choice with the keyboard. Enter on Send test sends it; no page shows
  // alerts, so the server refuses, and the reason shows under the button.
  const list = panel.getByRole("combobox", { name: "Test alert" });
  await list.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  // The list opens on the selected test. The arrow key moves to the next one.
  await expect(page.getByRole("option", { name: "Gift of 5 subscriptions" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "500 Bits" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(list).toHaveText("500 Bits");
  await expect(list).toBeFocused();
  await page.keyboard.press("Tab");
  const send = panel.getByRole("button", { name: "Send test" });
  await expect(send).toBeFocused();
  const answer = answered(page);
  await page.keyboard.press("Enter");
  await answer;
  expect(controls).toEqual([{ op: "test", kind: "bits" }]);
  await expect(panel.locator("[data-alert-failed]")).toHaveText(
    "Test alert not sent: No page shows alerts now. Open the overlay in OBS first.",
  );
  await expect(send).toBeFocused();
  // The help opens with Enter on its summary.
  const help = panel.locator("[data-alert-help]");
  await help.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(help).toHaveJSProperty("open", true);
  // The layer moves and goes away with the keyboard, as each layer does.
  await grid.focus();
  save = saved(page);
  await page.keyboard.press("Shift+ArrowRight");
  await save;
  expect((await storedLayers(page)).cells.horizontal.alerts).toEqual({ c: 1, r: 0, w: 8, h: 3 });
  save = saved(page);
  await page.keyboard.press("Alt+ArrowDown");
  await save;
  expect((await storedLayers(page)).cells.horizontal.alerts).toEqual({ c: 1, r: 0, w: 8, h: 4 });
  save = saved(page);
  await page.keyboard.press("Delete");
  await save;
  expect((await storedLayers(page)).cells.horizontal.alerts).toBeNull();
  await expect(chip(editor, "alerts")).not.toHaveAttribute("data-placed");
  await close(owner);
});

for (const locale of ["en", "de", "ru"])
  test(`at 390 px in ${locale} the rules and the goal fit the phone, and no text is cut`, async ({ browser }) => {
    await runSql("alerts-editor-phone", [
      layersSql({
        alerts: { enabled: true },
        goal: { enabled: true, title: "Neue Abonnenten und Mitgliedschaften" },
        cells: {
          horizontal: { alerts: { c: 0, r: 0, w: 16, h: 3 }, goal: { c: 16, r: 0, w: 8, h: 2 } },
          vertical: { alerts: { c: 0, r: 0, w: 18, h: 3 }, goal: { c: 0, r: 3, w: 18, h: 2 } },
        },
      }),
    ]);
    const { owner, page, editor } = await openEditor(browser, PHONE_IP, { width: 390, height: 844 }, locale);
    const panel = settings(editor);
    const problems = (): Promise<string[]> =>
      panel.evaluate((root: Element): string[] => {
        const found: string[] = [];
        const sideways: number = document.documentElement.scrollWidth - window.innerWidth;
        if (sideways > 0) found.push(`the page scrolls sideways by ${sideways}px`);
        const box: DOMRect = root.getBoundingClientRect();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text: string = node.textContent?.trim() ?? "";
          const element: HTMLElement | null = node.parentElement;
          if (!text || !element?.checkVisibility()) continue;
          // Text for a screen reader only: in a box of 1 pixel, such as the header row of the stacked table.
          let hidden = false;
          for (let node: Element | null = element; node && node !== root; node = node.parentElement)
            if (node.getBoundingClientRect().width <= 1) hidden = true;
          if (hidden) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects())
            if (rect.width > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1))
              found.push(`"${text.slice(0, 40)}" is cut off`);
        }
        for (const scroller of root.querySelectorAll(".ov-rules"))
          if (scroller.scrollWidth > scroller.clientWidth) found.push("the rules scroll sideways");
        return found;
      });
    for (const layer of ["alerts", "goal"] as const) {
      await chip(editor, layer).click();
      await expect(panel).toHaveAttribute("data-comp-props", layer);
      if (layer === "alerts") await panel.locator("[data-alert-help] summary").click();
      expect(await problems(), `${locale} ${layer}`).toEqual([]);
      // Each control is inside the screen. Buttons, lists, fields, and the labels of the switches are 44 px high.
      for (const control of await panel.locator("button:visible, input:visible, [role=combobox]:visible").all()) {
        const rect = await control.boundingBox();
        expect(rect && rect.x >= 0 && rect.x + rect.width <= 390, `${locale} ${layer} control`).toBe(true);
      }
      const targets = panel.locator(
        'button:visible, [role=combobox]:visible, input[type="text"]:visible, label.ov-rule-switch',
      );
      for (const target of await targets.all())
        expect((await target.boundingBox())?.height ?? 0, `${locale} ${layer} target`).toBeGreaterThanOrEqual(44);
      await shot(page, `390-${locale}-h-${layer}`);
    }
    // The rules stack on a phone: the column names show in each row, and the header row is only for a screen reader.
    const table = panel.locator("table");
    await chip(editor, "alerts").click();
    await expect(table.locator(".ov-rules-stack").first()).toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveCount(5);
    // The vertical output keeps its own layout, and its settings fit too.
    const save = saved(page);
    await editor.locator('[data-comp-orientation="vertical"]').click();
    await save;
    await chip(editor, "alerts").click();
    expect(await problems(), `${locale} vertical alerts`).toEqual([]);
    await shot(page, `390-${locale}-v-alerts`);
    await close(owner);
  });

test("on a wide screen the settings of the two layers are beside the grid of the vertical output", async ({
  browser,
}) => {
  await runSql("alerts-editor-vertical", [
    layersSql({
      orientation: "vertical",
      alerts: { enabled: true },
      goal: { enabled: true, title: "New subscribers" },
      cells: { vertical: { alerts: { c: 0, r: 0, w: 18, h: 3 }, goal: { c: 0, r: 3, w: 18, h: 2 } } },
    }),
  ]);
  const { owner, page, editor, frame } = await openEditor(browser, PHONE_IP);
  const panel = settings(editor);
  for (const layer of ["alerts", "goal"] as const) {
    await chip(editor, layer).click();
    await expect(panel).toHaveAttribute("data-comp-props", layer);
    const grid = await frame.boundingBox();
    const side = await panel.boundingBox();
    if (!grid || !side) throw new Error("No box.");
    expect(grid.x + grid.width).toBeLessThanOrEqual(side.x);
    // The rules keep their columns beside the grid.
    if (layer === "alerts") await expect(panel.locator(".ov-rules-stack").first()).toBeHidden();
    await shot(page, `1440-v-${layer}`);
  }
  await close(owner);
});
