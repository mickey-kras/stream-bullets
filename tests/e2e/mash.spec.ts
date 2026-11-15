import { newPage, close } from "./coverage";
import { test, expect, type BrowserContext } from "./coverage";
import { accounts, runSql } from "./fixtures";
import { mashId, shots, signedIn } from "./live-helpers";

const battle =
  "(SELECT e.id FROM entries e JOIN streamers s ON s.id=e.streamer_id WHERE s.handle='feature_host' AND e.title='Which boss first?')";

// Restore the seeded setup, Radahn side, and 25 viewer taps before each retry.
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
  // Seeded total: 25 taps. Held-key repeats count only the first press.
  await tap.focus();
  for (let index = 0; index < 6; index += 1) await page.keyboard.down(" ");
  await page.keyboard.up(" ");
  await expect(mine).toHaveText("26");
  const total = obs.locator('[data-mash-total="1"]');
  await expect(total).toHaveText("26");
  for (let count = 27; count <= 29; count += 1) {
    // Keep intentional presses below 15 taps/s.
    await page.waitForTimeout(100);
    await page.keyboard.press("Enter");
    await expect(mine).toHaveText(String(count));
    await expect(total).toHaveText(String(count));
  }
  // Assistive clicks, mouse clicks, and Space presses must each count once.
  const presses: [number, () => Promise<void>][] = [
    [30, () => tap.dispatchEvent("click")],
    [31, () => tap.click()],
    [32, () => page.keyboard.press(" ")],
  ];
  for (const [count, press] of presses) {
    // Overlay updates can follow taps immediately; do not use them for pacing.
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
  // Restore all shared viewer preferences after replacing them.
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
  // Tab moves focus before key-up, so the button never receives it.
  await page.keyboard.press("Tab");
  await page.keyboard.up(" ");
  await expect(tap).not.toBeFocused();
  // Allow an in-flight tap, then require a stable count while focus is elsewhere.
  await page.waitForTimeout(400);
  const stopped = await count();
  await page.waitForTimeout(1_500);
  expect(await count()).toBe(stopped);
  // Pointer release and leaving the button also stop hold assistance.
  await tap.hover();
  await page.mouse.down();
  await expect.poll(count).toBeGreaterThan(stopped);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const released: number = await count();
  await page.waitForTimeout(400);
  expect(await count()).toBe(released);
  await tap.hover();
  await page.mouse.down();
  await expect.poll(count).toBeGreaterThan(released);
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const left: number = await count();
  await page.waitForTimeout(400);
  expect(await count()).toBe(left);
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
          typeof reply === "object" &&
          reply !== null &&
          "type" in reply &&
          reply.type === "mash-ack" &&
          "id" in reply &&
          reply.id === id &&
          "mine" in reply &&
          typeof reply.mine === "number"
        )
          acknowledgedTaps = reply.mine;
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

test("host controls retry, count down, end a draw, restart and delete a battle", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", 80);
  const viewer = await signedIn(browser, "viewer", 81);
  // New Mash coverage cases own 203.0.113.83–86.
  await owner.setExtraHTTPHeaders({ Origin: "http://localhost:5173", "CF-Connecting-IP": "203.0.113.83" });
  await viewer.setExtraHTTPHeaders({ Origin: "http://localhost:5173", "CF-Connecting-IP": "203.0.113.84" });
  const id: string = "74900000-0000-4000-8000-000000000083";
  await runSql("mash-controls-coverage", [
    `DELETE FROM entries WHERE id='${id}';`,
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed) SELECT '${id}',streamer_id,author_id,'choice','Coverage finale','','','["Sun","Moon"]',${Date.now()},0 FROM entries WHERE id=${battle};`,
    `INSERT INTO entry_mash(entry_id,duration_s,phase) VALUES ('${id}',30,'setup');`,
    "UPDATE streamers SET revision=revision+1 WHERE handle='feature_host';",
  ]);
  const host = await newPage(owner);
  const page = await newPage(viewer);
  try {
    await host.goto(`/@feature_host?view=polls&entry=${id}`);
    await page.goto(`/@feature_host?view=polls&entry=${id}`);
    const hostCard = host.locator(".mash-card");
    const card = page.locator(".mash-card");
    await expect(hostCard).toContainText("Starts when you press Start");
    await card.getByRole("button", { name: /Sun/ }).click();
    await expect(card.getByRole("button", { name: /Sun/ })).toHaveAttribute("aria-pressed", "true");
    await card.getByRole("button", { name: "Change side" }).click();
    await expect(card.locator(".mash-pick-help")).toBeVisible();
    await page.keyboard.press("2");
    await expect(card.getByRole("button", { name: /Moon/ })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("x");
    await expect(card.getByRole("button", { name: /Moon/ })).toHaveAttribute("aria-pressed", "true");
    await host.route(
      `**/api/mash/${id}/start`,
      (route) =>
        route.fulfill({
          status: 503,
          json: { error: "The request failed. Please try again." },
        }),
      { times: 1 },
    );
    await hostCard.getByRole("button", { name: "Start with 3-2-1" }).click();
    await expect(host.locator(".sb-toast")).toContainText("The request failed. Please try again.");
    await expect(hostCard.getByRole("button", { name: "Start with 3-2-1" })).toBeEnabled();
    await hostCard.getByRole("button", { name: "Start with 3-2-1" }).click();
    await expect(card).toHaveClass(/phase-countdown/);
    await expect(card).toContainText("Get ready to mash for Moon");
    await expect(hostCard).toContainText("The battle starts in a moment.");
    await expect(card).toHaveClass(/phase-live/);
    await expect(page.locator("#sb-announce-assertive")).toContainText("Go! Mash for Moon.");
    await card.getByRole("button", { name: "Read score" }).click();
    await expect(page.locator("#sb-announce-polite")).toContainText("Moon (your side) 0, Sun 0.");
    await card.locator(".mash-button").focus();
    await page.keyboard.press("S");
    await expect(page.locator("#sb-announce-polite")).toContainText("Moon (your side) 0, Sun 0.");
    await hostCard.getByRole("button", { name: "End early" }).click();
    const ending = host.getByRole("dialog", { name: "End “Coverage finale” early?" });
    await ending.getByRole("button", { name: "Keep going" }).click();
    await expect(ending).toBeHidden();
    await expect(hostCard).toHaveClass(/phase-live/);
    await hostCard.getByRole("button", { name: "End early" }).click();
    await ending.getByRole("button", { name: "End early" }).click();
    await expect(card.locator(".mash-winner-title")).toContainText("Draw");
    await expect(page.locator("#sb-announce-assertive")).toHaveText("Battle over. It's a draw.");
    await hostCard.getByRole("button", { name: "Restart as new battle" }).click();
    await expect(hostCard.getByRole("button", { name: "Start now" })).toBeVisible();
    await hostCard.getByRole("button", { name: "Start now" }).click();
    await expect(hostCard).toHaveClass(/phase-live/);
    await hostCard.getByRole("button", { name: "End early" }).click();
    await ending.getByRole("button", { name: "End early" }).click();
    await expect(hostCard.getByRole("button", { name: "Restart as new battle" })).toBeVisible();
    await hostCard.getByRole("button", { name: "Delete", exact: true }).click();
    const deletion = host.getByRole("dialog", { name: "Delete “Coverage finale”?" });
    await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(deletion).toBeHidden();
    await hostCard.getByRole("button", { name: "Delete", exact: true }).click();
    await deletion.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(host.getByRole("heading", { name: "Coverage finale", exact: true })).toHaveCount(0);
    expect((await owner.request.get(`/api/entries/${id}`)).status()).toBe(404);
  } finally {
    await runSql("mash-controls-cleanup", [`DELETE FROM entries WHERE id='${id}';`]);
    await Promise.all([close(owner), close(viewer)]);
  }
});

test("toggle assistance starts and stops from clicks and keyboard without manual extra taps", async ({ browser }) => {
  const owner = await signedIn(browser, "featureowner", 80);
  const viewer = await signedIn(browser, "viewer", 81);
  await owner.setExtraHTTPHeaders({ Origin: "http://localhost:5173", "CF-Connecting-IP": "203.0.113.85" });
  await viewer.setExtraHTTPHeaders({ Origin: "http://localhost:5173", "CF-Connecting-IP": "203.0.113.86" });
  const me = (await (await viewer.request.get("/api/me")).json()) as { viewer: { displayPrefs: object } };
  expect(
    (
      await viewer.request.patch("/api/me/preferences", {
        data: { ...me.viewer.displayPrefs, mashAssist: "toggle", srInterval: "off" },
      })
    ).status(),
  ).toBe(200);
  const id: string = await mashId(owner);
  try {
    const page = await newPage(viewer);
    await page.goto(`/@feature_host?view=polls&entry=${id}`);
    expect((await owner.request.post(`/api/mash/${id}/start`, { data: { countdown: false } })).status()).toBe(200);
    const tap = page.locator(".mash-button");
    const mine = page.locator("[data-mash-mine]");
    const count = async (): Promise<number> => Number((await mine.textContent())?.replaceAll(/\D/gu, ""));
    await expect(tap).toContainText("Tap to start");
    await expect(tap).toHaveAttribute("aria-pressed", "false");
    await tap.click();
    await expect(tap).toHaveAttribute("aria-pressed", "true");
    await expect(tap).toContainText("Tap to stop");
    await expect.poll(count).toBeGreaterThan(26);
    await tap.click();
    await expect(tap).toHaveAttribute("aria-pressed", "false");
    await page.waitForTimeout(400);
    const stopped: number = await count();
    await page.waitForTimeout(600);
    expect(await count()).toBe(stopped);
    await tap.focus();
    await page.keyboard.press("Enter");
    await expect(tap).toHaveAttribute("aria-pressed", "true");
    await expect.poll(count).toBeGreaterThan(stopped);
    await page.keyboard.press(" ");
    await expect(tap).toHaveAttribute("aria-pressed", "false");
    await page.waitForTimeout(400);
    const keyboardStopped: number = await count();
    await page.waitForTimeout(600);
    expect(await count()).toBe(keyboardStopped);
    await page.keyboard.press("ArrowRight");
    await expect(tap).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("s");
    await expect(page.locator("#sb-announce-polite")).toContainText("Radahn (your side)");
    expect((await owner.request.post(`/api/mash/${id}/end`, { data: {} })).status()).toBe(200);
  } finally {
    expect((await viewer.request.patch("/api/me/preferences", { data: me.viewer.displayPrefs })).status()).toBe(200);
    await Promise.all([close(owner), close(viewer)]);
  }
});
