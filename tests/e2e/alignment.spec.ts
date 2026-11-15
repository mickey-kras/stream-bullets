import { newPage, close } from "./coverage";
import { test, expect } from "./coverage";
import { clientIp } from "./client-ips";
import { signedIn } from "./fixtures";


test("the Polls tab: a Mash Battle is a teaser row that opens the battle's own view", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", clientIp("alignment", 140), {
    viewport: { width: 390, height: 844 },
  });
  const page = await newPage(owner);
  await page.goto("/@feature_host?view=polls");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Feature host: Polls");
  await expect(page.getByText("One question. Everyone has a say.")).toBeAttached();
  await expect(page.locator(".connection-status output")).toBeVisible();
  await expect(page.locator(".mash-card")).toHaveCount(0);
  const teaser = page.getByRole("link", { name: /Which boss first\?/ });
  await expect(teaser).toContainText("Mash Battle · starting soon");
  await expect(teaser).toContainText("Malenia vs Radahn vs Fire Giant · 30-second battle");
  await teaser.click();
  await expect(page).toHaveURL(/entry=/u);
  await expect(page.locator(".mash-card")).toBeVisible();
  await expect(page.locator("main")).toHaveClass(/mash-page mash-at-waiting/u);
  await expect(page.getByText("One question. Everyone has a say.")).toHaveCount(0);
  await expect(page.locator(".connection-status")).toHaveCount(0);
  await expect(page.locator(".fab")).toHaveCount(0);
  await expect(page.locator(".host-bar .eyebrow")).toHaveText("Host controls · you host, no side");
  await expect(page.getByRole("button", { name: "All polls" })).toBeVisible();
  await close(owner);
});

test("a poll card has the mockup's React group, owner menu and time left", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", clientIp("alignment", 141));
  const created = await owner.request.post("/api/streamers/feature_host", {
    data: { action: "create", kind: "choice", title: "Alignment poll", options: ["Red", "Blue"], duration: 3600 },
  });
  expect(created.status()).toBe(200);
  const { id } = (await created.json()) as { id: string };
  const page = await newPage(owner);
  await page.goto(`/@feature_host?view=polls&entry=${id}`);
  const card = page.locator(".poll-card").filter({ hasText: "Alignment poll" }).first();
  await expect(card.locator(".poll-countdown")).toHaveText(/^(1 h 0 min|60 min|59 min) left$/u);
  await expect(card.getByText("Viewers can vote until voting closes.")).toBeVisible();
  const react = card.getByRole("group", { name: "React to this poll" });
  await expect(react.getByRole("button", { name: "Like poll, 0", exact: true })).toBeVisible();
  await card.getByLabel("Poll actions: Alignment poll").click();
  await expect(card.getByRole("button", { name: "End voting" })).toBeVisible();
  await card.getByRole("button", { name: "Delete poll" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".poll-card").filter({ hasText: "Alignment poll" })).toHaveCount(0);
  await close(owner);
});

test("Edit your page marks its required fields", async ({ browser }) => {
  const owner = await signedIn(browser, "owner", clientIp("alignment", 142));
  const page = await newPage(owner);
  await page.goto("/@test_host?dialog=page");
  const dialog = page.getByRole("dialog", { name: "Edit your page" });
  await expect(dialog.locator(".req-note")).toHaveText("* required");
  await expect(dialog.locator("label:has(.req)")).toHaveCount(2);
  // Hide the required marker from assistive technology to preserve field names.
  await expect(dialog.getByRole("textbox", { name: "Page name", exact: true })).toBeVisible();
  await close(owner);
});

test("Edit your page reopens with what was just saved, and a second save keeps it", async ({ browser }) => {
  const owner = await signedIn(browser, "owner", clientIp("alignment", 146));
  const page = await newPage(owner);
  await page.goto("/@test_host?dialog=page");
  const dialog = page.getByRole("dialog", { name: "Edit your page" });
  const name = dialog.getByRole("textbox", { name: "Page name", exact: true });
  const about = dialog.getByRole("textbox", { name: "About your stream" });
  // Reopen dialogs without navigation to verify fresh data.
  const reopen = async (): Promise<void> => {
    await page.getByRole("button", { name: /^Account menu for / }).click();
    await page.getByRole("link", { name: "Edit your page" }).click();
    await expect(dialog).toBeVisible();
  };
  const save = async (): Promise<void> => {
    await dialog.getByRole("button", { name: "Save page" }).click();
    await expect(dialog).toBeHidden();
  };
  await name.fill("Test host renamed");
  await save();
  await reopen();
  await expect(name).toHaveValue("Test host renamed");
  await about.fill("A test community, renamed.");
  await save();
  await reopen();
  await expect(name).toHaveValue("Test host renamed");
  await expect(about).toHaveValue("A test community, renamed.");
  await name.fill("Test host");
  await about.fill("A test community.");
  await save();
  await close(owner);
});

test("an admin marks and clears the official page from the Streamer pages tab (R14)", async ({ browser }) => {
  const admin = await signedIn(browser, "admin", clientIp("alignment", 143));
  const page = await newPage(admin);
  await page.goto("/admin?view=pages&query=other_host");
  const row = page.getByRole("article", { name: "Other host" });
  await row.getByRole("button", { name: "Mark as official @other_host" }).click();
  const sheet = page.getByRole("dialog", { name: "Make @other_host the official page?" });
  await sheet.getByRole("button", { name: "Mark as official" }).click();
  await expect(page.locator(".admin-notice")).toHaveText("@other_host is now the official page.");
  await expect(row.locator(".official-badge")).toHaveText("Official");
  await expect(row.locator(".mod-history")).toContainText("Marked official");
  await row.getByRole("button", { name: "Remove official @other_host" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove official" }).click();
  await expect(page.locator(".admin-notice")).toHaveText("@other_host is no longer the official page.");
  await expect(row.locator(".official-badge")).toHaveCount(0);
  await close(admin);
});

test("on a frozen page the owner gets the date and no delete buttons", async ({ browser }) => {
  const owner = await signedIn(browser, "frozenowner", clientIp("alignment", 144));
  const page = await newPage(owner);
  await page.goto("/@frozen_host");
  await expect(page.locator("#page-banner")).toContainText(/Your page was frozen on [A-Z][a-z]{2} \d{1,2}, \d{4}\./u);
  await expect(page.getByRole("button", { name: "Delete topic" })).toHaveCount(0);
  await expect(page.locator(".votes button").first()).toBeDisabled();
  await close(owner);
});

test("overlay control keeps the Take bar at the bottom of a phone screen", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", clientIp("alignment", 145), {
    viewport: { width: 390, height: 844 },
  });
  const page = await newPage(owner);
  await page.goto("/overlay-control");
  const dock = page.locator(".ov-take-dock");
  await expect(dock).toBeVisible();
  const box = await dock.boundingBox();
  expect(box && box.y + box.height).toBeGreaterThan(780);
  expect(box && box.y + box.height).toBeLessThanOrEqual(845);
  await expect(dock.getByRole("button", { name: /Take/ })).toBeInViewport();
  await close(owner);
});
