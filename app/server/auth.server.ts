import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { APIError, betterAuth, type BetterAuthOptions, type User } from "better-auth";
import { addOAuthServerContext, createAuthMiddleware, getOAuthState, getSessionFromCtx } from "better-auth/api";
import { signupPolicy } from "../signup-policy";
import { importProviderPhoto } from "./provider-avatar.server";
import { genericOAuth } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../db/auth-schema";
import type { AppContext, AppEnv } from "../env";
import { LOCALES } from "../../db/enums";
import type { Locale } from "../i18n";
import type { Provider, Viewer } from "../types";
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
 * TikTok and Instagram share no email address. Accounts from them get a stable, non-routable placeholder with
 * emailVerified false, so they can never be admins and the app never shows or mails the address (R5). Better Auth's
 * TikTok provider writes its own `{open_id}@tiktok.placeholder.invalid`; the Instagram provider below writes
 * `{id}@instagram.invalid`.
 */
export const PLACEHOLDER_DOMAINS = {
  tiktok: "tiktok.placeholder.invalid",
  instagram: "instagram.invalid",
} as const;

export function placeholderEmail(provider: keyof typeof PLACEHOLDER_DOMAINS, id: string): string {
  return `${id}@${PLACEHOLDER_DOMAINS[provider]}`;
}

/**
 * Better Auth finds an existing user by email before it creates one. So an account from another provider that
 * claims `{id}@instagram.invalid` would block the real Instagram user, who would get "account not linked"
 * (security review finding 9). Only the provider that owns a placeholder domain may create an `.invalid` address.
 */
export function placeholderAllowed(email: string, provider: string | null): boolean {
  const domain: string = email.toLowerCase().split("@").at(-1) ?? "";
  if (!/\.invalid\.?$/u.test(domain)) return true;
  return Object.entries(PLACEHOLDER_DOMAINS).some(([owner, owned]) => owner === provider && owned === domain);
}

/** The provider of the OAuth callback that is creating the user: `/callback/:id` or `/oauth2/callback/:providerId`. */
function signInProvider(context: { params?: Record<string, unknown> } | null): string | null {
  const value: unknown = context?.params?.id ?? context?.params?.providerId;
  return typeof value === "string" ? value : null;
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
function instagramProvider(
  clientId: string,
  clientSecret: string,
): Parameters<typeof genericOAuth>[0]["config"][number] {
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

function reliableProviderEmail(provider: string | undefined, profile: unknown): string | null {
  const parsed = z
    .object({
      email: z.string().trim().toLowerCase().email(),
      email_verified: z.literal(true),
      hd: z.unknown().optional(),
    })
    .safeParse(profile);
  if (!parsed.success) return null;
  const { email, hd } = parsed.data;
  if (provider === "twitch") return email;
  if (provider === "google" && (email.endsWith("@gmail.com") || (typeof hd === "string" && hd.length > 0)))
    return email;
  return null;
}

export function createAuth(env: AppEnv): ReturnType<typeof betterAuth> {
  const origin: string = getOrigin(env);
  const secure: boolean = origin.startsWith("https:");
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
    onAPIError: { errorURL: `${origin}/sign-in` },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/social" || ctx.path === "/sign-in/oauth2") {
          const acceptance = z
            .object({
              accepted: z.literal(true),
              minimumAge: z.literal(signupPolicy.minimumAge),
              termsVersion: z.literal(signupPolicy.termsVersion),
              privacyVersion: z.literal(signupPolicy.privacyVersion),
            })
            .safeParse(ctx.body?.additionalData?.acceptance);
          if (acceptance.success) await addOAuthServerContext({ acceptedAt: Date.now(), ...signupPolicy });
          const displayName: unknown = ctx.body?.additionalData?.displayName;
          if (displayName !== undefined) {
            const parsed = displayNameSchema.safeParse(displayName);
            if (!parsed.success)
              throw new APIError("BAD_REQUEST", {
                code: "INVALID_DISPLAY_NAME",
                message: "Enter a display name with 1 to 40 characters on one line.",
              });
            await addOAuthServerContext({ displayName: parsed.data });
          }
        }
        if (ctx.path !== "/link-social" && ctx.path !== "/unlink-account") return;
        if (ctx.headers?.get("origin") !== origin)
          throw new APIError("FORBIDDEN", { message: "Use this site's account settings." });
        const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
        if (!session) throw new APIError("UNAUTHORIZED", { message: "Sign in to continue." });
        if (Date.now() - session.session.createdAt.getTime() > RECENT_SIGN_IN_MS) {
          throw new APIError("FORBIDDEN", {
            code: "REAUTH_REQUIRED",
            message: "Sign in again before changing login methods.",
          });
        }
        if (ctx.path === "/link-social") {
          if (!configuredProviders(env).includes(ctx.body?.provider) || ctx.body?.idToken) {
            throw new APIError("BAD_REQUEST", {
              message: "Use a configured provider authorization to link an account.",
            });
          }
          await addOAuthServerContext({ linkingSession: session.session.id });
          return;
        }
        const accountId = z.string().min(1).max(128).safeParse(ctx.body?.accountId);
        if (!accountId.success) throw new APIError("BAD_REQUEST", { message: "Choose a linked account." });
        const removed = await env.DB.prepare(`DELETE FROM account WHERE id=? AND user_id=?
          AND EXISTS (SELECT 1 FROM account other WHERE other.user_id=? AND other.id<>?
            AND other.provider_id IN (SELECT value FROM json_each(?))) RETURNING id`)
          .bind(
            accountId.data,
            session.user.id,
            session.user.id,
            accountId.data,
            JSON.stringify(configuredProviders(env)),
          )
          .first();
        if (!removed)
          throw new APIError("BAD_REQUEST", {
            code: "LOGIN_METHOD_REQUIRED",
            message: "Keep at least one login method. Refresh the account list and try again.",
          });
        return ctx.json({ status: true });
      }),
    },
    user: {
      async validateUserInfo({ user, source }, ctx) {
        const reliableEmail: string | null =
          source.method === "oauth" ? reliableProviderEmail(source.oauth?.providerId, source.oauth?.profile) : null;
        if (source.action === "create-user") {
          // Better Auth passes this same validated data object to its create hooks.
          // input:false excludes this field from both client input and provider-map copying.
          user.emailLinkVerified = reliableEmail !== null && reliableEmail === user.email;
          return;
        }
        if (source.action === "sign-in") {
          if (reliableEmail !== null) {
            await env.DB.prepare("UPDATE user SET email_link_verified=1 WHERE id=? AND email=?")
              .bind(user.id, reliableEmail)
              .run();
          }
          return;
        }
        if (source.action !== "link-account") return;
        const state = await getOAuthState();
        if (!state?.link) {
          const existing = await env.DB.prepare("SELECT email,email_verified,email_link_verified FROM user WHERE id=?")
            .bind(user.id)
            .first<{ email: string; email_verified: number; email_link_verified: number }>();
          if (
            user.emailVerified !== true ||
            existing?.email_verified !== 1 ||
            existing.email_link_verified !== 1 ||
            reliableEmail === null ||
            reliableEmail !== existing.email ||
            typeof user.email !== "string" ||
            user.email.trim().toLowerCase() !== existing.email.trim().toLowerCase()
          ) {
            return {
              error: "account_not_linked",
              errorDescription:
                "Verify your email or sign in with the original provider and connect this account in settings.",
            };
          }
          return;
        }
        const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
        if (
          !session ||
          state?.link?.userId !== session.user.id ||
          state.serverContext?.linkingSession !== session.session.id ||
          Date.now() - session.session.createdAt.getTime() > RECENT_SIGN_IN_MS
        ) {
          return { error: "reauth_required", errorDescription: "Sign in again and restart account linking." };
        }
        if (typeof user.email !== "string" || !user.email.trim()) {
          return {
            error: "account_not_linked",
            errorDescription: "Verify an email with this provider before connecting it.",
          };
        }
        const provider: string | undefined = source.oauth?.providerId;
        if (source.method !== "oauth" || !provider || !configuredProviders(env).includes(provider as Provider)) {
          return { error: "account_not_linked", errorDescription: "Choose a configured login provider." };
        }
        // Explicit state proves both identities; email is not the ownership proof in this flow.
        // Replace this request's list, never the shared array or the automatic-linking policy.
        ctx.context.trustedProviders = [...ctx.context.trustedProviders, provider];
      },
      // Profile endpoints write display fields; the OAuth validation gate writes email authority.
      // Clients cannot set these fields through Better Auth endpoints.
      additionalFields: {
        emailLinkVerified: { type: "boolean", required: false, input: false, returned: false, defaultValue: false },
        avatarPreset: { type: "number", required: false, input: false },
        locale: { type: "string", required: false, input: false },
        displayPrefs: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          async before(
            user: User & Record<string, unknown>,
            context: { params?: Record<string, unknown> } | null,
          ): Promise<{ data: User & Record<string, unknown> }> {
            if (!placeholderAllowed(user.email, signInProvider(context))) {
              throw new APIError("BAD_REQUEST", {
                code: "PLACEHOLDER_EMAIL",
                message: "This provider gave an address that StreamBullets cannot use. Sign in with another provider.",
              });
            }
            const state = await getOAuthState();
            if (
              typeof state?.serverContext?.acceptedAt !== "number" ||
              state.serverContext.minimumAge !== signupPolicy.minimumAge ||
              state.serverContext.termsVersion !== signupPolicy.termsVersion ||
              state.serverContext.privacyVersion !== signupPolicy.privacyVersion
            ) {
              throw new APIError("BAD_REQUEST", {
                code: "ELIGIBILITY_REQUIRED",
                message: "Confirm that you are 16 or older and accept the terms before signing up.",
              });
            }
            const name = displayNameSchema.safeParse(state.serverContext.displayName ?? user.name);
            if (!name.success) {
              throw new APIError("BAD_REQUEST", {
                code: "INVALID_DISPLAY_NAME",
                message: "Enter a display name with 1 to 40 characters on one line, then try again.",
              });
            }
            return { data: { ...user, name: name.data } };
          },
          async after(user, context): Promise<void> {
            await env.DB.prepare("UPDATE user SET image=NULL WHERE id=?").bind(user.id).run();
            if (user.image) await importProviderPhoto(env, user.id, user.image, signInProvider(context));
          },
        },
      },
      session: {
        create: {
          async before(session) {
            const state = await getOAuthState();
            const acceptance = z
              .object({
                acceptedAt: z.number().int().positive(),
                minimumAge: z.number().int().positive(),
                termsVersion: z.string().min(1),
                privacyVersion: z.string().min(1),
              })
              .safeParse(state?.serverContext);
            if (acceptance.success) {
              await env.DB.prepare(`INSERT INTO signup_acceptance(user_id,accepted_at,minimum_age,terms_version,privacy_version)
                VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO NOTHING`)
                .bind(
                  session.userId,
                  acceptance.data.acceptedAt,
                  acceptance.data.minimumAge,
                  acceptance.data.termsVersion,
                  acceptance.data.privacyVersion,
                )
                .run();
            }
            return { data: session };
          },
        },
      },
    },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              mapProfileToUser: (profile) => ({
                email: profile.email?.trim().toLowerCase(),
                emailVerified: profile.email_verified === true,
              }),
            },
          }
        : {}),
      ...(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET
        ? {
            twitch: {
              clientId: env.TWITCH_CLIENT_ID,
              clientSecret: env.TWITCH_CLIENT_SECRET,
              mapProfileToUser: (profile) => ({
                email: profile.email?.trim().toLowerCase(),
                emailVerified: profile.email_verified === true,
              }),
            },
          }
        : {}),
      ...(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET
        ? {
            tiktok: { clientKey: env.TIKTOK_CLIENT_KEY, clientSecret: env.TIKTOK_CLIENT_SECRET },
          }
        : {}),
    },
    plugins:
      env.INSTAGRAM_CLIENT_ID && env.INSTAGRAM_CLIENT_SECRET
        ? [genericOAuth({ config: [instagramProvider(env.INSTAGRAM_CLIENT_ID, env.INSTAGRAM_CLIENT_SECRET)] })]
        : [],
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: false,
        trustedProviders: [],
        requireLocalEmailVerified: true,
        allowDifferentEmails: true,
        allowUnlinkingAll: false,
        updateUserInfoOnLink: false,
      },
    },
    disabledPaths: ["/update-user", "/oauth2/link"],
    session: {
      cookieCache: { enabled: false },
    },
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      // Better Auth otherwise prepends __Secure- even to a custom __Host- name.
      useSecureCookies: false,
      cookiePrefix: secure ? "__Secure-stream-bullets" : "stream-bullets",
      defaultCookieAttributes: { secure },
      cookies: {
        session_token: { name: `${secure ? "__Host-" : ""}stream-bullets.session_token` },
      },
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

/** The signed-in viewer and the id of their session (for the per-session admin step-up). Server only. */
export async function getViewerSession(
  request: Request,
  context: AppContext,
): Promise<{ viewer: Viewer; sessionId: string } | null> {
  const { response, headers } = await createAuth(context.env).api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
    returnHeaders: true,
  });
  for (const cookie of headers.getSetCookie()) {
    context.responseHeaders.append("Set-Cookie", cookie);
  }
  if (!response) return null;
  return { viewer: viewerValue(response.user), sessionId: response.session.id };
}

/** How recent a sign-in must be for an irreversible account action (deleting the account). */
export const RECENT_SIGN_IN_MS = 10 * 60 * 1000;

/**
 * Refuses an irreversible action on a session that did not start within `RECENT_SIGN_IN_MS`. A stolen session
 * cookie then cannot delete the account: that needs a fresh sign-in with the provider. Answers 403 with the code
 * `reauth_required`, so the client can offer to sign in again.
 */
export async function requireRecentSignIn(request: Request, env: AppEnv, now: number = Date.now()): Promise<void> {
  const result = await createAuth(env).api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });
  if (!result) throw new HttpError(401, "Sign in to continue.");
  if (now - result.session.createdAt.getTime() > RECENT_SIGN_IN_MS)
    throw new HttpError(403, "Sign in again to delete your account.", "reauth_required");
}

export async function getViewer(request: Request, context: AppContext): Promise<Viewer | null> {
  return (await getViewerSession(request, context))?.viewer ?? null;
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
