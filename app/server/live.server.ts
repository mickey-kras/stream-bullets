import { waitUntil } from "cloudflare:workers";
import type { AppEnv } from "../env";

/**
 * Calls the streamer's live room after the response is sent (`waitUntil`), so a mutation never waits for the room
 * to query D1 and broadcast. Failures are logged and never thrown: the mutation is committed, and the room alarm
 * resynchronizes disconnected clients and ends battles on time.
 */
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

/** Asks the streamer's live room to publish a fresh snapshot. */
export function notifyRoom(env: AppEnv, streamerId: string): void {
  callRoom(env, streamerId, "refresh");
}

/** Asks the live room to reload a Mash Battle the API just started, ended or restarted. */
export function notifyMash(env: AppEnv, streamerId: string, id: string): void {
  callRoom(env, streamerId, "mash", { id });
}

/** Asks the live room to send the new overlay state, so the OBS page switches at once. */
export function notifyOverlay(env: AppEnv, streamerId: string): void {
  callRoom(env, streamerId, "overlay");
}

/** Asks the live room to drop the sockets that came in with a revoked overlay key. */
export function notifyOverlayKey(env: AppEnv, streamerId: string): void {
  callRoom(env, streamerId, "overlay-key");
}
