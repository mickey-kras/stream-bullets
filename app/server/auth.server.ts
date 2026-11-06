import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { APIError, betterAuth, type BetterAuthOptions, type User } from "better-auth";
import { genericOAuth } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../db/auth-schema";
import type { AppContext, AppEnv } from "../env";
import { LOCALES } from "../../db/enums";
import type { Locale, Provider, Viewer } from "../types";
import { z } from "zod";
import { getOrigin, HttpError } from "./http.server";
import { displayNameSchema, readDisplayPrefs } from "./validation";

export { isPlaceholderEmail } from "./validation";

/** Sign-in providers in button order. Each needs both values of its credential pair (plan section 5). */
const providerCredentials = (env: AppEnv): readonly (readonly [Provider, string | undefined, string | undefined])[] => [
  ["google", env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET],
  ["tiktok", env.TIKTOK_CLIENT_KEY, env.TIKTOK_CLIENT_SECRET],
  ["twitch", env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET],
  ["instagram", env.INSTAGRAM_CLIENT_ID, env.INSTAGRAM_CLIENT_SECRET],
];

/** The providers whose credential pair is set. A half-set pair is a configuration error (503). */
export function configuredProviders(env: AppEnv): Provider[] {
  const providers: Provider[] = [];
  for (const [provider, id, secret] of providerCredentials(env)) {
    if (Boolean(id) !== Boolean(secret)) {
      throw new HttpError(503, `Both ${provider} OAuth credentials must be configured.`);
    }
    if (id && secret) providers.push(provider);
  }
  return providers;
}

/**
 * TikTok and Instagram share no email address. Accounts from them get a stable, non-routable placeholder
 * (`{id}@tiktok.invalid`, `{id}@instagram.invalid`, R5) with emailVerified false, so they can never be admins
 * and the app never shows or mails the address.
 */
export function placeholderEmail(provider: "tiktok" | "instagram", id: string): string {
  return `${id}@${provider}.invalid`;
}

const INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const INSTAGRAM_ME_URL = "https://graph.instagram.com/me?fields=user_id,username,name";

const instagramTokenSchema = z.union([
  z.object({ access_token: z.string().min(1), user_id: z.union([z.string(), z.number()]).optional() }),
  z.object({
    data: z
      .array(z.object({ access_token: z.string().min(1), user_id: z.union([z.string(), z.number()]).optional() }))
      .min(1),
  }),
]);
const instagramProfileSchema = z.object({
  user_id: z.union([z.string(), z.number()]).optional(),
  id: z.union([z.string(), z.number()]).optional(),
  username: z.string().optional(),
  name: z.string().optional(),
});

/**
 * "Continue with Instagram": Instagram API with Instagram Login (professional accounts only, needs Meta app
 * review). It is plain OAuth 2 with a form-post token exchange whose answer may be wrapped in `data[]`.
 */
function instagramProvider(clientId: string, clientSecret: string): Parameters<typeof genericOAuth>[0]["config"][number] {
  return {
    providerId: "instagram",
    name: "Instagram",
    clientId,
    clientSecret,
    authorizationUrl: "https://www.instagram.com/oauth/authorize",
    tokenUrl: INSTAGRAM_TOKEN_URL,
    scopes: ["instagram_business_basic"],
    pkce: false,
    authentication: "post",
    async getToken({ code, redirectURI }) {
      const response = await fetch(INSTAGRAM_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          redirect_uri: redirectURI,
          code,
        }),
      });
      if (!response.ok) throw new APIError("UNAUTHORIZED", { message: "Instagram sign-in failed." });
      const body = instagramTokenSchema.parse(await response.json());
      const token = "data" in body ? body.data[0] : body;
      return { accessToken: token.access_token, tokenType: "bearer" };
    },
    async getUserInfo(tokens) {
      if (!tokens.accessToken) return null;
      const response = await fetch(INSTAGRAM_ME_URL, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
      if (!response.ok) return null;
      const profile = instagramProfileSchema.parse(await response.json());
      const id = String(profile.user_id ?? profile.id ?? "");
      if (!id) return null;
      return {
        id,
        name: profile.name || profile.username || "",
        email: placeholderEmail("instagram", id),
        emailVerified: false,
      };
    },
  };
}

export function createAuth(env: AppEnv): ReturnType<typeof betterAuth> {
  const origin: string = getOrigin(env);
  if (typeof env.BETTER_AUTH_SECRET !== "string" || env.BETTER_AUTH_SECRET.length < 32) {
    throw new HttpError(503, "Authentication secret is not configured.");
  }
  configuredProviders(env);
  const options: BetterAuthOptions = {
    appName: "StreamBullets",
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [origin],
    database: drizzleAdapter(drizzle(env.DB), { provider: "sqlite", schema, transaction: false }),
    user: {
      // Read with the session, never accepted from sign-up or Better Auth's own endpoints (input: false).
      // Our endpoints write them: PATCH /api/profile, /api/me/locale and /api/me/preferences.
      additionalFields: {
        avatarPreset: { type: "number", required: false, input: false },
        locale: { type: "string", required: false, input: false },
        displayPrefs: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          async before(user: User & Record<string, unknown>): Promise<{ data: User & Record<string, unknown> }> {
            const name = displayNameSchema.safeParse(user.name);
            if (!name.success) {
              throw new APIError("BAD_REQUEST", {
                code: "INVALID_DISPLAY_NAME",
                message: "Set your provider display name to 1 to 40 characters on one line, then sign in again.",
              });
            }
            return { data: { ...user, name: name.data } };
          },
        },
      },
    },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
          }
        : {}),
      ...(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET
        ? {
            twitch: { clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET },
          }
        : {}),
      ...(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET
        ? {
            tiktok: {
              clientKey: env.TIKTOK_CLIENT_KEY,
              clientSecret: env.TIKTOK_CLIENT_SECRET,
              // TikTok shares no email: keep the same placeholder pattern as Instagram.
              mapProfileToUser: (profile: { data: { user: { open_id: string } } }) => ({
                email: placeholderEmail("tiktok", profile.data.user.open_id),
                emailVerified: false,
              }),
            },
          }
        : {}),
    },
    plugins:
      env.INSTAGRAM_CLIENT_ID && env.INSTAGRAM_CLIENT_SECRET
        ? [genericOAuth({ config: [instagramProvider(env.INSTAGRAM_CLIENT_ID, env.INSTAGRAM_CLIENT_SECRET)] })]
        : [],
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
    },
    disabledPaths: ["/link-social", "/unlink-account", "/update-user"],
    session: {
      cookieCache: { enabled: false },
    },
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: origin.startsWith("https:"),
      cookiePrefix: "stream-bullets",
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    logger: {
      level: "warn",
      log(level: "debug" | "info" | "warn" | "error"): void {
        if (level === "error") console.error("authentication_error");
        else if (level === "warn") console.warn("authentication_warning");
      },
    },
  };
  return betterAuth(options);
}

export async function getViewer(request: Request, context: AppContext): Promise<Viewer | null> {
  const { response, headers } = await createAuth(context.env).api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
    returnHeaders: true,
  });
  for (const cookie of headers.getSetCookie()) {
    context.responseHeaders.append("Set-Cookie", cookie);
  }
  if (!response) return null;
  return viewerValue(response.user as User & Record<string, unknown>);
}

/** Shapes the signed-in account for the client. */
export function viewerValue(account: User & Record<string, unknown>): Viewer {
  const avatar: string = `/images/avatar/${encodeURIComponent(account.id)}`;
  const preset = account.avatarPreset;
  const locale = account.locale;
  return {
    id: account.id,
    name: account.name,
    avatar: account.image === avatar ? avatar : null,
    avatarPreset: typeof preset === "number" && Number.isInteger(preset) && preset >= 0 && preset <= 17 ? preset : null,
    locale: typeof locale === "string" && (LOCALES as readonly string[]).includes(locale) ? (locale as Locale) : null,
    displayPrefs: readDisplayPrefs(account.displayPrefs),
  };
}
