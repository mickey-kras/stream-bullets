import { expect, test } from "@playwright/test";
import { signedIn } from "./fixtures";
import { clientIp } from "./client-ips";

test("a page without saved cards shows the two defaults", async ({ page }) => {
  await page.goto("/@test_host?view=community");
  const cards = page.locator(".community-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("Bring an idea");
  await expect(cards.nth(1)).toContainText("Have your say live");
  await cards.nth(1).getByRole("link", { name: "Open polls" }).click();
  await expect(page).toHaveURL(/view=polls/);
});

test("the owner adds, reorders and deletes cards; the support card follows the links", async ({ browser }) => {
  const context = await signedIn(browser, "featureowner", clientIp("community", 95));
  const page = await context.newPage();
  await page.goto("/@feature_host?view=community");
  const titles = page.locator(".community-grid .community-card h2");
  await expect(titles).toHaveText(["Bring an idea", "Join the Discord", "Support Feature"]);
  await page.locator("#suggest").click();
  const dialog = page.getByRole("dialog", { name: "Add card" });
  await dialog.getByRole("radio", { name: "Megaphone" }).check();
  await dialog.getByLabel("Title").fill("Clip of the week");
  await dialog.getByLabel("Text").fill("Send your best clip.");
  await dialog.getByLabel("Show button").check();
  await dialog.getByLabel("Button label").fill("Send a clip");
  await dialog.getByRole("combobox", { name: "Goes to" }).click();
  await page.getByRole("option", { name: "External link" }).click();
  await dialog.getByLabel("Link (https only)").fill("https://clips.example.test/feature");
  await expect(dialog.locator(".card-preview")).toContainText("Clip of the week");
  await dialog.getByRole("button", { name: "Add card" }).click();
  await expect(dialog).toBeHidden();
  await expect(titles).toHaveText(["Bring an idea", "Join the Discord", "Clip of the week", "Support Feature"]);
  await page.getByRole("button", { name: "Move Clip of the week up" }).click();
  await expect(titles).toHaveText(["Bring an idea", "Clip of the week", "Join the Discord", "Support Feature"]);
  await page.reload();
  await expect(titles).toHaveText(["Bring an idea", "Clip of the week", "Join the Discord", "Support Feature"]);
  const link = page.locator(".community-card").filter({ hasText: "Clip of the week" }).getByRole("link");
  await expect(link).toHaveAttribute("href", "https://clips.example.test/feature");
  await expect(link).toHaveAttribute("target", "_blank");
  await page.getByRole("button", { name: "Delete Clip of the week" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete card" }).click();
  await expect(titles).toHaveText(["Bring an idea", "Join the Discord", "Support Feature"]);
  await page.locator(".sb-toast").getByRole("button", { name: "Undo" }).click();
  await expect(titles).toHaveText(["Bring an idea", "Clip of the week", "Join the Discord", "Support Feature"]);
  await page.getByRole("button", { name: "Preview as viewer" }).click();
  await expect(page.locator(".card-tools")).toHaveCount(0);
  const card = { title: "Card", body: "Text" };
  const tooMany = await context.request.put("/api/community-cards", { data: { cards: Array(9).fill(card) } });
  expect(tooMany.status()).toBe(400);
  const unsafe = await context.request.put("/api/community-cards", {
    data: { cards: [{ ...card, buttonLabel: "Go", buttonTarget: "javascript:alert(1)" }] },
  });
  expect(unsafe.status()).toBe(400);
  await context.close();
});

test("About shows support links and the owner edits them within the allow-list", async ({ browser, page }) => {
  await page.goto("/@feature_host?view=about");
  const section = page.locator("#sec-support");
  await expect(section.getByRole("heading", { name: "Support Feature" })).toBeVisible();
  await expect(section.getByRole("link", { name: /Ko-fi/ })).toHaveAttribute("href", "https://ko-fi.com/feature_host");
  await expect(section.getByRole("link", { name: /Merch tips/ })).toHaveAttribute("rel", "noopener noreferrer");
  await expect(section).toContainText("StreamBullets doesn't process or receive payments.");
  const context = await signedIn(browser, "featureowner", clientIp("community", 96));
  const owner = await context.newPage();
  await owner.goto("/@feature_host?view=about");
  await owner.getByRole("link", { name: "Edit support links" }).click();
  await expect(owner).toHaveURL(/dialog=page/);
  const editor = owner.getByRole("dialog", { name: "Edit your page" });
  await expect(editor.getByRole("group", { name: "Support links" })).toBeVisible();
  await editor.getByRole("button", { name: "Add support link" }).click();
  await editor.getByRole("combobox", { name: "Provider for link 3" }).click();
  await owner.getByRole("option", { name: "Patreon" }).click();
  await editor.getByRole("textbox", { name: "Link 3" }).fill("https://ko-fi.com/not-patreon");
  await editor.getByRole("button", { name: "Save page" }).click();
  await expect(editor.getByRole("alert")).toHaveText("Link 3: use an https link on Patreon's own domain.");
  await editor.getByRole("textbox", { name: "Link 3" }).fill("https://www.patreon.com/feature_host");
  await editor.getByRole("button", { name: "Save page" }).click();
  await expect(editor).toBeHidden();
  await expect(owner.locator("#sec-support").getByRole("link", { name: /Patreon/ })).toBeVisible();
  const forged = await context.request.put("/api/support-links", {
    data: {
      links: [{ kind: "kofi", label: null, url: "https://evil.example.test/ko-fi.com" }],
      visible: true,
      card: false,
    },
  });
  expect(forged.status()).toBe(400);
  await context.close();
});
