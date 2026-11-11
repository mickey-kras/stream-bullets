import { createContext } from "react-router";
import type { Locale } from "./i18n";

export interface AppEnv {
  DB: D1Database;
  IMAGES: R2Bucket;
  POLL_ROOMS: DurableObjectNamespace;
  REQUEST_LIMITER: RateLimit;
  APP_ORIGIN: string;
  /** Runtime JSON for the public legal pages. Store as a Worker secret, never in source. */
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
  ADMIN_EMAILS?: string;
  /** Admin security-key step-up: `off`, `report` (the default) or `enforce`. See README and SECURITY.md. */
  ADMIN_STEP_UP?: string;
  /** Secret key for the AI interest counter's daily visitor hashes. Without it the counter is off. */
  AI_INTEREST_SALT?: string;
  /** Optional send_email binding for owner notices (R13). Email goes out only with NOTIFY_FROM set too. */
  NOTIFY_EMAIL?: SendEmail;
  /** The sender address for owner notices, on a domain with Cloudflare Email Routing. */
  NOTIFY_FROM?: string;
  /** Optional dead man's switch URL (for example a Healthchecks.io check) pinged after each successful cron run. */
  CRON_HEARTBEAT_URL?: string;
}

export interface AppContext {
  env: AppEnv;
  nonce: string;
  responseHeaders: Headers;
  /** The request's language, set by the root loader (app/lib/shell.server.ts) for entry.server.tsx. */
  locale?: Locale;
}

export const appContext = createContext<AppContext>();
