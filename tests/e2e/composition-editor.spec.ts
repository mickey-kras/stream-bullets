import { newPage, close, test, expect, type Page } from "./coverage";
import { runSql } from "./fixtures";
import { signedIn } from "./live-helpers";
import { clientIp } from "./client-ips";
import { DEFAULT_LAYERS } from "../../app/lib/overlay-layers";
import { SAMPLE_INTERVAL_MS } from "../../app/components/overlay/use-chat";

const OWNER_IP = clientIp("composition-editor", 245);
const MOTION_IP = clientIp("composition-editor", 246);
const OVERLAP_IP = clientIp("composition-editor", 247);
const LEAVE_IP = clientIp("composition-editor", 248);
const NAV_IP = clientIp("composition-editor", 249);
// Set COMPOSITION_SHOT to a file path to save a 1440x900 screenshot of the editor.
const shot: string | undefined = process.env.COMPOSITION_SHOT;

const FEATURE_HOST = "(SELECT id FROM streamers WHERE handle='feature_host')";
const resetLayers = `UPDATE overlay_state SET layers='{}', revision=revision+1 WHERE streamer_id=${FEATURE_HOST};`;
const chatOn = `UPDATE overlay_state SET layers='{"chat":{"enabled":true}}', revision=revision+1 WHERE streamer_id=${FEATURE_HOST};`;
// The seeded on-air content: the Mash Battle poll. It fills the top half of the stage (about y 48 to 550).
const seededAir = `UPDATE overlay_state SET air=json_object('type','poll','ref',(SELECT id FROM entries WHERE streamer_id=${FEATURE_HOST} AND title='Which boss first?')), revision=revision+1 WHERE streamer_id=${FEATURE_HOST};`;
const OVERLAP_NOTE = "Chat covers part of the on-air content. Move it to a free area.";

test.beforeEach(async () => {
  await runSql("composition-editor-reset", [resetLayers]);
});

test.afterAll(async () => {
  await runSql("composition-editor-cleanup", [resetLayers]);
});

function saved(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/overlay" && response.ok(),
  );
}

async function value(page: Page, layer: string, label: string): Promise<number> {
  return Number(await page.locator(`[data-comp-fields="${layer}"]`).getByLabel(label, { exact: true }).inputValue());
}

test("the owner places the chat layer by mouse and keyboard, and the layout persists", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  await expect(editor).toBeVisible();
  const frame = editor.getByRole("region", { name: "Composition preview" });
  await expect(frame).toHaveAttribute("data-scaled", "true");
  await expect(frame.locator('[data-comp-placeholder="characters"]')).toContainText("Characters");
  // Characters wait for the playground; chat is off by default.
  const chatLayer = editor.locator('[data-comp-layer="chat"]');
  await expect(editor.locator('[data-comp-layer="characters"]').getByRole("checkbox")).toBeDisabled();
  await expect(chatLayer.getByRole("checkbox", { name: "Show on stream" })).not.toBeChecked();
  await expect(frame.locator('[data-comp-box="chat"]')).toHaveCount(0);

  let save = saved(page);
  await chatLayer.getByRole("checkbox", { name: "Show on stream" }).check();
  await save;
  const box = frame.locator('[data-comp-box="chat"]');
  await expect(box).toBeVisible();
  // The preview plays sample chat without an activity socket.
  await expect(frame.locator('.ov-layer[data-layer="chat"] .wl-chat')).toBeVisible();

  // Keep the whole preview clear of the sticky header and footer.
  await frame.evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  // The scaler measures the frame's inner width.
  const scale: number = await frame.evaluate((element: Element) => element.clientWidth / 1920);
  const start = { x: await value(page, "chat", "X"), y: await value(page, "chat", "Y") };
  const size = { w: await value(page, "chat", "Width"), h: await value(page, "chat", "Height") };

  // Drag to move: screen pixels convert to design pixels by the preview scale.
  const area = await box.boundingBox();
  if (!area) throw new Error("No chat box.");
  const from = { x: Math.round(area.x + area.width / 2), y: Math.round(area.y + area.height / 2) };
  save = saved(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // The default box starts 73 design pixels below the top edge: a short move up stays in the frame.
  await page.mouse.move(from.x - 60, from.y - 10, { steps: 6 });
  await page.mouse.move(from.x - 120, from.y - 20, { steps: 6 });
  await page.mouse.up();
  await save;
  const moved = { x: start.x + Math.round(-120 / scale), y: start.y + Math.round(-20 / scale) };
  expect(await value(page, "chat", "X")).toBe(moved.x);
  expect(await value(page, "chat", "Y")).toBe(moved.y);

  // Drag the corner to resize.
  const handle = frame.locator('[data-comp-resize="chat"]');
  const corner = await handle.boundingBox();
  if (!corner) throw new Error("No resize handle.");
  const grip = { x: Math.round(corner.x + corner.width / 2), y: Math.round(corner.y + corner.height / 2) };
  save = saved(page);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x + 30, grip.y - 40, { steps: 8 });
  await page.mouse.up();
  await save;
  const resized = { w: size.w + Math.round(30 / scale), h: size.h + Math.round(-40 / scale) };
  expect(await value(page, "chat", "Width")).toBe(resized.w);
  expect(await value(page, "chat", "Height")).toBe(resized.h);

  // Arrow keys nudge the focused layer: 1 px, Shift 10 px. One save after a short pause.
  save = saved(page);
  await box.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Shift+ArrowUp");
  await save;
  const nudged = { x: moved.x - 2, y: moved.y - 10 };
  expect(await value(page, "chat", "X")).toBe(nudged.x);
  expect(await value(page, "chat", "Y")).toBe(nudged.y);
  await expect(box).toHaveAccessibleName(`Chat: x ${nudged.x}, y ${nudged.y}, ${resized.w} × ${resized.h}`);

  // A layer never leaves the frame.
  save = saved(page);
  const width = page.locator('[data-comp-fields="chat"]').getByLabel("Width", { exact: true });
  await width.fill("5000");
  await width.press("Enter");
  await save;
  expect(await value(page, "chat", "Width")).toBe(1920);
  expect(await value(page, "chat", "X")).toBe(0);
  save = saved(page);
  await width.fill(String(resized.w));
  await width.press("Enter");
  await save;

  save = saved(page);
  await chatLayer.getByRole("checkbox", { name: "Hide chat commands (!jump)" }).uncheck();
  await save;
  await expect(editor.getByRole("status")).toHaveText("Layout saved.");

  await page.reload();
  await expect(chatLayer.getByRole("checkbox", { name: "Show on stream" })).toBeChecked();
  await expect(chatLayer.getByRole("checkbox", { name: "Hide chat commands (!jump)" })).not.toBeChecked();
  expect(await value(page, "chat", "X")).toBe(0);
  expect(await value(page, "chat", "Y")).toBe(nudged.y);
  expect(await value(page, "chat", "Width")).toBe(resized.w);
  expect(await value(page, "chat", "Height")).toBe(resized.h);
  await close(owner);
});

test("a rejected layer save rolls back and shows an error", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  const show = editor.locator('[data-comp-layer="chat"]').getByRole("checkbox", { name: "Show on stream" });
  await expect(show).not.toBeChecked();
  await page.route("**/api/overlay", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 429,
          headers: { "Retry-After": "60" },
          json: { error: "Too many requests. Wait one minute and try again." },
        })
      : route.fallback(),
  );
  // The optimistic tick rolls back as soon as the save fails.
  await show.click();
  await expect(editor.getByRole("alert")).toContainText("Too many requests");
  await expect(show).not.toBeChecked();
  await expect(editor.locator('[data-comp-box="chat"]')).toHaveCount(0);
  await close(owner);
});

test("a save sends only the changed fields, and a failure rolls back only its own fields", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  const chatLayer = editor.locator('[data-comp-layer="chat"]');
  const show = chatLayer.getByRole("checkbox", { name: "Show on stream" });
  const hide = chatLayer.getByRole("checkbox", { name: "Hide chat commands (!jump)" });
  await expect(show).not.toBeChecked();
  await expect(hide).toBeChecked();
  // The chat source note links to the channel connections on the same page.
  const connect = chatLayer.getByRole("link", { name: "Connect channels" });
  await expect(connect).toHaveAttribute("href", "#channels-title");
  await expect(connect).toHaveClass("text-link");
  await expect(chatLayer.locator("[data-comp-chat-source]")).toHaveText(
    "Chat shows messages from the channels you connect. Connect channels",
  );
  const bodies: unknown[] = [];
  const gate: { release?: () => void; next?: () => void } = {};
  await page.route("**/api/overlay", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) {
      // Hold the first save, then fail it while a later edit waits.
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return route.fulfill({ status: 429, json: { error: "Too many requests. Wait one minute and try again." } });
    }
    // Hold the second save until the error was seen: its success clears the error.
    await new Promise<void>((resolve) => {
      gate.next = resolve;
    });
    return route.fallback();
  });
  await show.click();
  await expect.poll(() => bodies.length).toBe(1);
  await hide.click();
  await expect(show).toBeChecked();
  await expect(hide).not.toBeChecked();
  expect(gate.release).toBeDefined();
  gate.release?.();
  await expect(editor.getByRole("alert")).toContainText("Too many requests");
  // Only the failed field rolls back. The later edit is kept and saved on its own.
  await expect.poll(() => bodies.length).toBe(2);
  gate.next?.();
  expect(bodies).toEqual([
    { action: "layers", chat: { enabled: true } },
    { action: "layers", chat: { hideCommands: false } },
  ]);
  await expect(show).not.toBeChecked();
  await expect(hide).not.toBeChecked();
  await expect(editor.getByRole("status")).toHaveText("Layout saved.");
  await close(owner);
});

test("a new overlay link lists one URL per layer", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.goto("/overlay-control");
  await page.getByText("Setup", { exact: true }).click();
  await expect(page.locator("[data-ov-layer-urls]")).toHaveCount(0);
  await page.getByRole("button", { name: /^(Create overlay link|Regenerate link)$/ }).click();
  // An existing link asks for confirmation first.
  const confirm = page.getByRole("dialog", { name: "Regenerate the overlay link?" });
  await expect(confirm.or(page.locator("[data-ov-url]"))).toBeVisible();
  if (await confirm.isVisible()) await confirm.getByRole("button", { name: "Regenerate link" }).click();
  const url: string = await page.locator("[data-ov-url]").inputValue();
  expect(url).toMatch(/\/@feature_host\/overlay\?key=/);
  for (const layer of ["chat", "content"])
    await expect(page.locator(`[data-ov-layer-url="${layer}"]`)).toHaveValue(`${url}&layer=${layer}`);
  // The chat URL names the source size; the characters row only says it is coming.
  const { w, h } = DEFAULT_LAYERS.chat.rect;
  await expect(page.locator('[data-ov-layer-size="chat"]')).toHaveText(`Source size: ${w} × ${h}`);
  await expect(page.locator('[data-ov-layer-url="chat"]')).toHaveAccessibleDescription(`Source size: ${w} × ${h}`);
  await expect(page.locator('[data-ov-layer-url="characters"]')).toHaveCount(0);
  await expect(page.locator('[data-ov-layer-row="characters"]')).toContainText("Coming soon");
  await page.reload();
  await page.getByText("Setup", { exact: true }).click();
  await expect(page.locator(".ov-url")).toContainText("&layer=chat");
  await expect(page.locator("[data-ov-layer-url]")).toHaveCount(0);
  await close(owner);
  // Other specs start without an overlay key.
  await runSql("composition-editor-key", [
    `DELETE FROM overlay_keys WHERE streamer_id=(SELECT id FROM streamers WHERE handle='feature_host');`,
  ]);
});

test("the editor screenshot at 1440x900", async ({ browser }) => {
  test.skip(!shot, "Set COMPOSITION_SHOT to save the screenshot.");
  await runSql("composition-editor-shot", [seededAir, chatOn]);
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  await editor.getByRole("button", { name: "Sample game" }).click();
  await editor.scrollIntoViewIfNeeded();
  await expect(editor.locator(".wl-chat li").first()).toBeVisible();
  await expect(editor.locator("[data-comp-overlap]")).toHaveText(OVERLAP_NOTE);
  await page.waitForTimeout(1500);
  await editor
    .getByRole("region", { name: "Composition preview" })
    .evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: shot });
  await close(owner);
});

/** Lets the page run one real task: a MessageChannel message is not a timer, so the fake clock does not hold it. */
function realTask(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (): void => resolve();
        channel.port2.postMessage(null);
      }),
  );
}

for (const reduced of [true, false]) {
  test(`with${reduced ? "" : "out"} reduced motion the preview ${reduced ? "keeps a still set of" : "adds"} sample rows`, async ({
    browser,
  }) => {
    await runSql("composition-editor-motion", [chatOn]);
    const owner = await signedIn(browser, "featureowner", MOTION_IP);
    const page = await newPage(owner);
    await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
    await page.clock.install();
    await page.goto("/overlay-control");
    const frame = page.getByRole("region", { name: "Composition preview" });
    const rows = frame.locator('.ov-layer[data-layer="chat"] li.wl-item');
    await expect(rows.first()).toBeVisible();
    const count: number = await rows.count();
    expect(count).toBeGreaterThan(1);
    const texts: string[] = await rows.locator(".wl-msg").allTextContents();
    // A moving preview adds a sample row each SAMPLE_INTERVAL_MS. The still one keeps the same rows.
    await page.clock.runFor(SAMPLE_INTERVAL_MS * 3);
    // Let React commit what the timers dispatched before the checks.
    await realTask(page);
    if (reduced) {
      await expect(rows).toHaveCount(count);
      expect(await rows.locator(".wl-msg").allTextContents()).toEqual(texts);
      await expect(frame.locator('li[data-phase="entering"]')).toHaveCount(0);
    } else {
      // The positive control: the same steps without reduced motion add rows.
      await expect.poll(() => rows.count()).toBeGreaterThan(count);
    }
    await close(owner);
  });
}

test("a note shows while the chat covers the on-air content and goes when the chat moves away", async ({
  browser,
}) => {
  await runSql("composition-editor-overlap", [seededAir, chatOn]);
  const owner = await signedIn(browser, "featureowner", OVERLAP_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  const frame = editor.getByRole("region", { name: "Composition preview" });
  await expect(frame.locator(".ov-stage > *").first()).toBeVisible();
  // The default chat box (x 979 to 1805, y 73 to 1007) covers the right part of the poll.
  const note = editor.locator("[data-comp-overlap]");
  await expect(note).toHaveText(OVERLAP_NOTE);
  // The note does not speak on page load, only after a change.
  await expect(note).toHaveAttribute("aria-live", "off");

  // Below the poll is free: make the chat shorter, then move it down.
  const fields = editor.locator('[data-comp-fields="chat"]');
  let save = saved(page);
  await fields.getByLabel("Height", { exact: true }).fill("400");
  await fields.getByLabel("Height", { exact: true }).press("Enter");
  await save;
  save = saved(page);
  await fields.getByLabel("Y", { exact: true }).fill("620");
  await fields.getByLabel("Y", { exact: true }).press("Enter");
  await save;
  // The note stays mounted as a live region; it is empty when nothing is covered.
  await expect(note).toHaveText("");
  await expect(note).toHaveAttribute("aria-live", "polite");

  // Back over the poll, the note shows again. A hidden chat covers nothing.
  save = saved(page);
  await fields.getByLabel("Y", { exact: true }).fill("300");
  await fields.getByLabel("Y", { exact: true }).press("Enter");
  await save;
  await expect(note).toHaveText(OVERLAP_NOTE);
  save = saved(page);
  await editor.locator('[data-comp-layer="chat"]').getByRole("checkbox", { name: "Show on stream" }).uncheck();
  await save;
  await expect(note).toHaveText("");
  await close(owner);
});

test("the characters placeholder label stays fully visible beside the default chat box", async ({ browser }) => {
  await runSql("composition-editor-label", [chatOn]);
  const owner = await signedIn(browser, "featureowner", OVERLAP_IP);
  const cases: [string, string, number][] = [
    ["en", "Characters · Coming soon", 1440],
    ["de", "Figuren · Demnächst", 1440],
    ["ja", "キャラクター · 近日公開", 1440],
    ["en", "Characters · Coming soon", 390],
    ["de", "Figuren · Demnächst", 390],
    ["ja", "キャラクター · 近日公開", 390],
  ];
  for (const [locale, text, width] of cases) {
    await owner.addCookies([{ name: "sb_locale", value: locale, domain: "localhost", path: "/" }]);
    const page = await newPage(owner);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/overlay-control");
    const frame = page.locator(".ov-comp-frame");
    await expect(frame).toHaveAttribute("data-scaled", "true");
    const label = frame.locator('[data-comp-placeholder="characters"] span');
    await expect(label).toHaveText(text);
    const chatBox = await frame.locator('.ov-layer[data-layer="chat"]').boundingBox();
    const box = await label.boundingBox();
    if (!chatBox || !box) throw new Error("No chat box or label.");
    // The label is left of the chat box, and no part of it is cut off.
    expect(box.x + box.width, `${locale} ${width}`).toBeLessThanOrEqual(chatBox.x);
    expect(await label.evaluate((element: Element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await close(page);
  }
  await close(owner);
});

test("closing the editor sends an edit that waits for the idle save", async ({ browser }) => {
  await runSql("composition-editor-leave", [chatOn]);
  const owner = await signedIn(browser, "featureowner", LEAVE_IP);
  const page = await newPage(owner);
  await page.clock.install();
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  const x = editor.locator('[data-comp-fields="chat"]').getByLabel("X", { exact: true });
  await expect(x).toHaveValue(String(DEFAULT_LAYERS.chat.rect.x));
  await expect(editor.getByRole("region", { name: "Composition preview" })).toHaveAttribute("data-scaled", "true");
  // A typed value saves after a short idle time. Stop the clock, so only leaving the page can send it.
  await page.clock.pauseAt(Date.now() + 1000);
  await x.fill("1000");
  await page.goto("/settings");
  // The request left with the page, so read the saved layout from a new page load.
  await expect
    .poll(async () => {
      await page.goto("/overlay-control");
      return x.inputValue();
    })
    .toBe("1000");
  await close(owner);
});

/** The footer link to the privacy page: an in-app navigation, so the editor unmounts and the page stays. */
async function leaveInApp(page: Page): Promise<void> {
  await page.evaluate(() => document.documentElement.setAttribute("data-e2e-loaded", "1"));
  await page.locator('footer a[href="/privacy"]').first().click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.locator("html")).toHaveAttribute("data-e2e-loaded", "1");
}

/** Moves the chat layer 10 px left with the keyboard: a change that waits for the idle save. */
async function nudgeLeft(page: Page): Promise<void> {
  await page.locator('[data-comp-box="chat"]').focus();
  await page.keyboard.press("Shift+ArrowLeft");
}

async function storedX(page: Page): Promise<string> {
  await page.goto("/overlay-control");
  return page.locator('[data-comp-fields="chat"]').getByLabel("X", { exact: true }).inputValue();
}

test("leaving the editor by an in-app link sends the edit that waits for the idle save", async ({ browser }) => {
  await runSql("composition-editor-nav", [chatOn]);
  const owner = await signedIn(browser, "featureowner", NAV_IP);
  const page = await newPage(owner);
  await page.clock.install();
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  const x = editor.locator('[data-comp-fields="chat"]').getByLabel("X", { exact: true });
  await expect(x).toHaveValue(String(DEFAULT_LAYERS.chat.rect.x));
  await expect(editor.getByRole("region", { name: "Composition preview" })).toHaveAttribute("data-scaled", "true");
  // Stop the clock, so only closing the editor can send the typed value.
  await page.clock.pauseAt(Date.now() + 1000);
  const sent = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/overlay",
  );
  // Arrow keys save after an idle time. (A typed field value saves when the field loses focus, so it would not wait.)
  await nudgeLeft(page);
  await leaveInApp(page);
  expect((await sent).ok()).toBe(true);
  await expect.poll(() => storedX(page)).toBe(String(DEFAULT_LAYERS.chat.rect.x - 10));
  await close(owner);
});

test("leaving the editor during a save sends the newer edit after it, so the newer value is stored", async ({
  browser,
}) => {
  await runSql("composition-editor-race", [chatOn]);
  const owner = await signedIn(browser, "featureowner", NAV_IP);
  const page = await newPage(owner);
  await page.clock.install();
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  const x = editor.locator('[data-comp-fields="chat"]').getByLabel("X", { exact: true });
  await expect(x).toHaveValue(String(DEFAULT_LAYERS.chat.rect.x));
  await page.clock.pauseAt(Date.now() + 1000);
  const bodies: unknown[] = [];
  const gate: { release?: () => void } = {};
  await page.route("**/api/overlay", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postDataJSON());
    // Hold the first save until the editor is closed.
    if (bodies.length === 1)
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    return route.fallback();
  });
  await x.fill("900");
  await x.press("Enter");
  await expect.poll(() => bodies.length).toBe(1);
  await expect(x).toHaveValue("900");
  await nudgeLeft(page);
  await expect(x).toHaveValue("890");
  await leaveInApp(page);
  // The newer edit waits for the save in flight.
  expect(bodies).toHaveLength(1);
  gate.release?.();
  await expect.poll(() => bodies.length).toBe(2);
  const rect = { ...DEFAULT_LAYERS.chat.rect };
  expect(bodies).toEqual([
    { action: "layers", chat: { rect: { ...rect, x: 900 } } },
    { action: "layers", chat: { rect: { ...rect, x: 890 } } },
  ]);
  await page.unroute("**/api/overlay");
  await expect.poll(() => storedX(page)).toBe("890");
  await close(owner);
});

for (const stale of [false, true]) {
  test(`a failed edit sent while leaving ${stale ? "is not shown after 60 seconds" : "shows its error when the owner comes back"}`, async ({
    browser,
  }) => {
    await runSql("composition-editor-leave-error", [chatOn]);
    const owner = await signedIn(browser, "featureowner", NAV_IP);
    const page = await newPage(owner);
    await page.clock.install();
    await page.goto("/overlay-control");
    const editor = page.getByRole("region", { name: "Composition", exact: true });
    const x = editor.locator('[data-comp-fields="chat"]').getByLabel("X", { exact: true });
    await expect(x).toHaveValue(String(DEFAULT_LAYERS.chat.rect.x));
    await page.clock.pauseAt(Date.now() + 1000);
    await page.route("**/api/overlay", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 429, json: { error: "Too many requests. Wait one minute and try again." } })
        : route.fallback(),
    );
    const failed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/overlay");
    await nudgeLeft(page);
    await leaveInApp(page);
    expect((await failed).status()).toBe(429);
    // The error of a change sent while leaving is stale after 60 seconds.
    if (stale) await page.clock.fastForward(61_000);
    // Back in the app (no page load), the editor shows the error with its own prefix, unless it is stale.
    await page.goBack();
    await expect(page.locator("html")).toHaveAttribute("data-e2e-loaded", "1");
    const back = page.getByRole("region", { name: "Composition", exact: true });
    await expect(back.getByLabel("X", { exact: true }).first()).toBeVisible();
    if (stale) await expect(back.getByRole("alert")).toHaveCount(0);
    else
      await expect(back.getByRole("alert")).toHaveText(
        "Your last change while leaving was not saved: Too many requests. Wait one minute and try again.",
      );
    await close(owner);
  });
}
