import { waitUntil } from "cloudflare:workers";
import type { AppEnv } from "../env";
import type { Orientation } from "../lib/overlay-layers";
import { activityAvailable } from "./channel-tokens.server";
import { callIngest } from "./ingest-call.server";

// Notify rooms through `waitUntil`, after response. Log failures without throwing: mutations already
// committed; room alarms resync clients and finish battles.
function callRoom(
  env: AppEnv,
  streamerId: string,
  path: "refresh" | "mash" | "overlay" | "overlay-key",
  body?: unknown,
): void {
  waitUntil(sendToRoom(env, streamerId, path, body));
}

async function sendToRoom(
  env: AppEnv,
  streamerId: string,
  path: "refresh" | "mash" | "overlay" | "overlay-key",
  body?: unknown,
): Promise<void> {
  try {
    const room = env.POLL_ROOMS.get(env.POLL_ROOMS.idFromName(streamerId));
    const init: RequestInit =
      body === undefined
        ? { method: "POST" }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const result = await room.fetch(
      `https://poll-room.internal/${path}?streamerId=${encodeURIComponent(streamerId)}`,
      init,
    );
    if (!result.ok) console.error("live_refresh_failed", { status: result.status });
  } catch (error_: unknown) {
    // Classify the failure without logging exception messages that may contain credentials.
    console.error("live_refresh_failed", {
      cause: error_ instanceof TypeError ? "transport_error" : "unexpected_error",
    });
  }
}

// Asks the streamer's live room to publish a fresh snapshot.
export function notifyRoom(env: AppEnv, streamerId: string): void {
  callRoom(env, streamerId, "refresh");
}

// Asks the live room to reload a Mash Battle the API just started, ended or restarted.
export function notifyMash(env: AppEnv, streamerId: string, id: string): void {
  callRoom(env, streamerId, "mash", { id });
}

// Asks the live room to send the new overlay state, so the OBS page switches at once.
export function notifyOverlay(env: AppEnv, streamerId: string): void {
  callRoom(env, streamerId, "overlay");
}

// Asks the character playground to read the saved layers again. Without the activity feed there is no playground.
export function notifyPlayground(env: AppEnv, streamerId: string): void {
  if (activityAvailable(env)) waitUntil(callActivity(env, streamerId, "playground-config"));
}

// Asks the live room and the activity feed to drop the sockets that came in with the revoked key of one output.
export function notifyOverlayKey(env: AppEnv, streamerId: string, output: Orientation): void {
  callRoom(env, streamerId, "overlay-key", { output });
  waitUntil(callActivity(env, streamerId, "overlay-key", { output }));
}

/** Asks the activity feed to check the page's status: a suspended page closes every activity socket. */
export function notifyActivityPage(env: AppEnv, streamerId: string): void {
  waitUntil(callActivity(env, streamerId, "page-status"));
}

async function callActivity(
  env: AppEnv,
  streamerId: string,
  path: "overlay-key" | "page-status" | "playground-config",
  body?: unknown,
): Promise<void> {
  try {
    const init: RequestInit | undefined =
      body === undefined
        ? undefined
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const result = await callIngest(env, streamerId, path, { init });
    if (!result.ok) console.error("activity_notify_failed", { path, status: result.status });
  } catch (error_: unknown) {
    console.error("activity_notify_failed", {
      path,
      cause: error_ instanceof TypeError ? "transport_error" : "unexpected_error",
    });
  }
}
