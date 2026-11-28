import { createHash, randomUUID } from "node:crypto";
import { newPage, close, test, expect } from "./coverage";
import { runSql, signedIn } from "./fixtures";
import { clientIp } from "./client-ips";
import { CHARACTERS_CELL, FEATURE_HOST, defaultLayers, layersSql, noKeysSql } from "./grid-helpers";

// The credit of a featured topic: the owner features a viewer topic in Live, and its author gets an alert on stream
// and a row in Activity.
const OWNER_IP = clientIp("topic-credit", 190);
const OBS_IP = clientIp("topic-credit", 191);

const TOPIC: string = randomUUID();
const TITLE = "Credit the author";
const KEY: string = "T".repeat(43);

/** The topic of a viewer, the newest of the page, so Live lists it first. */
const topicSql = `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed)
  SELECT '${TOPIC}',${FEATURE_HOST},id,'topic','${TITLE}','','','[]',${Date.now() + 120_000},0 FROM user WHERE name='viewer';`;

/**
 * The alerts layer on stream and the topic layer on the grid, off stream, in the horizontal output. The output shows
 * Twitch chat only: a topic credit still shows there.
 */
const creditLayers: string = layersSql({
  alerts: { enabled: true },
  items: { topic: { enabled: false } },
  cells: { horizontal: { alerts: { c: 8, r: 0, w: 16, h: 3 }, topic: CHARACTERS_CELL } },
  twitchOnly: { horizontal: true },
});

const keySql = `INSERT INTO overlay_keys (streamer_id, output, key_hash, created_at)
  VALUES (${FEATURE_HOST}, 'horizontal', '${createHash("sha256").update(KEY).digest("hex")}', 0)
  ON CONFLICT(streamer_id) DO UPDATE SET output='horizontal', key_hash=excluded.key_hash, created_at=0,
    other_key_hash=NULL, other_created_at=NULL;`;

test.afterAll(async () => {
  await runSql("topic-credit-cleanup", [`DELETE FROM entries WHERE id='${TOPIC}';`, defaultLayers, noKeysSql]);
});

test("a topic that the owner features in Live credits its author on the overlay and in Activity", async ({
  browser,
}) => {
  await runSql("topic-credit-setup", [topicSql, creditLayers, keySql]);
  const owner = await signedIn(browser, "featureowner", OWNER_IP);
  // A mute discards each alert that waits from an earlier spec. Then the alerts play again.
  for (const on of [true, false])
    expect((await owner.request.post("/api/overlay/alerts", { data: { op: "mute", on } })).status()).toBe(200);
  const obs = await newPage(browser, {
    viewport: { width: 1280, height: 720 },
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${OBS_IP}` },
  });
  await obs.goto(`/@feature_host/overlay?key=${KEY}`);
  const live = await newPage(owner);
  await live.setViewportSize({ width: 1440, height: 1000 });
  await live.goto("/tools?view=live");
  const activity = live.locator('[data-live-part="activity"]');
  await expect(activity.getByRole("heading", { level: 2, name: "Activity" })).toBeVisible();

  await live
    .locator('[data-live-part="topics"]')
    .getByRole("button", { name: `Feature on stream: ${TITLE}` })
    .click();
  // The banner of the Featured topic rule shows the author on the output, which shows only Twitch chat.
  const banner = obs.locator('[data-overlay-alert="topic"]');
  await expect(banner.locator("[data-alert-title]")).toHaveText("viewer topic on stream");
  await expect(banner.locator("[data-alert-meta]")).toHaveText("Thank you");
  await expect(banner.locator("[data-alert-test]")).toHaveCount(0);
  // Activity has the row of the credit, from StreamBullets, with Replay.
  const row = activity.locator(`[data-activity-row^="direct:topic:${TOPIC}:"]`);
  await expect(row).toContainText("viewer topic on stream");
  await expect(row).toContainText("StreamBullets ·");
  await expect(row.getByRole("button", { name: "Replay: viewer topic on stream" })).toBeVisible();
  await expect(activity.locator("[data-live-alert-now]")).toContainText("On stream now: viewer topic on stream");
  await Promise.all([close(owner), close(obs)]);
});
