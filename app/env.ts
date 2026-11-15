import { createContext } from "react-router";
import type { Locale } from "./i18n";

export interface AppEnv {
  DB: D1Database;
  IMAGES: R2Bucket;
  POLL_ROOMS: DurableObjectNamespace;
  /** One ChannelIngest object per page: the connected channels' activity feed (docs/channel-connections.md). */
  CHANNEL_INGEST: DurableObjectNamespace;
  REQUEST_LIMITER: RateLimit;
  APP_ORIGIN: string;
  APP_ENV?: string;
  DEPLOYED_COMMIT?: string;
  TEST_ACCESS_SECRET?: string;
  TEST_DATABASE_ID?: string;
  // Public legal fields as runtime JSON. Store in a Worker secret.
  LEGAL_DETAILS?: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  INSTAGRAM_CLIENT_ID?: string;
  INSTAGRAM_CLIENT_SECRET?: string;
  KICK_CLIENT_ID?: string;
  KICK_CLIENT_SECRET?: string;
  /** Twitch EventSub webhook secret, 32 to 100 ASCII characters. Without it Twitch channels cannot connect. */
  TWITCH_EVENTSUB_SECRET?: string;
  /** AES-256 keys for stored channel tokens: `id:base64[,id:base64...]`, the first encrypts. See docs/channel-connections.md. */
  CHANNEL_TOKEN_KEYS?: string;
  /** `1` turns channel ingestion off: webhooks are dropped, polls stop, and nobody can connect or listen. */
  CHANNELS_OFF?: string;
  ADMIN_EMAILS?: string;
  // Admin step-up: `off`, `report` (default), or `enforce`. See README and SECURITY.md.
  ADMIN_STEP_UP?: string;
  // Secret for daily visitor hashes. Required to enable the AI counter.
  AI_INTEREST_SALT?: string;
  // Owner notices require this send_email binding and NOTIFY_FROM.
  NOTIFY_EMAIL?: SendEmail;
  // Sender domain must use Cloudflare Email Routing.
  NOTIFY_FROM?: string;
  // Heartbeat URL called after successful cron runs.
  CRON_HEARTBEAT_URL?: string;
}

export interface AppContext {
  env: AppEnv;
  nonce: string;
  responseHeaders: Headers;
  // Root loader locale for entry.server.tsx.
  locale?: Locale;
  requestId?: string;
}

export const appContext = createContext<AppContext>();
