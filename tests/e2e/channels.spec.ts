import { createHmac, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { close, newPage, type Page } from "./coverage";
import { clientIp } from "./client-ips";
import { accounts, origin, runSql, signedIn } from "./fixtures";

const channelsSchema = z.object({
  channels: z.array(z.object({
    platform: z.string(),
    available: z.boolean(),
    connection: z.object({ status: z.string(), code: z.string().nullable() }).nullable(),
  })),
});
const snapshotSchema = z.object({ type: z.literal("snapshot"), events: z.array(z.object({ messageId: z.string() })) });

async function webhook(
  request: APIRequestContext,
  body: string,
  options: { id?: string; timestamp?: string; signature?: string; type?: string } = {},
): Promise<number> {
  const env: string = await readFile(".wrangler/e2e/.env", "utf8");
  const secret: string | undefined = /^TWITCH_EVENTSUB_SECRET=(.+)$/m.exec(env)?.[1];
  if (!secret) throw new Error("Missing local webhook secret.");
  const id: string = options.id ?? randomUUID();
  const timestamp: string = options.timestamp ?? new Date().toISOString();
  const signature: string = options.signature ?? `sha256=${createHmac("sha256", secret).update(id + timestamp + body).digest("hex")}`;
  return (await request.post("/hooks/twitch", {
    data: body,
    headers: {
      "Content-Type": "application/json",
      "Twitch-Eventsub-Message-Id": id,
      "Twitch-Eventsub-Message-Timestamp": timestamp,
      "Twitch-Eventsub-Message-Signature": signature,
      "Twitch-Eventsub-Message-Type": options.type ?? "notification",
    },
  })).status();
}

async function subscribe(page: Page, path: string): Promise<z.infer<typeof snapshotSchema>> {
  const snapshot: unknown = await page.evaluate(async (url: string): Promise<unknown> => {
    return new Promise<unknown>((resolve, reject) => {
      const socket: WebSocket = new WebSocket(url);
      socket.addEventListener("message", (event: MessageEvent<string>): void => {
        try {
          resolve(JSON.parse(event.data) as unknown);
        } catch {
          reject(new Error("Invalid activity snapshot."));
        }
      }, { once: true });
      socket.addEventListener("error", () => reject(new Error("Activity WebSocket rejected.")), { once: true });
      Object.assign(window, { activitySocket: socket });
    });
  }, `${origin.replace("http:", "ws:")}${path}`);
  return snapshotSchema.parse(snapshot);
}

test("channel connections enforce owner, fresh sign-in, origin, and page status", async ({ playwright, request }) => {
  const sessions = await accounts();
  const contexts: APIRequestContext[] = await Promise.all(["otherowner", "viewer", "frozenowner"].map(async (role: string, index: number): Promise<APIRequestContext> =>
    playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: {
      Origin: origin, "CF-Connecting-IP": `192.0.2.${clientIp("channels", 1 + index)}`,
      Cookie: `stream-bullets.session_token=${sessions[role].cookie}`,
    } }),
  ));
  const [owner, viewer, frozen] = contexts;
  const id: string = sessions.otherowner.id;
  try {
    expect((await request.get("/api/channels")).status()).toBe(401);
    expect((await viewer.get("/api/channels")).status()).toBe(404);
    const channels = channelsSchema.parse(await (await owner.get("/api/channels")).json());
    expect(channels.channels.find((channel) => channel.platform === "kick")).toMatchObject({ available: true, connection: null });
    expect((await frozen.post("/api/channels/kick/connect", { data: {} })).status()).toBe(423);
    expect((await owner.post("/api/channels/kick/connect", { data: { unexpected: true } })).status()).toBe(400);
    expect((await owner.post("/api/channels/kick/connect", { data: {}, headers: { Origin: "https://other.example" } })).status()).toBe(403);
    const connected = await owner.post("/api/channels/kick/connect", { data: {} });
    expect(connected.status()).toBe(200);
    const { authorizeUrl } = z.object({ authorizeUrl: z.url() }).parse(await connected.json());
    const authorization: URL = new URL(authorizeUrl);
    expect(authorization.hostname).toBe("id.kick.com");
    expect(authorization.searchParams.get("state")).toBeTruthy();
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect((await owner.delete("/api/channels/kick")).status()).toBe(404);
    await runSql("channels-stale", [`UPDATE session SET created_at=${Date.now() - 11 * 60_000} WHERE user_id='${id}';`]);
    const stale = await owner.post("/api/channels/kick/reconnect", { data: {} });
    expect(stale.status()).toBe(403);
    expect(await stale.json()).toMatchObject({ code: "reauth_required" });
    expect((await owner.get("/api/activity/other_host")).status()).toBe(426);
    expect((await viewer.get("/api/activity/other_host", { headers: { Upgrade: "websocket" } })).status()).toBe(403);
    const connectionId: string = randomUUID();
    const now: number = Date.now();
    await runSql("channels-http-webhook", [
      `INSERT INTO channel_connections(id,streamer_id,platform,external_id,display_name,scopes,status,status_code,created_at,updated_at) SELECT '${connectionId}',id,'twitch','987654320','Test channel','','active',NULL,${now},${now} FROM streamers WHERE handle='other_host';`,
    ]);
    try {
      const challenge: string = JSON.stringify({ challenge: "verify-test-channel", subscription: { type: "channel.chat.message", condition: { broadcaster_user_id: "987654320" } } });
      expect(await webhook(owner, challenge, { type: "webhook_callback_verification" })).toBe(200);
      expect(await webhook(owner, challenge, { signature: `sha256=${"0".repeat(64)}` })).toBe(403);
      expect(await webhook(owner, challenge, { timestamp: new Date(now - 11 * 60_000).toISOString() })).toBe(403);
      const unknown: string = JSON.stringify({ subscription: { type: "channel.chat.message", condition: { broadcaster_user_id: "987654319" } } });
      expect(await webhook(owner, unknown)).toBe(410);
      const revoked: string = JSON.stringify({ subscription: { type: "channel.chat.message", status: "authorization_revoked", condition: { broadcaster_user_id: "987654320" } } });
      expect(await webhook(owner, revoked, { type: "revocation" })).toBe(204);
      const connections = channelsSchema.parse(await (await owner.get("/api/channels")).json());
      expect(connections.channels.find((channel) => channel.platform === "twitch")?.connection).toMatchObject({ status: "needs_reauth", code: "authorization_revoked" });
    } finally {
      await runSql("channels-http-cleanup", [`DELETE FROM channel_connections WHERE id='${connectionId}';`]);
    }
  } finally {
    await runSql("channels-fresh", [`UPDATE session SET created_at=${Date.now()} WHERE user_id='${id}';`]);
    await Promise.all(contexts.map((context: APIRequestContext) => context.dispose()));
  }
});

test("signed webhooks reach the owner activity feed once and reject forged or stale deliveries", async ({ browser }) => {
  const owner = await signedIn(browser, "newcomer", clientIp("channels", 4));
  const viewer = await signedIn(browser, "viewer", clientIp("channels", 5));
  const sessions = await accounts();
  const streamerId: string = randomUUID();
  const handle: string = `webhook_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const connectionId: string = randomUUID();
  const broadcaster: string = String(randomInt(1_000_000, 1_000_000_000));
  const messageId: string = randomUUID();
  const deliveryId: string = randomUUID();
  const now: number = Date.now();
  const body: string = JSON.stringify({
    subscription: { type: "channel.chat.message", condition: { broadcaster_user_id: broadcaster } },
    event: {
      broadcaster_user_id: broadcaster, chatter_user_id: "1234", chatter_user_login: "test_chatter",
      chatter_user_name: "Test chatter", message_id: messageId, message: { text: "A real webhook delivery", fragments: [] },
    },
  });
  await runSql("channels-webhook", [
    `INSERT INTO streamers(id,owner_id,handle,name,about,revision) VALUES ('${streamerId}','${sessions.newcomer.id}','${handle}','Webhook host','A webhook test community.',0);`,
    `INSERT INTO channel_connections(id,streamer_id,platform,external_id,display_name,scopes,status,status_code,created_at,updated_at) VALUES ('${connectionId}','${streamerId}','twitch','${broadcaster}','Test channel','','active',NULL,${now},${now});`,
  ]);
  try {
    expect((await owner.request.get(`/api/activity/${handle}`)).status()).toBe(426);
    expect((await viewer.request.get(`/api/activity/${handle}`, { headers: { Upgrade: "websocket" } })).status()).toBe(403);
    const page: Page = await newPage(owner);
    await page.goto("/streamers");
    const frames: string[] = [];
    page.on("websocket", (socket) => socket.on("framereceived", (frame) => {
      if (frame.payload !== "pong") frames.push(String(frame.payload));
    }));
    await subscribe(page, `/api/activity/${handle}`);
    expect(await webhook(owner.request, body, { signature: `sha256=${"0".repeat(64)}` })).toBe(403);
    expect(await webhook(owner.request, body, { timestamp: new Date(now - 11 * 60_000).toISOString() })).toBe(403);
    expect(await webhook(owner.request, body, { id: deliveryId })).toBe(204);
    await expect.poll(() => frames.filter((frame) => {
      const value: unknown = JSON.parse(frame);
      return z.object({ type: z.literal("event"), event: z.object({ messageId: z.literal(messageId) }) }).safeParse(value).success;
    }).length).toBe(1);
    expect(await webhook(owner.request, body, { id: deliveryId })).toBe(204);
    const replay: Page = await newPage(owner);
    await replay.goto("/streamers");
    const snapshot = await subscribe(replay, `/api/activity/${handle}`);
    expect(snapshot.events.filter((event) => event.messageId === messageId)).toHaveLength(1);
    // The pong follows any queued duplicate frame on the original socket.
    await page.evaluate(async (): Promise<void> => {
      const socket: WebSocket = (window as unknown as { activitySocket: WebSocket }).activitySocket;
      await new Promise<void>((resolve) => {
        const onMessage = (event: MessageEvent<string>): void => {
          if (event.data !== "pong") return;
          socket.removeEventListener("message", onMessage);
          resolve();
        };
        socket.addEventListener("message", onMessage);
        socket.send("ping");
      });
    });
    expect(frames.filter((frame) => {
      const value: unknown = JSON.parse(frame);
      return z.object({ type: z.literal("event"), event: z.object({ messageId: z.literal(messageId) }) }).safeParse(value).success;
    })).toHaveLength(1);
    const revocation: string = JSON.stringify({ subscription: { type: "channel.chat.message", status: "authorization_revoked", condition: { broadcaster_user_id: broadcaster } } });
    expect(await webhook(owner.request, revocation, { type: "revocation" })).toBe(204);
    const channels = channelsSchema.parse(await (await owner.request.get("/api/channels")).json());
    expect(channels.channels.find((channel) => channel.platform === "twitch")?.connection).toMatchObject({ status: "needs_reauth", code: "authorization_revoked" });
  } finally {
    await close(owner);
    await close(viewer);
    await runSql("channels-cleanup", [`DELETE FROM streamers WHERE id='${streamerId}';`]);
  }
});
