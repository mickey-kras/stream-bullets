import type { AppEnv } from "../env";
import { HttpError } from "./http.server";

export const TEST_ORIGIN = "https://test.streambullets.com";

// Configuration is checked on every request and cron, before any external effects.
export function validateTestEnvironment(env: AppEnv): void {
  if (env.APP_ENV !== "test") {
    if (env.TEST_ACCESS_SECRET !== undefined || env.TEST_DATABASE_ID !== undefined)
      throw new HttpError(503, "Test access is forbidden outside the test environment.");
    return;
  }
  if (
    env.APP_ORIGIN !== TEST_ORIGIN ||
    !env.TEST_ACCESS_SECRET || new TextEncoder().encode(env.TEST_ACCESS_SECRET).length < 32 ||
    typeof env.BETTER_AUTH_SECRET !== "string" || env.BETTER_AUTH_SECRET.length < 32 ||
    env.BETTER_AUTH_SECRET === env.TEST_ACCESS_SECRET ||
    !env.TEST_DATABASE_ID || !/^[a-f0-9-]{36}$/u.test(env.TEST_DATABASE_ID) ||
    env.ADMIN_EMAILS !== "admin@example.test" ||
    env.NOTIFY_EMAIL || env.NOTIFY_FROM || env.CRON_HEARTBEAT_URL ||
    env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_SECRET || env.TWITCH_CLIENT_ID || env.TWITCH_CLIENT_SECRET ||
    env.TIKTOK_CLIENT_KEY || env.TIKTOK_CLIENT_SECRET || env.INSTAGRAM_CLIENT_ID || env.INSTAGRAM_CLIENT_SECRET
  ) throw new HttpError(503, "Test environment is not isolated.");
}
