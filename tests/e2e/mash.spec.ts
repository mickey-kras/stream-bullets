import { newPage, close } from "./coverage";
import { test, expect, type BrowserContext } from "./coverage";
import { accounts, runSql } from "./fixtures";
import { mashId, shots, signedIn } from "./live-helpers";

/** The seeded battle on the feature page, by its seeded title. */
const battle =
  "(SELECT e.id FROM entries e JOIN streamers s ON s.id=e.streamer_id WHERE s.handle='feature_host' AND e.title='Which boss first?')";

// The first test starts, ends and restarts the seeded battle. Put it back as seeded (in setup, the viewer on Radahn
// with 25 taps), so a retry starts from the same state.
test.beforeEach(async () => {
  const viewer: string = (await accounts()).viewer.id;
  await runSql("mash-reset", [
    `UPDATE entry_mash SET phase='setup',starts_at=NULL,ends_at=NULL,winner=NULL WHERE entry_id=${battle};`,
    `DELETE FROM mash_taps WHERE entry_id=${battle};`,
    `INSERT INTO mash_taps(entry_id,user_id,side,taps,assisted_taps) VALUES (${battle},'${viewer}',1,25,0);`,
    `INSERT OR REPLACE INTO entry_votes(entry_id,user_id,choice) VALUES (${battle},'${viewer}',1);`,
    "UPDATE streamers SET revision=revision+1 WHERE handle='feature_host';",
  ]);
});

test("a Mash Battle counts one tap per key press and updates the overlay live", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", 80);
  const viewer = await signedIn(browser, "viewer", 81);
  const id = await mashId(owner);
  const obs = await newPage(browser, { viewport: { width: 1920, height: 1080 } });
  await obs.goto("/@feature_host/overlay");
  await expect(obs.locator("[data-overlay-mash]")).toBeVisible();

  const page = await newPage(viewer);
  await page.goto(`/@feature_host?view=polls&entry=${id}`);
  await expect(page.getByRole("button", { name: /Radahn/ })).toHaveAttribute("aria-pressed", "true");

  expect((await owner.request.post(`/api/mash/${id}/start`, { data: { countdown: false } })).status()).toBe(200);
  const tap = page.locator(".mash-button");
  await expect(tap).toBeVisible();
  await expect(obs.locator('[data-overlay-mash="live"]')).toBeVisible();
  const mine = page.locator("[data-mash-mine]");
  // The seed gave this viewer 25 taps. A held key repeats, but only the first press counts.
  await tap.focus();
  for (let index = 0; index < 6; index += 1) await page.keyboard.down(" ");
  await page.keyboard.up(" ");
  await expect(mine).toHaveText("26");
  const total = obs.locator('[data-mash-total="1"]');
  // The overlay bar follows the 5 Hz totals without a reload.
  await expect(total).toHaveText("26");
  for (let count = 27; count <= 29; count += 1) {
    // Pace intentional presses below the client limit of 15 taps per second.
    await page.waitForTimeout(100);
    await page.keyboard.press("Enter");
    await expect(mine).toHaveText(String(count));
    await expect(total).toHaveText(String(count));
  }
  // A click with no pointer or key press before it, as screen readers and switch access send, taps once; a mouse
  // click and a Space press still tap exactly once each.
  const presses: [number, () => Promise<void>][] = [
    [30, () => tap.dispatchEvent("click")],
    [31, () => tap.click()],
    [32, () => page.keyboard.press(" ")],
  ];
  for (const [count, press] of presses) {
    // An overlay update can arrive immediately after a tap, so it is not a pacing clock.
    await page.waitForTimeout(100);
    await press();
    await expect(mine).toHaveText(String(count));
    await expect(total).toHaveText(String(count));
  }
  await expect(obs.locator('[data-mash-pct="1"]')).toHaveText("100%");
  if (shots) {
    await page.locator(".mash-card").screenshot({ path: `${shots}/mash-card-live.png` });
    await obs.screenshot({ path: `${shots}/overlay-mash-live.png` });
  }

  expect((await owner.request.post(`/api/mash/${id}/end`, { data: {} })).status()).toBe(200);
  await expect(obs.locator('[data-overlay-mash="finished"]')).toBeVisible();
  await expect(obs.locator(".mash-winner strong")).toHaveText("Radahn");
  await expect(page.locator(".mash-winner-title")).toContainText("Radahn");
  if (shots) await obs.screenshot({ path: `${shots}/overlay-mash-winner.png` });

  // Restart deletes the taps and keeps the sides viewers picked.
  expect((await owner.request.post(`/api/mash/${id}/restart`, { data: {} })).status()).toBe(200);
  await expect(page.getByRole("button", { name: /Radahn/ })).toHaveAttribute("aria-pressed", "true");
  await Promise.all([close(owner), close(viewer), close(obs)]);
});

test("only the host runs a battle and signed-out viewers see a sign-in prompt", async ({ browser, page }) => {
  const viewer = await signedIn(browser, "viewer", 82);
  const id = await mashId(viewer);
  expect((await viewer.request.post(`/api/mash/${id}/start`, { data: {} })).status()).toBe(403);
  await page.goto(`/@feature_host?view=polls&entry=${id}`);
  await expect(page.getByText("Sign in to join the battle.")).toBeVisible();
  await close(viewer);
});

test("hold-assisted tapping stops when keyboard focus leaves the button", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", 80);
  const viewer = await signedIn(browser, "viewer", 81);
  // `viewer` is shared and saving replaces every display preference, so its own are put back afterwards.
  const me = (await (await viewer.request.get("/api/me")).json()) as { viewer: { displayPrefs: object } };
  const save = async (data: object): Promise<void> => {
    expect((await viewer.request.patch("/api/me/preferences", { data })).status()).toBe(200);
  };
  await save({ ...me.viewer.displayPrefs, mashAssist: "hold" });
  try {
    await holdThenTab(owner, viewer);
  } finally {
    await save(me.viewer.displayPrefs);
  }
  await Promise.all([close(owner), close(viewer)]);
});

async function holdThenTab(owner: BrowserContext, viewer: BrowserContext): Promise<void> {
  const id = await mashId(owner);
  const page = await newPage(viewer);
  await page.goto(`/@feature_host?view=polls&entry=${id}`);
  await expect(page.getByRole("button", { name: /Radahn/ })).toHaveAttribute("aria-pressed", "true");
  expect((await owner.request.post(`/api/mash/${id}/start`, { data: { countdown: false } })).status()).toBe(200);
  const tap = page.locator(".mash-button");
  await expect(tap).toContainText("Hold to tap");
  const mine = page.locator("[data-mash-mine]");
  const count = async (): Promise<number> => Number((await mine.textContent())?.replaceAll(/\D/gu, ""));
  await tap.focus();
  await page.keyboard.down(" ");
  await expect.poll(count).toBeGreaterThan(26);
  // Tab moves focus on before the key comes up, so the button never sees the key-up.
  await page.keyboard.press("Tab");
  await page.keyboard.up(" ");
  await expect(tap).not.toBeFocused();
  // A tap already counted may still show; after that the count must stay put while focus is elsewhere.
  await page.waitForTimeout(400);
  const stopped = await count();
  await page.waitForTimeout(1_500);
  expect(await count()).toBe(stopped);
  expect((await owner.request.post(`/api/mash/${id}/end`, { data: {} })).status()).toBe(200);
}

test("a selected Mash Battle reconnects after its retry budget expires and accepts taps", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", 80);
  const viewer = await signedIn(browser, "viewer", 81);
  const id: string = await mashId(owner);
  const page = await newPage(viewer);
  let blocked: boolean = true;
  let attempts: number = 0;
  let acknowledgedTaps: number | null = null;
  await page.routeWebSocket("**/api/live/feature_host", async (socket) => {
    attempts += 1;
    if (blocked) await socket.close({ code: 1013, reason: "Test outage" });
    else {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        socket.send(message);
        if (typeof message !== "string" || !message.startsWith("{")) return;
        const reply: unknown = JSON.parse(message);
        if (
          typeof reply === "object" && reply !== null &&
          "type" in reply && reply.type === "mash-ack" &&
          "id" in reply && reply.id === id &&
          "mine" in reply && typeof reply.mine === "number"
        ) acknowledgedTaps = reply.mine;
      });
    }
  });
  await page.clock.install({ time: Date.now() });
  await page.goto(`/@feature_host?view=polls&entry=${id}`);
  await expect(page.locator(".mash-card")).toBeVisible();
  await expect.poll(() => attempts).toBeGreaterThan(0);
  await page.clock.pauseAt(Date.now() + 1000);
  for (let failure: number = 0; failure < 9 && attempts < 9; failure += 1) {
    const previous: number = attempts;
    await page.clock.fastForward(30_001);
    await expect.poll(() => attempts).toBeGreaterThan(previous);
  }
  await expect(page.getByText("Live updates are offline.", { exact: true })).toBeVisible();
  expect(attempts).toBe(9);
  await page.clock.fastForward(60_001);
  expect(attempts).toBe(9);
  blocked = false;
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.locator(".connection-status")).toHaveCount(0);
  expect(attempts).toBe(10);
  await page.clock.resume();
  expect((await owner.request.post(`/api/mash/${id}/start`, { data: { countdown: false } })).status()).toBe(200);
  await page.locator(".mash-button").click();
  await expect.poll(() => acknowledgedTaps).toBe(26);
  await expect(page.locator("[data-mash-mine]")).toHaveText("26");
  expect((await owner.request.post(`/api/mash/${id}/end`, { data: {} })).status()).toBe(200);
  await Promise.all([close(owner), close(viewer)]);
});
