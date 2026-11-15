import { newPage, close } from "./coverage";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext, type Page } from "./coverage";
import { z } from "zod";
import { clientAddress } from "./client-ips";
import { accounts, runSql } from "./fixtures";
import type { Me } from "../../app/components/account/me";

const origin: string = "http://localhost:5173";
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));
const meSchema = z.object({
  viewer: z.object({ avatar: z.string().nullable(), avatarPreset: z.number().nullable(), name: z.string() }),
  streamer: z.object({ logo: z.string().nullable(), handle: z.string() }).nullable(),
});

async function signedIn(
  browser: Browser,
  role: string,
  width: number = 1280,
  touch: boolean = false,
  ip: string = clientAddress("profile", 130),
): Promise<BrowserContext> {
  const sessions = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
  const session = sessions[role];
  if (!session) throw new Error("Unknown test account.");
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width, height: 900 },
    hasTouch: touch,
    extraHTTPHeaders: { "CF-Connecting-IP": ip },
  });
  await context.addCookies([
    { name: "stream-bullets.session_token", value: session.cookie, domain: "localhost", path: "/", httpOnly: true },
  ]);
  return context;
}

const PRESETS: readonly string[] = [
  "Space explorer (default)",
  "Dark hair & beard",
  "Natural curls",
  "Classic bob",
  "Dark hair & glasses",
  "Silver pixie",
  "Close crop & beard",
  "Short curls",
  "Teal headscarf",
  "Silver side part",
  "Red hair & freckles",
  "Waves & glasses",
  "Plum undercut",
  "Friendly robot",
  "Bookish cat",
  "Jack Russell terrier",
  "Friendly alien",
  "Night owl",
];

test("Your profile: preset order, a cropped upload, then a preset again", async ({ browser }) => {
  test.slow();
  const context = await signedIn(browser, "reporter");
  const page = await newPage(context);
  await page.goto("/streamers");
  await page.getByRole("button", { name: "Account menu for reporter" }).click();
  await page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Your profile" }).click();
  const dialog = page.getByRole("dialog", { name: "Your profile" });
  await expect(dialog).toBeVisible();

  // 18 presets, default Space explorer first; three rows of six; no initial option.
  const picker = dialog.getByRole("group", { name: "Choose a picture" });
  await expect(picker.getByRole("radio")).toHaveCount(18);
  const labels = await picker.getByRole("radio").evaluateAll((inputs) => inputs.map((input) => input.ariaLabel));
  expect(labels).toEqual(PRESETS);
  await expect(picker.getByRole("radio", { name: "Space explorer (default)" })).toBeChecked();
  await expect(dialog.getByText(/initial/i)).toHaveCount(0);
  await expect(page.locator(".avatar-grid")).toHaveCSS("grid-template-columns", /^(\S+ ){5}\S+$/);

  await dialog.getByLabel("Display name").fill("Reporter Two");
  await expect(dialog.locator(".preview-name")).toHaveText("Reporter Two");
  await expect(dialog.getByText("Save or discard your profile changes before changing login methods.")).toBeVisible();
  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", { name: "Discard changes?" });
  await expect(discard).toContainText("Display name");
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await expect(discard).toHaveCount(0);
  await dialog.getByLabel("Display name").fill("reporter");

  await dialog.getByLabel("Or upload your own").setInputFiles("public/apple-touch-icon.png");
  const crop = page.getByRole("dialog", { name: "Adjust your picture" });
  await expect(crop.getByRole("button", { name: "Picture position" })).toBeVisible();
  const zoom = crop.getByRole("slider", { name: "Zoom" });
  await expect(zoom).toHaveValue("1");
  await crop.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoom).toHaveValue("1.25");
  await crop.getByRole("button", { name: "Picture position" }).press("ArrowLeft");
  await crop.getByRole("button", { name: "Use this picture" }).click();
  await expect(dialog.getByRole("radio").first()).toHaveAccessibleName("Your photo");
  await expect(dialog.getByRole("radio", { name: "Your photo" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Your photo" })).toBeFocused();
  await expect(dialog.locator(".avatar-preview img")).toHaveAttribute("src", /^blob:/);
  await dialog.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();

  const saved = meSchema.parse(await (await context.request.get("/api/me")).json());
  expect(saved.viewer.avatar).toMatch(/^\/images\/avatar\//);
  const image = await context.request.get(saved.viewer.avatar ?? "");
  expect(image.headers()["content-type"]).toBe("image/jpeg");
  // Upload the circular crop as a 512 x 512 square.
  const bytes = await image.body();
  const sof = bytes.findIndex((byte, index) => byte === 0xff && bytes[index + 1] === 0xc0);
  expect(sof).toBeGreaterThan(0);
  expect([bytes.readUInt16BE(sof + 5), bytes.readUInt16BE(sof + 7)]).toEqual([512, 512]);
  await expect(page.getByRole("button", { name: "Account menu for reporter" }).locator("img")).toHaveAttribute(
    "src",
    /^\/images\/avatar\//,
  );

  await page.goto("/streamers?dialog=profile");
  await expect(dialog.getByRole("radio", { name: "Your photo" })).toBeChecked();
  await dialog.locator('label[data-avatar="17"]').click();
  await expect(dialog.getByRole("radio", { name: "Friendly alien" })).toBeChecked();
  await dialog.getByRole("button", { name: "Save profile" }).click();
  await expect(dialog).toBeHidden();
  const after = meSchema.parse(await (await context.request.get("/api/me")).json());
  expect(after.viewer).toMatchObject({ avatar: null, avatarPreset: 17 });

  // Use the preset in topic bylines, composer, and comments.
  const entryId = randomUUID();
  await runSql("profile-topic", [
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,created_at) SELECT '${entryId}',id,'${(await accounts()).reporter.id}','topic','Preset pictures','Do they show?','Just chatting',${Date.now()} FROM streamers WHERE handle='other_host';`,
  ]);
  await page.goto(`/@other_host?entry=${entryId}`);
  await expect(page.locator(".author .user-avatar")).toHaveAttribute("data-preset", "17");
  const composer = page.locator("form.composer").first();
  await expect(composer.locator(".user-avatar")).toHaveAttribute("data-preset", "17");
  await composer.locator("textarea[data-composer]").fill("Shown with my preset.");
  await composer.getByRole("button", { name: "Post", exact: true }).click();
  const posted = page.locator("article.comment").filter({ hasText: "Shown with my preset." });
  await expect(posted.locator(".user-avatar")).toHaveAttribute("data-preset", "17");
  await close(context);
});

// New account UI cases reserve 203.0.113.120–139; each case uses a distinct address.
test("profile validation keeps drafts through failed saves and rejects invalid images", async ({ browser }) => {
  const context = await signedIn(browser, "reporter", 1280, false, "203.0.113.120");
  try {
    const page = await newPage(context);
    await page.goto("/streamers?dialog=profile");
    const dialog = page.getByRole("dialog", { name: "Your profile" });
    const name = dialog.getByLabel("Display name");
    await name.fill("   ");
    await expect(dialog.locator(".preview-name")).toHaveText("…");
    await dialog.getByRole("button", { name: "Save profile" }).click();
    await expect(dialog.getByRole("alert").first()).toHaveText("Enter a display name.");

    const upload = dialog.getByLabel("Or upload your own");
    await upload.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
    await expect(dialog.getByRole("alert").first()).toHaveText("Choose a JPG, PNG, or WebP image no larger than 5 MB.");
    await upload.setInputFiles({ name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
    await expect(dialog.getByRole("alert").first()).toHaveText("Choose a JPG, PNG, or WebP image no larger than 5 MB.");
    await upload.setInputFiles([]);
    await expect(dialog).toBeVisible();
    await upload.setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("broken PNG") });
    const crop = page.getByRole("dialog", { name: "Adjust your picture" });
    await expect(crop.getByRole("alert")).toHaveText("That image could not be read. Choose a JPG, PNG, or WebP image.");
    await crop.getByRole("button", { name: "Picture position" }).press("ArrowDown");
    await crop.getByRole("button", { name: "Use this picture" }).click();
    await expect(crop.getByRole("alert")).toHaveText("The picture is still loading. Try again in a moment.");
    await crop.getByRole("button", { name: "Back", exact: true }).click();
    await expect(name).toHaveValue("   ");

    const patches: unknown[] = [];
    await page.route("**/api/profile", async (route) => {
      patches.push(route.request().postDataJSON() as unknown);
      await route.fulfill(
        patches.length === 1
          ? { status: 503, json: { error: "Profile temporarily unavailable." } }
          : { json: { saved: true } },
      );
    });
    await name.fill("  Reporter retry  ");
    await dialog.getByRole("button", { name: "Save profile" }).click();
    await expect(dialog.getByRole("alert").first()).toHaveText("Profile temporarily unavailable.");
    await expect(name).toHaveValue("  Reporter retry  ");
    await expect(dialog.getByRole("button", { name: "Save profile" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Save profile" }).click();
    await expect(dialog).toBeHidden();
    expect(patches).toEqual([{ name: "Reporter retry" }, { name: "Reporter retry" }]);
    await page.goto("/streamers?dialog=profile");
    await expect(name).toHaveValue("reporter");
    await dialog.getByRole("button", { name: "Save profile" }).click();
    await expect(dialog).toBeHidden();
    expect(patches).toHaveLength(2);
  } finally {
    await close(context);
  }
});

test("cropping supports keyboard, fine position, wheel, drag, reset and recropping a draft", async ({ browser }) => {
  test.slow();
  const context = await signedIn(browser, "reporter", 1280, false, "203.0.113.121");
  try {
    const page = await newPage(context);
    await page.goto("/streamers?dialog=profile");
    const dialog = page.getByRole("dialog", { name: "Your profile" });
    await dialog.getByLabel("Or upload your own").setInputFiles("public/apple-touch-icon.png");
    const crop = page.getByRole("dialog", { name: "Adjust your picture" });
    const stage = crop.getByRole("button", { name: "Picture position" });
    const image = stage.locator("img");
    const zoom = crop.getByRole("slider", { name: "Zoom" });
    await expect(image).toHaveJSProperty("naturalWidth", 180);
    await zoom.click();
    await expect(zoom).toHaveValue("2.5");
    const centered = await image.getAttribute("style");
    await stage.press("Shift+ArrowRight");
    await expect(image).not.toHaveAttribute("style", centered ?? "");
    await stage.press("ArrowUp");
    await stage.press("ArrowDown");
    await stage.press("ArrowLeft");
    await crop.getByRole("button", { name: "Reset position", exact: true }).click();
    await expect(image).toHaveAttribute("style", centered ?? "");
    for (const direction of ["up", "left", "right", "down"] as const) {
      await crop.getByRole("button", { name: `Move picture ${direction}`, exact: true }).click();
    }
    await expect(image).toHaveAttribute("style", centered ?? "");
    await stage.press("+");
    await expect(zoom).toHaveValue("2.6");
    await stage.press("=");
    await expect(zoom).toHaveValue("2.7");
    await stage.press("-");
    await expect(zoom).toHaveValue("2.6");
    await stage.press("_");
    await expect(zoom).toHaveValue("2.5");
    await stage.press("a");
    await expect(zoom).toHaveValue("2.5");
    await crop.getByRole("button", { name: "Zoom out" }).click();
    await expect(zoom).toHaveValue("2.25");
    await stage.hover();
    await page.mouse.wheel(0, -200);
    await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(2.25);
    await zoom.click();
    const bounds = await stage.boundingBox();
    if (!bounds) throw new Error("Crop stage has no bounds.");
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 30, bounds.y + bounds.height / 2 + 20, { steps: 3 });
    await page.mouse.up();
    await expect(image).not.toHaveAttribute("style", centered ?? "");
    await crop.getByText("Fine-tune position", { exact: true }).click();
    await expect(crop.getByRole("button", { name: "Move picture up" })).toBeHidden();
    await crop.getByText("Fine-tune position", { exact: true }).click();
    await crop.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(zoom).toHaveValue("1");
    await crop.getByRole("button", { name: "Use this picture" }).click();
    await dialog.getByRole("button", { name: "Adjust your photo" }).click();
    await expect(zoom).toHaveValue("1");
    await crop.getByRole("button", { name: "Back", exact: true }).click();
    await expect(dialog.getByRole("radio", { name: "Your photo" })).toBeChecked();
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await page
      .getByRole("alertdialog", { name: "Discard changes?" })
      .getByRole("button", { name: "Discard", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await page.goto("/streamers?dialog=profile");
    await expect(dialog.getByRole("radio", { name: "Your photo" })).toHaveCount(0);
  } finally {
    await close(context);
  }
});

test("touch cropping opens fine positioning on demand and pinches without saving", async ({ browser }) => {
  const context = await signedIn(browser, "reporter", 390, true, "203.0.113.122");
  try {
    const page: Page = await newPage(context);
    await page.goto("/streamers?dialog=profile");
    await page.getByLabel("Or upload your own").setInputFiles("public/apple-touch-icon.png");
    const crop = page.getByRole("dialog", { name: "Adjust your picture" });
    await expect(crop.getByRole("button", { name: "Move picture up" })).toBeHidden();
    await crop.getByText("Fine-tune position", { exact: true }).click();
    await expect(crop.getByRole("button", { name: "Move picture up" })).toBeVisible();
    const stage = crop.getByRole("button", { name: "Picture position" });
    await stage.scrollIntoViewIfNeeded();
    await expect(stage.locator("img")).toHaveJSProperty("naturalWidth", 180);
    const bounds = await stage.boundingBox();
    if (!bounds) throw new Error("Crop stage has no bounds.");
    const cdp = await context.newCDPSession(page);
    const x: number = bounds.x + bounds.width / 2;
    const y: number = bounds.y + bounds.height / 2;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: x - 20, y, id: 1 },
        { x: x + 20, y, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: x - 30, y, id: 1 },
        { x: x + 30, y, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: x - 50, y, id: 1 },
        { x: x + 50, y, id: 2 },
      ],
    });
    await expect
      .poll(async () => Number(await crop.getByRole("slider", { name: "Zoom" }).inputValue()))
      .toBeGreaterThan(1);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await cdp.detach();
    await crop.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await close(context);
  }
});

test("Edit your page: handle warning, a cropped logo, then the profile picture again", async ({ browser }) => {
  test.slow();
  const context = await signedIn(browser, "otherowner", 390);
  const page = await newPage(context);
  await page.goto("/@other_host");
  await page.getByRole("button", { name: "Account menu for otherowner" }).click();
  await page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Edit your page" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit your page" });
  await expect(dialog.getByLabel("Page name")).toHaveValue("Other host");
  await expect(dialog.getByRole("radio", { name: "Use my profile picture" })).toBeChecked();
  await expect(dialog.getByLabel("Logo image")).toHaveCount(0);

  await dialog.getByLabel("Handle").fill("other_host_2");
  await expect(dialog.getByRole("status")).toContainText("Your page and overlay URLs will change.");
  await dialog.getByLabel("Handle").fill("other_host");
  await expect(dialog.locator("#handle-warn")).toBeEmpty();

  await dialog.getByRole("radio", { name: "Upload a logo" }).check();
  await dialog.getByLabel("Logo image").setInputFiles("public/apple-touch-icon.png");
  const crop = page.getByRole("dialog", { name: "Adjust your logo" });
  await expect(crop.getByText("Page header")).toBeVisible();
  await crop.getByRole("button", { name: "Use this picture" }).click();
  await expect(dialog.getByRole("button", { name: "Adjust the logo" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  const discard = page.getByRole("alertdialog", { name: "Discard changes?" });
  await expect(discard).toContainText("Page logo");
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await dialog.getByRole("button", { name: "Save page" }).click();
  await expect(page.getByText("Streamer page saved.").first()).toBeVisible();
  const saved = meSchema.parse(await (await context.request.get("/api/me")).json());
  expect(saved.streamer?.logo).toMatch(/^\/images\/logo\//);
  await expect(page.locator(".streamer-home .brand-avatar")).toHaveAttribute("src", /^\/images\/logo\//);

  await page.goto("/@other_host?dialog=page");
  await dialog.getByRole("radio", { name: "Use my profile picture" }).check();
  await dialog.getByRole("button", { name: "Save page" }).click();
  await expect(dialog).toBeHidden();
  const reverted = meSchema.parse(await (await context.request.get("/api/me")).json());
  expect(reverted.streamer?.logo).toBeNull();
  await expect(page.locator(".streamer-home .brand-avatar")).toHaveAttribute("data-preset", "14");

  // A handle change must update the URL and shell links immediately.
  const restore =
    "UPDATE streamers SET handle='other_host', handle_changed_at=NULL WHERE handle IN ('other_host','other_host_2');";
  await runSql("rename-reset", [restore]);
  try {
    await page.goto("/@other_host?dialog=page");
    await dialog.getByLabel("Handle").fill("other_host_2");
    await dialog.getByRole("button", { name: "Save page" }).click();
    await expect(page).toHaveURL(/\/@other_host_2(\?|$)/);
    await page.getByRole("button", { name: "Account menu for otherowner" }).click();
    const yourPage = page
      .getByRole("navigation", { name: "Account" })
      .getByRole("link", { name: "Your page", exact: true });
    await expect(yourPage).toHaveAttribute("href", "/@other_host_2");
  } finally {
    await runSql("rename-reset", [restore]);
  }
  await close(context);
});

test("page drafts validate uploads and support links, recover from failed saves, and keep a locked handle", async ({
  browser,
}) => {
  test.slow();
  const context = await signedIn(browser, "otherowner", 1280, false, "203.0.113.123");
  try {
    const page = await newPage(context);
    const saved = (await (await context.request.get("/api/me")).json()) as Me;
    if (!saved.streamer) throw new Error("Page owner has no page.");
    const streamer = { ...saved.streamer, handleChangedAt: Date.now(), logo: null };
    await page.route("**/api/me", (route) =>
      route.fulfill({
        json: { ...saved, streamer, support: { links: [], visible: true, card: false } },
      }),
    );
    const imageUploads: string[] = [];
    await page.route("**/api/images/*", async (route) => {
      imageUploads.push(new URL(route.request().url()).pathname);
      expect(route.request().method()).toBe("PUT");
      expect(route.request().postDataBuffer()?.length).toBeGreaterThan(0);
      await route.fulfill({ json: { url: "/apple-touch-icon.png" } });
    });
    const patches: unknown[] = [];
    await page.route("**/api/streamer", async (route) => {
      patches.push(route.request().postDataJSON() as unknown);
      await route.fulfill(
        patches.length === 1
          ? { status: 503, json: { error: "Page temporarily unavailable." } }
          : { json: { streamer: { ...streamer, name: "Draft community", about: "Draft description" } } },
      );
    });
    const supportUpdates: unknown[] = [];
    await page.route("**/api/support-links", async (route) => {
      supportUpdates.push(route.request().postDataJSON() as unknown);
      await route.fulfill({ json: { links: [], visible: true, card: false } });
    });
    await page.goto("/streamers?dialog=page");
    const dialog = page.getByRole("dialog", { name: "Edit your page" });
    await expect(dialog.getByLabel("Handle")).toHaveAttribute("readonly", "");
    await expect(dialog.locator("#page-handle-help")).toContainText("You changed your handle recently.");
    await dialog.getByRole("radio", { name: "Upload a logo" }).check();
    await dialog.getByRole("button", { name: "Save page" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Upload a logo, or choose Use my profile picture.");
    await dialog
      .getByLabel("Background image")
      .setInputFiles({ name: "background.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
    await expect(dialog.getByRole("alert")).toHaveText("Choose a JPG, PNG, or WebP image no larger than 5 MB.");
    await dialog.getByLabel("Logo image").setInputFiles("public/apple-touch-icon.png");
    const crop = page.getByRole("dialog", { name: "Adjust your logo" });
    await expect(crop.locator(".crop-img")).toHaveJSProperty("naturalWidth", 180);
    await crop.getByRole("button", { name: "Back", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Adjust the logo" })).toHaveCount(0);
    await dialog.getByLabel("Logo image").setInputFiles("public/apple-touch-icon.png");
    await crop.getByRole("button", { name: "Use this picture" }).click();
    await dialog.getByRole("button", { name: "Adjust the logo" }).click();
    await expect(crop.getByRole("slider", { name: "Zoom" })).toHaveValue("1");
    await crop.getByRole("button", { name: "Back", exact: true }).click();
    await dialog.getByLabel("Background image").setInputFiles("public/apple-touch-icon.png");
    await expect(dialog.getByRole("img", { name: "Your page background" })).toHaveAttribute("src", /^blob:/);
    await dialog.getByLabel("Page name").fill("  Draft community  ");
    await dialog.getByLabel("About your stream").fill("  Draft description  ");
    await dialog.getByRole("button", { name: "Add support link" }).click();
    await dialog.getByLabel("Link 1", { exact: true }).fill("https://example.test/wrong-provider");
    await dialog.getByRole("button", { name: "Save page" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Link 1: use an https link on Ko-fi's own domain.");
    expect(imageUploads).toHaveLength(0);
    await dialog.getByRole("combobox", { name: /Provider for link 1/ }).click();
    await page.getByRole("option", { name: "Other", exact: true }).click();
    await dialog.getByLabel("Button label").fill("   ");
    await dialog.getByLabel("Link 1", { exact: true }).fill("http://example.test/support");
    await dialog.getByRole("button", { name: "Save page" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Link 1: use an https link to a page on the site.");
    await dialog.getByLabel("Link 1", { exact: true }).fill("https://example.test/support");
    await dialog.getByRole("button", { name: "Save page" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Link 1: add a button label.");
    await dialog.getByLabel("Button label").fill("Draft support");
    await dialog.getByRole("combobox", { name: /Provider for link 1/ }).click();
    await page.getByRole("option", { name: "Ko-fi", exact: true }).click();
    await dialog.getByLabel("Link 1", { exact: true }).fill("https://ko-fi.com/draft_community");
    for (let index: number = 2; index <= 4; index++) {
      await dialog.getByRole("button", { name: "Add support link" }).click();
      await dialog.getByLabel(`Link ${index}`, { exact: true }).fill(`https://ko-fi.com/draft_${index}`);
    }
    await expect(dialog.getByText("You can add up to 4 links.", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Move link 1 down" }).click();
    await expect(dialog.getByLabel("Link 1", { exact: true })).toHaveValue("https://ko-fi.com/draft_2");
    await dialog.getByRole("button", { name: "Move link 2 up" }).click();
    await expect(dialog.getByLabel("Link 1", { exact: true })).toHaveValue("https://ko-fi.com/draft_community");
    for (const index of [4, 3, 2])
      await dialog.getByRole("button", { name: `Remove link ${index}`, exact: true }).click();
    await dialog.getByRole("checkbox", { name: "Also add a Support card to Community" }).check();
    await dialog.getByRole("checkbox", { name: "Show on About page" }).uncheck();
    await expect(dialog.getByRole("checkbox", { name: "Also add a Support card to Community" })).toBeDisabled();
    await expect(dialog.getByRole("checkbox", { name: "Also add a Support card to Community" })).not.toBeChecked();
    await dialog.getByRole("checkbox", { name: "Show on About page" }).check();
    await dialog.getByRole("button", { name: "Save page" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Page temporarily unavailable.");
    await expect(dialog.getByLabel("Page name")).toHaveValue("  Draft community  ");
    await dialog.getByRole("button", { name: "Save page" }).click();
    await expect(dialog).toBeHidden();
    expect(patches).toEqual([
      { name: "Draft community", about: "Draft description", logoMode: "logo" },
      { name: "Draft community", about: "Draft description", logoMode: "logo" },
    ]);
    expect(imageUploads).toEqual([
      "/api/images/logo",
      "/api/images/background",
      "/api/images/logo",
      "/api/images/background",
    ]);
    expect(supportUpdates).toEqual([
      {
        links: [{ kind: "kofi", label: null, url: "https://ko-fi.com/draft_community" }],
        visible: true,
        card: false,
      },
    ]);
  } finally {
    await close(context);
  }
});
