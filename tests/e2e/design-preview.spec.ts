import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Download, Locator, Route } from "@playwright/test";
import { test, expect } from "./coverage";

test("the design preview renders approved cards, animates couriers, and exports artwork", async ({ page }, testInfo) => {
  const root: string = resolve("docs/design/wasteland-overlays");
  const files: Readonly<Record<string, string>> = {
    "/": resolve(root, "index.html"),
    "/assets/courier-source.png": resolve(root, "assets/courier-source.png"),
    "/assets/terrain-source.png": resolve(root, "assets/terrain-source.png"),
  };
  const errors: string[] = [];
  page.on("pageerror", (error: Error): void => { errors.push(error.message); });
  await page.route("https://fonts.googleapis.com/**", (route: Route): Promise<void> => route.abort());
  await page.route("https://design-preview.test/**", async (route: Route): Promise<void> => {
    const file: string | undefined = files[new URL(route.request().url()).pathname];
    if (file === undefined) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({ path: file });
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("https://design-preview.test/");
  await expect(page.locator("#assetStatus")).toContainText("48 frames");
  await page.locator("#feedBtn").click();
  await page.locator("#autoChk").uncheck();
  await expect(page.locator("#sheet canvas")).toHaveCount(12);
  for (const platform of ["Twitch", "YouTube", "Kick", "Velora", "VPZone"]) {
    await expect(page.locator(`#chat .platform-icon[aria-label="${platform}"]`).first()).toBeAttached();
  }
  await expect(page.locator("#chat .row").first()).toHaveCSS("background-color", "rgba(8, 43, 46, 0.9)");
  await expect(page.locator("#chat .row").first()).toHaveCSS("border-top-width", "1px");
  await expect(page.locator(".np").first()).toHaveCSS("opacity", "0");
  await page.locator("#playBtn").click();
  await expect(page.locator("#playBtn")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#composeBtn").click();
  await expect(page.locator(".composed-chat")).toBeVisible();
  await expect(page.locator(".composed-chat .row").first()).toContainText("Alexei");

  const captures: ReadonlyArray<{ selector: string; name: string }> = [
    { selector: "#chatStage", name: "chat" },
    { selector: "#playStage", name: "playground" },
    { selector: "#sheet", name: "sprites" },
  ];
  for (const capture of captures) {
    const target: Locator = page.locator(capture.selector);
    const path: string = testInfo.outputPath(`${capture.name}.png`);
    await target.screenshot({ path });
    await testInfo.attach(capture.name, { path, contentType: "image/png" });
  }

  await page.getByText("Purple", { exact: true }).click();
  const exports: ReadonlyArray<{ selector: string; name: string; height: number }> = [
    { selector: "#exportSheet", name: "courier-tw-4x.png", height: 1536 },
    { selector: "#exportTerrain", name: "terrain-atlas.png", height: 512 },
  ];
  for (const artwork of exports) {
    const pending: Promise<Download> = page.waitForEvent("download");
    await page.locator(artwork.selector).click();
    const download: Download = await pending;
    expect(download.suggestedFilename()).toBe(artwork.name);
    const path: string = testInfo.outputPath(artwork.name);
    await download.saveAs(path);
    const png: Buffer = await readFile(path);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(artwork.height);
    await testInfo.attach(artwork.name, { path, contentType: "image/png" });
  }
  await page.locator("#backgroundBtn").click();
  await expect(page.locator("#playStage .scene")).toBeHidden();
  expect(errors).toEqual([]);
});
