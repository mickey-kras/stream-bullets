import { z } from "zod";
import type { AppEnv } from "../env";
import type { ActivityPlatform, ChannelStatusCode, IngestEvent } from "../lib/activity";
import { channelsOff } from "./channel-tokens.server";
import { kickEvents, twitchEvents } from "./channel-normalize";
import { markWebhookAccepted, markWebhookRejected, resetWebhookHealth } from "./channel-repair.server";
import { kickSupport, twitchSupport } from "./channel-support";
import { kickLiveSignal, twitchLiveSignal } from "./channel-live";
import { connectionForChannel, forgetRoutes, routeFor } from "./channels.server";
import { HttpError, readBody } from "./http.server";
import { callIngest } from "./ingest-call.server";
import { constantTimeEqual, hex } from "./overlay-key.server";

/**
 * Provider webhooks: `POST /hooks/twitch` (EventSub) and `POST /hooks/kick`. Each request is checked on its raw
 * body before anything is parsed: size, signature and freshness. Only then is the channel looked up and the
 * normalized events handed to the page's ingest object, which drops repeated delivery ids. Nothing here logs a
 * body, a header value or a signature.
 */

export const MAX_WEBHOOK_BYTES = 64 * 1024;
/** Deliveries older (or further in the future) than this are refused as possible replays. */
export const MAX_WEBHOOK_AGE_MS = 10 * 60_000;

const MESSAGE_ID = /^[\w.:-]{1,128}$/;
/** Twitch documents its message id as opaque, so any printable ASCII text is valid. */
const TWITCH_MESSAGE_ID = /^[\x21-\x7e]{1,128}$/;

/** For tests: forget the cached routes and the sampled log times. */
export function resetRoutes(): void {
  forgetRoutes();
  loggedAt.clear();
  recentKick.clear();
  resetWebhookHealth();
}

/**
 * Why a webhook was refused, as the rejection log names it. `unavailable` is a server-side failure; `ingest` is a
 * failed call to the ingest object (or its D1 reads).
 */
export type RejectReason = "signature" | "stale" | "size" | "payload" | "method" | "unavailable" | "ingest";

/**
 * A webhook refused by its checks. `forged` marks what only a sender without the provider's key causes (a bad
 * signature, a large or missing body, a wrong method or query); only those count against the per-address limit. A
 * stale or unparsable signed delivery comes from the provider itself and never counts.
 */
export class WebhookRejected extends HttpError {
  constructor(
    status: number,
    message: string,
    readonly reason: RejectReason,
    readonly forged: boolean,
    /** The channel a valid signature named, for the refusal count. Null when the sender is not proven. */
    readonly channelId: string | null = null,
  ) {
    super(status, message);
  }
}

const loggedAt = new Map<string, number>();

/**
 * Logs `event` at most once a minute for each platform, reason and isolate. The reason is part of the key, so a
 * forged flood (`signature`) cannot hide a server-side failure (`unavailable`).
 */
function sampled(event: string, platform: ActivityPlatform, fields: Record<string, string>, now: number): void {
  const key = `${event}:${platform}:${fields.reason ?? ""}`;
  if (now - (loggedAt.get(key) ?? -Infinity) < 60_000) return;
  loggedAt.set(key, now);
  console.warn(event, { platform, ...fields });
}

/**
 * Logs a refused webhook, or a server-side failure (5xx) as `unavailable`, at most once a minute for each
 * platform and isolate: only the platform and a short reason, never a header, a body or a signature.
 */
export function logRejectedWebhook(platform: ActivityPlatform, error: unknown, now: number = Date.now()): void {
  if (error instanceof WebhookRejected) sampled("channel_webhook_rejected", platform, { reason: error.reason }, now);
  else if (error instanceof HttpError && error.status >= 500)
    sampled("channel_webhook_rejected", platform, { reason: "unavailable" }, now);
}

/** Counts a `signature` or `payload` refusal for the watchdog of the ingest object. Other reasons do not count. */
export async function recordRejectedWebhook(
  env: AppEnv,
  platform: ActivityPlatform,
  error: unknown,
  now: number = Date.now(),
): Promise<void> {
  if (!(error instanceof WebhookRejected)) return;
  if (error.reason === "signature" || error.reason === "payload")
    await markWebhookRejected(env, platform, error.channelId, now);
}

/** The raw body, at most MAX_WEBHOOK_BYTES. */
async function webhookBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await readBody(request, MAX_WEBHOOK_BYTES);
  } catch (error: unknown) {
    if (error instanceof HttpError)
      throw new WebhookRejected(error.status, error.message, error.status === 413 ? "size" : "payload", true);
    throw error;
  }
}

function fresh(time: number, now: number): boolean {
  return Number.isFinite(time) && Math.abs(now - time) <= MAX_WEBHOOK_AGE_MS;
}

function requirePost(request: Request): void {
  if (request.method !== "POST") throw new WebhookRejected(405, "Method not allowed.", "method", true);
  if (new URL(request.url).search) throw new WebhookRejected(400, "Invalid query parameters.", "payload", true);
}

/** The ingest object answered with an error or could not be reached: the provider retries on a 503. */
function ingestUnavailable(): WebhookRejected {
  return new WebhookRejected(503, "The activity feed is unavailable.", "ingest", false);
}

/** Calls the ingest object; a rejection or an error answer becomes one sampled `ingest` rejection. */
async function deliverToIngest(
  env: AppEnv,
  streamerId: string,
  path: "event" | "status",
  platform: ActivityPlatform,
  body: string,
): Promise<void> {
  const response = await callIngest(env, streamerId, path, {
    platform,
    init: { method: "POST", headers: { "Content-Type": "application/json" }, body },
  }).catch((): null => null);
  if (!response?.ok) throw ingestUnavailable();
}

async function forward(
  env: AppEnv,
  platform: ActivityPlatform,
  externalId: string,
  deliveryId: string,
  events: IngestEvent[],
  now: number,
): Promise<boolean> {
  const streamerId = await routeFor(env, platform, externalId, now);
  if (!streamerId) return false;
  // The channel id lets the ingest object refuse a delivery that a stale route sent to the wrong page.
  // The provider retries a failed delivery: a 503 asks it to.
  if (events.length > 0)
    await deliverToIngest(
      env,
      streamerId,
      "event",
      platform,
      JSON.stringify({ deliveryId, channelId: externalId, events }),
    );
  // The watchdog reads this: a platform that accepts deliveries is not one that refuses them all.
  await markWebhookAccepted(env, platform, now);
  return true;
}

async function postStatus(
  env: AppEnv,
  platform: ActivityPlatform,
  externalId: string,
  code: ChannelStatusCode,
): Promise<void> {
  const connection = await connectionForChannel(env, platform, externalId);
  if (!connection) return;
  await deliverToIngest(env, connection.streamerId, "status", platform, JSON.stringify({ code }));
}

const twitchId = z.string().regex(/^\d{1,32}$/);

/**
 * The channel that a subscription is for. A raid names it as `to_broadcaster_user_id`, with no
 * `broadcaster_user_id`; each other type of the feed names it as `broadcaster_user_id`.
 */
const twitchCondition = z
  .union([z.object({ broadcaster_user_id: twitchId }), z.object({ to_broadcaster_user_id: twitchId })])
  .transform((condition): { broadcaster_user_id: string } => ({
    broadcaster_user_id:
      "broadcaster_user_id" in condition ? condition.broadcaster_user_id : condition.to_broadcaster_user_id,
  }));

const twitchBodySchema = z.object({
  challenge: z.string().max(1024).optional(),
  subscription: z.object({
    type: z.string().max(100),
    status: z.string().max(64).optional(),
    condition: twitchCondition,
  }),
  event: z.unknown().optional(),
});

/** Twitch revocation reasons and the status code the controls show. */
const TWITCH_REVOCATIONS: Readonly<Record<string, ChannelStatusCode>> = {
  authorization_revoked: "authorization_revoked",
  user_removed: "authorization_revoked",
  notification_failures_exceeded: "delivery_failed",
  version_removed: "subscription_removed",
};

async function confirmTwitchSubscription(
  env: AppEnv,
  broadcaster: string,
  challenge: string | undefined,
): Promise<Response> {
  // Only confirm subscriptions for a connected channel.
  if (!challenge || !(await connectionForChannel(env, "twitch", broadcaster)))
    throw new HttpError(404, "Unknown channel.");
  return new Response(challenge, { headers: { "Content-Type": "text/plain" } });
}

/** The channel of a signed Twitch body that failed the full schema, for the refusal count. */
const twitchChannelSchema = z.object({ subscription: z.object({ condition: twitchCondition }) });

interface TwitchMessage {
  id: string;
  type: string;
  timestamp: string;
  body: Uint8Array<ArrayBuffer>;
}

/** Reads a Twitch message and checks its signature. Size and signature are the only reasons to refuse it here. */
async function signedTwitchMessage(request: Request, secret: string): Promise<TwitchMessage> {
  const id = request.headers.get("Twitch-Eventsub-Message-Id") ?? "";
  const timestamp = request.headers.get("Twitch-Eventsub-Message-Timestamp") ?? "";
  const signature = request.headers.get("Twitch-Eventsub-Message-Signature") ?? "";
  const body = await webhookBody(request);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array([...new TextEncoder().encode(id + timestamp), ...body]);
  const expected = `sha256=${hex(await crypto.subtle.sign("HMAC", key, signed))}`;
  if (!constantTimeEqual(expected, signature)) throw new WebhookRejected(403, "Invalid signature.", "signature", true);
  return { id, type: request.headers.get("Twitch-Eventsub-Message-Type") ?? "", timestamp, body };
}

/** The parsed body of a signed message. A refusal names the channel when the body still shows it. */
function twitchBody(body: Uint8Array<ArrayBuffer>): z.infer<typeof twitchBodySchema> {
  let value: unknown = null;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    // Not JSON: the schema below refuses the null.
  }
  const parsed = twitchBodySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const channel = twitchChannelSchema.safeParse(value);
  const channelId = channel.success ? channel.data.subscription.condition.broadcaster_user_id : null;
  throw new WebhookRejected(400, "Invalid payload.", "payload", false, channelId);
}

/** A signed challenge or notification. Only a notification needs the message id: it is the delivery id. */
async function twitchDelivery(
  env: AppEnv,
  message: TwitchMessage,
  parsed: z.infer<typeof twitchBodySchema>,
  now: number,
): Promise<Response> {
  const broadcaster = parsed.subscription.condition.broadcaster_user_id;
  const challenge = message.type === "webhook_callback_verification";
  // Ingestion is off: confirm no new subscription and drop events.
  if (channelsOff(env) && challenge) throw new HttpError(404, "Unknown channel.");
  if (channelsOff(env) || message.type !== "notification")
    return challenge
      ? await confirmTwitchSubscription(env, broadcaster, parsed.challenge)
      : new Response(null, { status: 204 });
  if (!TWITCH_MESSAGE_ID.test(message.id))
    throw new WebhookRejected(403, "Invalid message id.", "payload", false, broadcaster);
  const { type } = parsed.subscription;
  // The message id is the delivery id of a support event: Twitch sends a notification again with the same id.
  const events: IngestEvent[] = [
    ...twitchEvents(type, parsed.event, now, Date.parse(message.timestamp)),
    ...twitchSupport(type, parsed.event, message.id, now),
    ...twitchLiveSignal(type, parsed.event, now),
  ];
  // A signed notification for an unknown channel gets a 410: Twitch counts failures and revokes the subscription.
  if (!(await forward(env, "twitch", broadcaster, message.id, events, now))) {
    sampled("channel_webhook_unknown_channel", "twitch", {}, now);
    return new Response(null, { status: 410 });
  }
  return new Response(null, { status: 204 });
}

/** Twitch EventSub: HMAC-SHA256 over message id + timestamp + raw body with TWITCH_EVENTSUB_SECRET. */
export async function twitchWebhook(request: Request, env: AppEnv, now: number = Date.now()): Promise<Response> {
  requirePost(request);
  const secret = env.TWITCH_EVENTSUB_SECRET;
  if (!secret || secret.length < 32) throw new HttpError(503, "Twitch is not configured.");
  // No header format is checked before the signature: Twitch documents its message id as opaque.
  const message = await signedTwitchMessage(request, secret);
  if (!fresh(Date.parse(message.timestamp), now)) throw new WebhookRejected(403, "Stale message.", "stale", false);
  const parsed = twitchBody(message.body);
  if (message.type !== "revocation") return twitchDelivery(env, message, parsed, now);
  // Revocations count also while ingestion is off: the controls must show that access ended.
  const status = parsed.subscription.status ?? "";
  await postStatus(
    env,
    "twitch",
    parsed.subscription.condition.broadcaster_user_id,
    Object.hasOwn(TWITCH_REVOCATIONS, status) ? TWITCH_REVOCATIONS[status] : "subscription_removed",
  );
  return new Response(null, { status: 204 });
}

/**
 * The Kick public key, cached per isolate. A failed check fetches it again (a rotation), at most once a minute.
 * Parallel requests share one fetch, and a failed fetch is not tried again for a minute either.
 */
const KICK_KEY_RETRY_MS = 60_000;
let kickKey: { key: CryptoKey; fetchedAt: number } | null = null;
let kickFetch: Promise<CryptoKey> | null = null;
let kickFailedAt: number | null = null;

/** For tests: forget the cached Kick key and any failed fetch. */
export function resetKickKey(): void {
  kickKey = null;
  kickFetch = null;
  kickFailedAt = null;
}

async function fetchKickKey(now: number): Promise<CryptoKey> {
  const response = await fetch("https://api.kick.com/public/v1/public-key", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Kick key answered ${response.status}`);
  const pem = z.object({ data: z.object({ public_key: z.string().max(4096) }) }).parse(await response.json())
    .data.public_key;
  const base64 = pem.replaceAll(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replaceAll(/\s+/g, "");
  const der = Uint8Array.from(atob(base64), (char: string): number => char.codePointAt(0) ?? 0);
  const key = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);
  kickKey = { key, fetchedAt: now };
  return key;
}

/** The current Kick key from one shared fetch. Any failure (network, status, format) is a 503. */
function freshKickKey(now: number): Promise<CryptoKey> {
  if (kickFetch) return kickFetch;
  if (kickFailedAt !== null && now - kickFailedAt < KICK_KEY_RETRY_MS)
    return Promise.reject(new HttpError(503, "Kick is unavailable."));
  kickFetch = fetchKickKey(now)
    .catch((): never => {
      kickFailedAt = now;
      throw new HttpError(503, "Kick is unavailable.");
    })
    .finally((): void => {
      kickFetch = null;
    });
  return kickFetch;
}

async function kickVerify(signed: Uint8Array<ArrayBuffer>, signature: string, now: number): Promise<boolean> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(signature), (char: string): number => char.codePointAt(0) ?? 0);
  } catch {
    return false;
  }
  const algorithm = { name: "RSASSA-PKCS1-v1_5" };
  const cached = kickKey;
  if (cached && (await crypto.subtle.verify(algorithm, cached.key, bytes, signed))) return true;
  if (cached && now - cached.fetchedAt < KICK_KEY_RETRY_MS) return false;
  return crypto.subtle.verify(algorithm, await freshKickKey(now), bytes, signed);
}

/** Kick's timestamp header format is not documented: RFC 3339 and Unix seconds are both accepted. */
function kickTime(value: string): number {
  return /^\d{1,12}$/.test(value) ? Number(value) * 1000 : Date.parse(value);
}

/** Kick: RSA PKCS#1 v1.5 SHA-256 over `messageId.timestamp.body` with Kick's published public key. */
/**
 * Kick message ids this isolate forwarded recently, oldest first. Kick signs the webhooks of every app with one
 * key, and any app can subscribe to any broadcaster: a valid signature does not prove that Kick sent this copy to
 * this app. A repeat is answered without a call to the ingest object and counts against the per-address limit.
 */
const recentKick = new Map<string, true>();
export const MAX_RECENT_KICK = 10_000;

/** Remembers a Kick message id that is forwarded now or was forwarded; past MAX_RECENT_KICK, the oldest id goes. */
export function rememberKickId(id: string): void {
  if (recentKick.size >= MAX_RECENT_KICK) recentKick.delete(recentKick.keys().next().value as string);
  recentKick.set(id, true);
}

export async function kickWebhook(
  request: Request,
  env: AppEnv,
  now: number = Date.now(),
  countRepeat: () => Promise<void> = (): Promise<void> => Promise.resolve(),
): Promise<Response> {
  requirePost(request);
  const id = request.headers.get("Kick-Event-Message-Id") ?? "";
  const timestamp = request.headers.get("Kick-Event-Message-Timestamp") ?? "";
  const signature = request.headers.get("Kick-Event-Signature") ?? "";
  const type = request.headers.get("Kick-Event-Type") ?? "";
  if (!MESSAGE_ID.test(id) || timestamp.length > 64 || signature.length > 1024)
    throw new WebhookRejected(403, "Invalid signature.", "signature", true);
  const body = await webhookBody(request);
  const signed = new Uint8Array([...new TextEncoder().encode(`${id}.${timestamp}.`), ...body]);
  if (!(await kickVerify(signed, signature, now)))
    throw new WebhookRejected(403, "Invalid signature.", "signature", true);
  // For Kick, a stale or unparsable signed copy also counts against the limit: anyone can replay a signed copy.
  if (!fresh(kickTime(timestamp), now)) throw new WebhookRejected(403, "Stale message.", "stale", true);
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new WebhookRejected(400, "Invalid payload.", "payload", true);
  }
  const broadcaster = z
    .object({
      broadcaster: z.object({ user_id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,32}$/)]) }),
    })
    .safeParse(payload);
  if (!broadcaster.success) throw new WebhookRejected(400, "Invalid payload.", "payload", true);
  if (recentKick.has(id)) {
    await countRepeat();
    return new Response(null, { status: 204 });
  }
  // Reserved before the forward, so parallel copies count as repeats. A failed forward releases the id: it answers
  // 5xx, and Kick's retry must get through.
  rememberKickId(id);
  const events: IngestEvent[] = [
    ...kickEvents(type, payload, now),
    ...kickSupport(type, payload, id, now),
    ...kickLiveSignal(type, payload, now),
  ];
  try {
    await forward(env, "kick", String(broadcaster.data.broadcaster.user_id), id, events, now);
  } catch (error: unknown) {
    recentKick.delete(id);
    throw error;
  }
  return new Response(null, { status: 204 });
}
