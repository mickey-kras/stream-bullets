import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { z } from "zod";
import { clientAddress } from "./client-ips";

const origin: string = "http://localhost:5173";
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));
const meSchema = z.object({
  viewer: z.object({ avatar: z.string().nullable(), avatarPreset: z.number().nullable(), name: z.string() }),
  streamer: z.object({ logo: z.string().nullable(), handle: z.string() }).nullable(),
});

async function signedIn(browser: Browser, role: string, width = 1280): Promise<BrowserContext> {
  const sessions = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
  const session = sessions[role];
  if (!session) throw new Error("Unknown test account.");
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width, height: 900 },
    extraHTTPHeaders: { "CF-Connecting-IP": clientAddress("profile", 130) },
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
  const page = await context.newPage();
  await page.goto("/streamers");
  await page.getByRole("button", { name: "Account menu for reporter" }).click();
  await page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Your profile" }).click();
  const dialog = page.getByRole("dialog", { name: "Your profile" });
  await expect(dialog).toBeVisible();

  // 18 presets, Space explorer (the default) first, then three rows of six; no "Use my initial".
  const picker = dialog.getByRole("group", { name: "Choose a picture" });
  await expect(picker.getByRole("radio")).toHaveCount(18);
  const labels = await picker.getByRole("radio").evaluateAll((inputs) => inputs.map((input) => input.ariaLabel));
  expect(labels).toEqual(PRESETS);
  await expect(picker.getByRole("radio", { name: "Space explorer (default)" })).toBeChecked();
  await expect(dialog.getByText(/initial/i)).toHaveCount(0);
  await expect(page.locator(".avatar-grid")).toHaveCSS("grid-template-columns", /^(\S+ ){5}\S+$/);

  // Unsaved edits ask before closing.
  await dialog.getByLabel("Display name").fill("Reporter Two");
  await expect(dialog.locator(".preview-name")).toHaveText("Reporter Two");
  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", { name: "Discard changes?" });
  await expect(discard).toContainText("Display name");
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await expect(discard).toHaveCount(0);
  await dialog.getByLabel("Display name").fill("reporter");

  // Upload: the crop step, zoom, then "Your photo" is chosen and first.
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
  // The browser uploads the circle's square at 512 x 512.
  const bytes = await image.body();
  const sof = bytes.findIndex((byte, index) => byte === 0xff && bytes[index + 1] === 0xc0);
  expect(sof).toBeGreaterThan(0);
  expect([bytes.readUInt16BE(sof + 5), bytes.readUInt16BE(sof + 7)]).toEqual([512, 512]);
  await expect(page.getByRole("button", { name: "Account menu for reporter" }).locator("img")).toHaveAttribute(
    "src",
    /^\/images\/avatar\//,
  );

  // Choosing a preset over the photo removes the upload on Save.
  await page.goto("/streamers?dialog=profile");
  await expect(dialog.getByRole("radio", { name: "Your photo" })).toBeChecked();
  await dialog.locator('label[data-avatar="17"]').click();
  await expect(dialog.getByRole("radio", { name: "Friendly alien" })).toBeChecked();
  await dialog.getByRole("button", { name: "Save profile" }).click();
  await expect(dialog).toBeHidden();
  const after = meSchema.parse(await (await context.request.get("/api/me")).json());
  expect(after.viewer).toMatchObject({ avatar: null, avatarPreset: 17 });
  await context.close();
});

test("Edit your page: handle warning, a cropped logo, then the profile picture again", async ({ browser }) => {
  test.slow();
  const context = await signedIn(browser, "otherowner", 390);
  const page = await context.newPage();
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
  // Closing now would lose the logo: it asks first.
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  const discard = page.getByRole("alertdialog", { name: "Discard changes?" });
  await expect(discard).toContainText("Page logo");
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await dialog.getByRole("button", { name: "Save page" }).click();
  await expect(page.getByText("Streamer page saved.").first()).toBeVisible();
  const saved = meSchema.parse(await (await context.request.get("/api/me")).json());
  expect(saved.streamer?.logo).toMatch(/^\/images\/logo\//);
  // The page header shows the logo.
  await expect(page.locator(".streamer-home .brand-avatar")).toHaveAttribute("src", /^\/images\/logo\//);

  await page.goto("/@other_host?dialog=page");
  await dialog.getByRole("radio", { name: "Use my profile picture" }).check();
  await dialog.getByRole("button", { name: "Save page" }).click();
  await expect(dialog).toBeHidden();
  const reverted = meSchema.parse(await (await context.request.get("/api/me")).json());
  expect(reverted.streamer?.logo).toBeNull();
  // Without a logo or an uploaded picture, the page shows the default Space explorer.
  await expect(page.locator(".streamer-home .brand-avatar")).toHaveAttribute("data-preset", "14");
  await context.close();
});
