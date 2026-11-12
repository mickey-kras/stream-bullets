import { newPage, close } from "./coverage";
import { expect, test } from "./coverage";
import { signedIn } from "./fixtures";
import { clientIp } from "./client-ips";

const template = "What happened?\n\nWhat did you expect?\n\nSteps to reproduce:\n1. ";

test("the Ideas board files a suggestion under review and handles the bug template", async ({ browser }) => {
  const context = await signedIn(browser, "viewer", clientIp("ideas", 105));
  const page = await newPage(context);
  await page.goto("/@streambullets");
  await expect(page.getByRole("heading", { name: /Ideas for StreamBullets/ })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link");
  await expect(tabs).toHaveCount(3);
  await expect(tabs.first()).toHaveAttribute("aria-current", "page");
  await expect(tabs.first()).toContainText("Ideas");
  const filters = page.getByRole("navigation", { name: "Filter by status" });
  await filters.getByRole("link", { name: "Planned", exact: true }).click();
  await expect(page.locator("#topics .idea-row")).toHaveCount(1);
  await expect(page.locator("#topics .idea-row")).toContainText("Planned");
  await filters.getByRole("link", { name: "Shipped", exact: true }).click();
  await expect(page.locator(".changelog-note")).toBeVisible();
  await expect(page.locator("#topics .idea-row")).toHaveCount(0);

  // The footer link opens the board with Suggest an improvement open (`?intent=suggest`).
  await page.locator(".site-footer .footer-full").getByRole("link", { name: "Suggest an improvement" }).click();
  await expect(page).toHaveURL(/intent=suggest/);
  const dialog = page.getByRole("dialog", { name: "Suggest an improvement" });
  await expect(dialog).toBeVisible();
  const details = dialog.getByRole("textbox", { name: "Details", exact: true });
  await dialog.getByLabel("Title").fill("Week view starts on Sunday");
  const category = dialog.getByRole("combobox", { name: "Category" });
  await category.click();
  await page.getByRole("option", { name: "Bug" }).click();
  await expect(details).toHaveValue(template);
  await expect(dialog.getByLabel("Include browser and screen details")).toBeChecked();
  await category.click();
  await page.getByRole("option", { name: "Feature idea" }).click();
  await expect(details).toHaveValue("");
  await expect(dialog.getByLabel("Title")).toHaveValue("Week view starts on Sunday");
  await details.fill("My calendar starts on Monday.");
  await category.click();
  await page.getByRole("option", { name: "Bug" }).click();
  await expect(details).toHaveValue(`My calendar starts on Monday.\n\n${template}`);
  await dialog.getByRole("button", { name: "Submit suggestion" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Fill in the bug template");
  await category.click();
  await page.getByRole("option", { name: "Feature idea" }).click();
  await expect(details).toHaveValue("My calendar starts on Monday.");
  await dialog.getByRole("button", { name: "Submit suggestion" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/entry=/);
  const detail = page.locator("#detail");
  await expect(detail.getByRole("heading", { name: "Week view starts on Sunday" })).toBeVisible();
  await expect(detail.locator(".idea-status")).toHaveText("Under review");
  await expect(page.locator("#topics .idea-row.selected")).toContainText("Under review");
  await expect(detail.getByRole("button", { name: "Delete idea" })).toBeVisible();
  const planned = await context.request.get("/api/streamers/streambullets?status=planned");
  const ideas = (await planned.json()) as { entries: { title: string; status: string }[] };
  expect(ideas.entries.map((entry) => entry.status)).toEqual(["planned"]);
  // The author may delete an idea while it is under review.
  await detail.getByRole("button", { name: "Delete idea" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete idea" }).click();
  await expect(page.locator("#topics .idea-row")).toHaveCount(1);
  await close(context);
});

test("an admin sets an idea's status from the detail view", async ({ browser }) => {
  const viewer = await signedIn(browser, "viewer", clientIp("ideas", 110));
  const board = await viewer.request.get("/api/streamers/streambullets");
  const { entries } = (await board.json()) as { entries: { id: string; title: string }[] };
  const idea = entries.find((entry) => entry.title === "Dark mode for the overlay");
  if (!idea) throw new Error("The seeded idea is missing.");
  const viewerPage = await newPage(viewer);
  await viewerPage.goto(`/@streambullets?entry=${idea.id}`);
  await expect(viewerPage.locator("#detail .idea-status")).toHaveText("Planned");
  await expect(viewerPage.getByText("Status (admins only)")).toHaveCount(0);
  expect(
    (await viewer.request.post(`/api/admin/entries/${idea.id}/status`, { data: { status: "shipped" } })).status(),
  ).toBe(403);

  const admin = await signedIn(browser, "admin", clientIp("ideas", 111));
  const page = await newPage(admin);
  await page.goto(`/@streambullets?entry=${idea.id}`);
  const detail = page.locator("#detail");
  const status = detail.getByRole("combobox", { name: "Status (admins only)" });
  await expect(status).toBeVisible();
  await expect(detail.getByRole("button", { name: "Save status" })).toBeDisabled();
  await status.click();
  await page.getByRole("option", { name: "Not planned" }).click();
  await detail.getByLabel("Reason shown to everyone").fill("It clashes with OBS themes.");
  await detail.getByRole("button", { name: "Save status" }).click();
  await expect(detail.locator(".idea-status")).toHaveText("Not planned");
  await expect(detail.locator(".idea-reason")).toContainText("It clashes with OBS themes.");
  await status.click();
  await page.getByRole("option", { name: "Planned", exact: true }).click();
  await expect(detail.getByLabel("Reason shown to everyone")).toHaveCount(0);
  await detail.getByRole("button", { name: "Save status" }).click();
  await expect(detail.locator(".idea-status")).toHaveText("Planned");
  // The status choices follow the page language, both as the server renders them and once the list opens.
  await admin.addCookies([{ name: "sb_locale", value: "de", domain: "localhost", path: "/", sameSite: "Lax" }]);
  await page.reload();
  const german = page.locator("#detail").getByRole("combobox", { name: "Status (nur Admins)" });
  await expect(german).toContainText("Geplant");
  await german.click();
  await expect(page.getByRole("option", { name: "Nicht geplant" })).toBeVisible();
  await page.keyboard.press("Escape");
  await close(viewer);
  await close(admin);
});

test("frozen and suspended pages show banners and keep writes off", async ({ browser }) => {
  const viewer = await signedIn(browser, "viewer", clientIp("ideas", 106));
  const page = await newPage(viewer);
  await page.goto("/@frozen_host");
  await expect(page.locator("#page-banner")).toContainText("This page is frozen. Viewing only");
  await expect(page.getByRole("button", { name: /^Like/ }).first()).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Write a comment" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Write a comment" })).toHaveAttribute(
    "placeholder",
    "Comments are paused while this page is frozen.",
  );
  await expect(page.locator("#suggest")).toBeDisabled();
  const owner = await signedIn(browser, "frozenowner", clientIp("ideas", 107));
  const ownerPage = await newPage(owner);
  await ownerPage.goto("/@frozen_host?view=schedule");
  await expect(ownerPage.locator("#page-banner")).toContainText("Your page was frozen on ");
  await expect(ownerPage.locator("#page-banner")).toContainText("Reason: Under review.");
  await expect(ownerPage.getByRole("button", { name: "Appeal / contact us" })).toBeVisible();
  const suspended = await signedIn(browser, "suspendedowner", clientIp("ideas", 108));
  const suspendedPage = await newPage(suspended);
  await suspendedPage.goto("/@suspended_host");
  await expect(suspendedPage.locator("#page-banner")).toContainText("Your page was suspended on ");
  await close(viewer);
  await close(owner);
  await close(suspended);
});
