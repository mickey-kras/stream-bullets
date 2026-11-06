import { expect, test } from "@playwright/test";
import { signedIn } from "./fixtures";

const template = "What happened?\n\nWhat did you expect?\n\nSteps to reproduce:\n1. ";

test("the Ideas board files a suggestion under review and handles the bug template", async ({ browser }) => {
  const context = await signedIn(browser, "viewer", 105);
  const page = await context.newPage();
  await page.goto("/@streambullets");
  await expect(page.getByRole("heading", { name: /Ideas for StreamBullets/ })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link");
  await expect(tabs).toHaveCount(3);
  await expect(tabs.first()).toHaveAttribute("aria-current", "page");
  await expect(tabs.first()).toContainText("Ideas");
  const filters = page.getByRole("navigation", { name: "Filter by status" });
  await filters.getByRole("link", { name: "Planned" }).click();
  await expect(page.locator("#topics .idea-row")).toHaveCount(1);
  await expect(page.locator("#topics .idea-row")).toContainText("Planned");
  await filters.getByRole("link", { name: "Shipped" }).click();
  await expect(page.locator(".changelog-note")).toBeVisible();
  await expect(page.locator("#topics .idea-row")).toHaveCount(0);

  await page.getByRole("button", { name: "Suggest an improvement" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Suggest an improvement" });
  const details = dialog.getByLabel("Details");
  await dialog.getByLabel("Title").fill("Week view starts on Sunday");
  const category = dialog.getByRole("combobox", { name: "Category" });
  await category.click();
  await page.getByRole("option", { name: "Bug" }).click();
  await expect(details).toHaveValue(template);
  await expect(dialog.getByLabel("Include my browser and page info")).toBeChecked();
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
  await context.close();
});

test("frozen and suspended pages show banners and keep writes off", async ({ browser }) => {
  const viewer = await signedIn(browser, "viewer", 106);
  const page = await viewer.newPage();
  await page.goto("/@frozen_host");
  await expect(page.locator("#page-banner")).toContainText("This page is frozen. Viewing only");
  await expect(page.getByRole("button", { name: /^Like/ }).first()).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Write a comment" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Write a comment" })).toHaveAttribute(
    "placeholder",
    "Comments are paused while this page is frozen.",
  );
  await expect(page.locator("#suggest")).toBeDisabled();
  const owner = await signedIn(browser, "frozenowner", 107);
  const ownerPage = await owner.newPage();
  await ownerPage.goto("/@frozen_host?view=schedule");
  await expect(ownerPage.locator("#page-banner")).toContainText("Your page is frozen.");
  await expect(ownerPage.locator("#page-banner")).toContainText("Reason: Under review.");
  await expect(ownerPage.getByRole("button", { name: "Appeal / contact us" })).toBeVisible();
  const suspended = await signedIn(browser, "suspendedowner", 108);
  const suspendedPage = await suspended.newPage();
  await suspendedPage.goto("/@suspended_host");
  await expect(suspendedPage.locator("#page-banner")).toContainText("Your page is suspended.");
  await viewer.close();
  await owner.close();
  await suspended.close();
});
