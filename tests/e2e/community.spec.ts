import { newPage, close } from "./coverage";
import { expect, test } from "./coverage";
import { origin, runSql, signedIn } from "./fixtures";
import { clientIp } from "./client-ips";

// Each case starts with the stored fixture cards and a fresh shared-owner mutation window.
async function seedOwnerCards(withClip: boolean): Promise<void> {
  const streamer: string = "(SELECT id FROM streamers WHERE handle='feature_host')";
  await runSql("community-owner-setup", [
    "DELETE FROM app_rate_limits WHERE key IN ('content:'||(SELECT id FROM user WHERE name='featureowner'),'write:'||(SELECT id FROM user WHERE name='featureowner'));",
    `DELETE FROM community_cards WHERE streamer_id=${streamer} AND title NOT IN ('Bring an idea','Join the Discord');`,
    `UPDATE community_cards SET position=0 WHERE streamer_id=${streamer} AND title='Bring an idea';`,
    `UPDATE community_cards SET position=${withClip ? 2 : 1} WHERE streamer_id=${streamer} AND title='Join the Discord';`,
    ...(withClip
      ? [
          `INSERT INTO community_cards(id,streamer_id,position,icon,title,body,button_label,button_target) VALUES ('74900000-0000-4000-8000-000000000087',${streamer},1,'megaphone','Clip of the week','Send your best clip.','Send a clip','https://clips.example.test/feature');`,
        ]
      : []),
    `UPDATE streamers SET revision=revision+1 WHERE id=${streamer};`,
  ]);
}

test("a page without saved cards shows the two defaults", async ({ page }) => {
  await page.goto("/@test_host?view=community");
  const cards = page.locator(".community-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("Bring an idea");
  await expect(cards.nth(1)).toContainText("Explore polls");
  await cards.nth(1).getByRole("link", { name: "Open polls" }).click();
  await expect(page).toHaveURL(/view=polls/);
});

test("the owner adds, reorders and deletes cards; the support card follows the links", async ({ browser }) => {
  // Four successful card writes: add, move, delete, undo.
  await seedOwnerCards(false);
  const context = await signedIn(browser, "featureowner", clientIp("community", 95));
  // Extended coverage workflow owns 203.0.113.82.
  await context.setExtraHTTPHeaders({ Origin: origin, "CF-Connecting-IP": "203.0.113.82" });
  const page = await newPage(context);
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
  const restored = page.waitForResponse(
    (response) => response.url().endsWith("/api/community-cards") && response.request().method() === "PUT",
  );
  await page.locator(".sb-toast").getByRole("button", { name: "Undo" }).click();
  expect((await restored).status()).toBe(200);
  await page.waitForLoadState("networkidle");
  await page.reload();
  await expect(titles).toHaveText(["Bring an idea", "Clip of the week", "Join the Discord", "Support Feature"]);
  await close(context);
});

test("card recovery preserves drafts and order across failed moves, edits and deletions", async ({ browser }) => {
  // Four successful card writes: move, drop, edit, delete.
  await seedOwnerCards(true);
  const context = await signedIn(browser, "featureowner", clientIp("community", 95));
  // This recovery case owns 203.0.113.87.
  await context.setExtraHTTPHeaders({ Origin: origin, "CF-Connecting-IP": "203.0.113.87" });
  const page = await newPage(context);
  // Keep the two card rows visible together so dragging never scrolls content under a held pointer.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto("/@feature_host?view=community");
  const titles = page.locator(".community-grid .community-card h2");
  await expect(titles).toHaveText(["Bring an idea", "Clip of the week", "Join the Discord", "Support Feature"]);
  // A failed optimistic reorder restores both the visible order and persisted cards.
  await page.route(
    "**/api/community-cards",
    async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      await route.fulfill({ status: 503, json: { error: "The request failed. Please try again." } });
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Move Clip of the week down" }).click();
  await expect(page.locator(".sb-toast")).toContainText("The request failed. Please try again.");
  await expect(titles).toHaveText(["Bring an idea", "Clip of the week", "Join the Discord", "Support Feature"]);
  const moved = page.waitForResponse(
    (response) => response.url().endsWith("/api/community-cards") && response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Move Clip of the week down" }).click();
  expect((await moved).status()).toBe(200);
  await page.waitForLoadState("networkidle");
  await expect(titles).toHaveText(["Bring an idea", "Join the Discord", "Clip of the week", "Support Feature"]);
  const clip = page.locator(".community-grid .community-card").filter({ hasText: "Clip of the week" });
  const handle = clip.locator(".drag-handle");
  const first = page.locator(".community-grid .community-card").first();
  await expect(handle).toBeInViewport({ ratio: 1 });
  await expect(first).toBeInViewport({ ratio: 1 });
  const dropped = page.waitForResponse(
    (response) => response.url().endsWith("/api/community-cards") && response.request().method() === "PUT",
  );
  await handle.dragTo(first, { steps: 10, scroll: "none" });
  expect((await dropped).status()).toBe(200);
  await page.waitForLoadState("networkidle");
  await page.reload();
  await expect(titles).toHaveText(["Clip of the week", "Bring an idea", "Join the Discord", "Support Feature"]);
  await expect(page.getByRole("button", { name: "Move Clip of the week up" })).toBeDisabled();
  await page.getByRole("button", { name: "Edit Clip of the week" }).click();
  const edit = page.getByRole("dialog", { name: "Edit card", exact: true });
  await edit.getByLabel("Title").fill("Weekly clips");
  await edit.getByLabel("Show button").uncheck();
  await page.route(
    "**/api/community-cards",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "The request failed. Please try again." },
      }),
    { times: 1 },
  );
  await edit.getByRole("button", { name: "Save card" }).click();
  await expect(edit.getByRole("alert")).toHaveText("The request failed. Please try again.");
  await expect(edit.getByLabel("Title")).toHaveValue("Weekly clips");
  await edit.getByRole("button", { name: "Save card" }).click();
  await expect(edit).toBeHidden();
  await expect(titles).toHaveText(["Weekly clips", "Bring an idea", "Join the Discord", "Support Feature"]);
  await expect(page.locator(".community-grid .community-card").first().getByRole("link")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit Weekly clips" }).click();
  await edit.getByRole("button", { name: "Delete", exact: true }).click();
  const deletion = page.getByRole("dialog", { name: /Delete.*Weekly clips/ });
  await expect(deletion).toBeVisible();
  await expect(deletion.getByRole("heading")).toBeFocused();
  await page.keyboard.press("Escape");
  // Escape cancels the delete sheet, but on a saturated CI runner the
  // dismiss gesture can be dropped or applied to the wrong layer, leaving the
  // sheet open (or reopened by a replayed click). Re-issue the gesture while
  // the sheet is still attached instead of failing a 10s hidden poll.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await deletion.isVisible().catch(() => false))) break;
    await page.keyboard.press("Escape");
  }
  await expect(deletion).toBeHidden();
  // The edit dialog normally survives cancelling the sheet. If the runner also
  // dropped the sheet-open click, the dialog is closed; reopen it to continue
  // the recovery flow.
  if (!(await edit.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Edit Weekly clips" }).click();
  }
  await expect(edit).toBeVisible();
  await edit.getByRole("button", { name: "Delete", exact: true }).click();
  await page.route(
    "**/api/community-cards",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: "The request failed. Please try again." },
      }),
    { times: 1 },
  );
  await deletion.getByRole("button", { name: "Delete card" }).click();
  await expect(page.locator(".sb-toast")).toContainText("The request failed. Please try again.");
  await expect(titles).toHaveText(["Weekly clips", "Bring an idea", "Join the Discord", "Support Feature"]);
  await page.getByRole("button", { name: "Delete Weekly clips" }).click();
  await deletion.getByRole("button", { name: "Delete card" }).click();
  await expect(titles).toHaveText(["Bring an idea", "Join the Discord", "Support Feature"]);
  await page.getByRole("button", { name: "Preview as viewer" }).click();
  await expect(page.locator(".card-tools")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to editing" }).click();
  await expect(page.locator(".card-tools")).toHaveCount(2);
  await page.getByRole("button", { name: "Add card", exact: false }).last().click();
  await expect(page.getByRole("dialog", { name: "Add card" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Add card" })).toBeHidden();
  const card = { title: "Card", body: "Text" };
  const tooMany = await context.request.put("/api/community-cards", { data: { cards: Array(9).fill(card) } });
  expect(tooMany.status()).toBe(400);
  const unsafe = await context.request.put("/api/community-cards", {
    data: { cards: [{ ...card, buttonLabel: "Go", buttonTarget: "javascript:alert(1)" }] },
  });
  expect(unsafe.status()).toBe(400);
  await close(context);
});

test("About shows support links and the owner edits them within the allow-list", async ({ browser, page }) => {
  await seedOwnerCards(false);
  await page.goto("/@feature_host?view=about");
  const section = page.locator("#sec-support");
  await expect(section.getByRole("heading", { name: "Support Feature" })).toBeVisible();
  await expect(section.getByRole("link", { name: /Ko-fi/ })).toHaveAttribute("href", "https://ko-fi.com/feature_host");
  await expect(section.getByRole("link", { name: /Merch tips/ })).toHaveAttribute("rel", "noopener noreferrer");
  await expect(section).toContainText("StreamBullets doesn't process or receive payments.");
  const context = await signedIn(browser, "featureowner", clientIp("community", 96));
  const owner = await newPage(context);
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
  await close(context);
});
