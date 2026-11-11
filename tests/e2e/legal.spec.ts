import { expect, test } from "./coverage";

const draft: RegExp = /Draft — operator details pending/;

test("privacy policy and terms render with contents and a draft notice", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page).toHaveTitle("Privacy Policy · StreamBullets");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText(draft);
  const contents = page.getByRole("navigation", { name: "Contents" });
  for (const name of [
    "Your rights",
    "California privacy rights",
    "Cookies and local storage",
    "Age limit and children",
  ])
    await expect(contents.getByRole("link", { name })).toBeVisible();
  await expect(page.getByRole("cell", { name: "__Host-stream-bullets.session_token" })).toBeVisible();
  await contents.getByRole("link", { name: "Cookies and local storage" }).click();
  await expect(page).toHaveURL(/\/privacy#cookies$/);
  await expect(page.getByRole("heading", { name: "Cookies and local storage" })).toBeInViewport();
  // Legal pages use the generic header with the real account control and a way back.
  await expect(page.getByRole("banner").getByRole("button", { name: "Sign in / Sign up" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Back to Streamers" })).toBeVisible();

  await page.goto("/terms");
  await expect(page).toHaveTitle("Terms of Service · StreamBullets");
  await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText(draft);
  await expect(page.getByRole("heading", { name: "Reporting content and moderation" })).toBeAttached();
});

test("the footer links to the legal pages, contact, and the reporting rules", async ({ page }) => {
  await page.goto("/streamers");
  const footer = page.getByRole("contentinfo");
  await footer.getByRole("button", { name: "Contact" }).click();
  const contact = page.getByRole("dialog", { name: "Contact us" });
  await expect(contact).toContainText("support@streambullets.com");
  await expect(contact.getByRole("link", { name: "Open email app" })).toHaveAttribute(
    "href",
    "mailto:support@streambullets.com",
  );
  await contact.getByRole("button", { name: "Close dialog" }).click();
  await footer.getByRole("link", { name: "Privacy" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  await page.getByRole("contentinfo").getByRole("link", { name: "Terms" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();
  await page.getByRole("contentinfo").getByRole("link", { name: "Report content" }).click();
  await expect(page).toHaveURL(/\/terms#reporting$/);
  await expect(page.getByRole("heading", { name: "Reporting content and moderation" })).toBeInViewport();
});

for (const [name, path] of [
  ["Privacy Policy", "/privacy"],
  ["Terms", "/terms"],
] as const) {
  test(`the sign-in dialog links to ${name}`, async ({ page }) => {
    // Test each link from a fresh dialog instead of sharing back-navigation state.
    await page.goto("/streamers");
    await page.getByRole("banner").getByRole("button", { name: "Sign in / Sign up", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Sign in or sign up" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("status")).toHaveText(
      "Sign-in is turned off on this site for now. Public pages still work.",
    );
    await dialog.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new URL(path, "http://localhost:5173").href);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}

test("the OBS overlay has no footer or site chrome", async ({ page }) => {
  await page.goto("/@test_host/overlay");
  await expect(page.locator(".overlay-screen")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toHaveCount(0);
  await expect(page.getByRole("banner")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Privacy" })).toHaveCount(0);
});
