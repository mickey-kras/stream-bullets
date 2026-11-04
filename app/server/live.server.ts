import type { AppEnv } from "../env";

/** Asks the streamer's live room to publish a fresh snapshot. Failures are logged and never thrown. */
export async function notifyRoom(env: AppEnv, streamerId: string): Promise<void> {
  try {
    const room = env.POLL_ROOMS.get(env.POLL_ROOMS.idFromName(streamerId));
    const result = await room.fetch(`https://poll-room.internal/refresh?streamerId=${encodeURIComponent(streamerId)}`, {
      method: "POST",
    });
    if (!result.ok) console.error("live_refresh_failed", { status: result.status });
  } catch (error_: unknown) {
    // The mutation is committed; the room alarm resynchronizes disconnected clients.
    // Classify the failure without logging exception messages that may contain credentials.
    console.error("live_refresh_failed", {
      cause: error_ instanceof TypeError ? "transport_error" : "unexpected_error",
    });
  }
}
