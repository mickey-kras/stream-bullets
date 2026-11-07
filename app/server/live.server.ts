import type { AppEnv } from "../env";

/**
 * Calls the streamer's live room. Failures are logged and never thrown: the mutation is committed,
 * and the room alarm resynchronizes disconnected clients and ends battles on time.
 */
async function callRoom(
  env: AppEnv,
  streamerId: string,
  path: "refresh" | "mash" | "overlay",
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
export async function notifyRoom(env: AppEnv, streamerId: string): Promise<void> {
  await callRoom(env, streamerId, "refresh");
}

/** Asks the live room to reload a Mash Battle the API just started, ended or restarted. */
export async function notifyMash(env: AppEnv, streamerId: string, id: string): Promise<void> {
  await callRoom(env, streamerId, "mash", { id });
}

/** Asks the live room to send the new overlay state, so the OBS page switches at once. */
export async function notifyOverlay(env: AppEnv, streamerId: string): Promise<void> {
  await callRoom(env, streamerId, "overlay");
}
