import { newPage, test, expect } from "./coverage";
import { runSql } from "./fixtures";
import { signedIn } from "./live-helpers";
import { clientIp } from "./client-ips";
import type { ActivityChat } from "../../app/lib/activity";

const OWNER_IP = clientIp("overlay-composition", 240);

const resetLayers = `UPDATE overlay_state SET layers='{"chat":{"enabled":true}}', revision=revision+1 WHERE streamer_id=(SELECT id FROM streamers WHERE handle='feature_host');`;

test.afterAll(async () => {
  await runSql("overlay-composition-cleanup", [
    `UPDATE overlay_state SET layers='{}', revision=revision+1 WHERE streamer_id=(SELECT id FROM streamers WHERE handle='feature_host');`,
  ]);
});

function chat(index: number, receivedAt: number): ActivityChat {
  const messageId = `e2e-${index}`;
  return {
    kind: "chat",
    id: `twitch:${messageId}`,
    platform: "twitch",
    channelId: "e2e-channel",
    messageId,
    user: { id: `e2e-user-${index}`, displayName: `Scav ${index}` },
    text: `Hello from the bunker ${index}`,
    fragments: [{ type: "text", text: `Hello from the bunker ${index}` }],
    badges: [],
    sentAt: null,
    receivedAt,
    live: false,
  };
}

test("a per-layer chat source shows and hides the chat live when the owner changes the layer", async ({ browser }) => {
  await runSql("overlay-composition-reset", [resetLayers]);
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  const obs = await newPage(browser, { viewport: { width: 420, height: 640 } });
  let activitySockets: number = 0;
  await obs.routeWebSocket("**/api/activity/**", (socket) => {
    activitySockets += 1;
    socket.send(JSON.stringify({ type: "snapshot", events: [chat(1, Date.now())], replay: true }));
  });
  await obs.goto("/@feature_host/overlay?key=e2e-key&layer=chat");
  const chatLayer = obs.locator("[data-overlay-chat]");
  await expect(chatLayer.getByText("Hello from the bunker 1")).toBeVisible();
  // A chat source renders the chat alone: no on-air content.
  await expect(obs.locator(".ov-stage")).toHaveCount(0);
  await expect(obs.getByRole("img", { name: "Twitch" })).toBeVisible();
  // Mark the document: a reload would drop the mark.
  await obs.evaluate(() => document.documentElement.setAttribute("data-e2e-loaded", "1"));

  const hide = await owner.request.post("/api/overlay", { data: { action: "layers", chat: { enabled: false } } });
  expect(hide.status()).toBe(200);
  await expect(chatLayer).toHaveCount(0);

  const show = await owner.request.post("/api/overlay", {
    data: { action: "layers", chat: { enabled: true, rect: { x: 1460, y: 280, w: 420, h: 640 } } },
  });
  expect(show.status()).toBe(200);
  await expect(chatLayer.getByText("Hello from the bunker 1")).toBeVisible();
  await expect(obs.locator("html")).toHaveAttribute("data-e2e-loaded", "1");
  // Hiding closed the activity socket and showing opened a new one.
  expect(activitySockets).toBe(2);
  await owner.close();
});

test("an unknown layer renders an empty transparent page", async ({ page }) => {
  await page.goto("/@feature_host/overlay?layer=nope");
  await expect(page.locator("main.overlay-screen")).toBeAttached();
  expect(await page.locator("main.overlay-screen").evaluate((element) => element.childElementCount)).toBe(0);
});
