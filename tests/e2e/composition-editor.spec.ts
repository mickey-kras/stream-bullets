import { newPage, close, test, expect, type Page } from "./coverage";
import { runSql } from "./fixtures";
import { signedIn } from "./live-helpers";
import { clientIp } from "./client-ips";

const OWNER_IP = clientIp("composition-editor", 245);
// Set COMPOSITION_SHOT to a file path to save a 1440x900 screenshot of the editor.
const shot: string | undefined = process.env.COMPOSITION_SHOT;

const resetLayers = `UPDATE overlay_state SET layers='{}', revision=revision+1 WHERE streamer_id=(SELECT id FROM streamers WHERE handle='feature_host');`;

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
  await page.mouse.move(from.x - 60, from.y + 20, { steps: 6 });
  await page.mouse.move(from.x - 120, from.y + 40, { steps: 6 });
  await page.mouse.up();
  await save;
  const moved = { x: start.x + Math.round(-120 / scale), y: start.y + Math.round(40 / scale) };
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
  for (const layer of ["chat", "content", "characters"])
    await expect(page.locator(`[data-ov-layer-url="${layer}"]`)).toHaveValue(`${url}&layer=${layer}`);
  await expect(page.locator("[data-ov-layer-urls]")).toContainText("Coming soon");
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
  await runSql("composition-editor-shot", [
    `UPDATE overlay_state SET layers='{"chat":{"enabled":true}}', revision=revision+1 WHERE streamer_id=(SELECT id FROM streamers WHERE handle='feature_host');`,
  ]);
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const page = await newPage(owner);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/overlay-control");
  const editor = page.getByRole("region", { name: "Composition", exact: true });
  await editor.getByRole("button", { name: "Sample game" }).click();
  await editor.scrollIntoViewIfNeeded();
  await expect(editor.locator(".wl-chat li").first()).toBeVisible();
  await page.waitForTimeout(1500);
  await editor
    .getByRole("region", { name: "Composition preview" })
    .evaluate((element: Element) => element.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: shot });
  await close(owner);
});
