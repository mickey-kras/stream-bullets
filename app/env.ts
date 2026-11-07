import { createContext } from "react-router";

export interface AppEnv {
  DB: D1Database;
  IMAGES: R2Bucket;
  POLL_ROOMS: DurableObjectNamespace;
  REQUEST_LIMITER: RateLimit;
  APP_ORIGIN: string;
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
}

export interface AppContext {
  env: AppEnv;
  nonce: string;
  responseHeaders: Headers;
}

export const appContext = createContext<AppContext>();
