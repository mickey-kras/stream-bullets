import { generateKeyPairSync, sign } from "node:crypto";
import { makeSignature, symmetricDecrypt } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { AppContext, AppEnv } from "../app/env";
import { isAdmin } from "../app/server/access.server";
import {
  configuredProviders,
  createAuth,
  getViewer,
  isPlaceholderEmail,
  placeholderAllowed,
  placeholderEmail,
} from "../app/server/auth.server";
import { signupPolicy } from "../app/signup-policy";
import type { Viewer } from "../app/types";
import type { Provider } from "../app/types";
import { applyMigrations, createTestDatabase, migrationFiles } from "./helpers/database";

const secret: string = "test-only-secret-71cbbad72594467d8bcd83e4e0f42d04";
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let env: AppEnv;
let oauthClient: number = 20;

function context(): AppContext {
  return { env, nonce: "test-nonce", responseHeaders: new Headers() };
}

async function signedRequest(token: string): Promise<Request> {
  const signature: string = await makeSignature(token, secret);
  return new Request(`${env.APP_ORIGIN}/`, {
    headers: { cookie: `__Host-stream-bullets.session_token=${encodeURIComponent(`${token}.${signature}`)}` },
  });
}

async function seedSession(
  id: string,
  options: { expiresAt?: number; updatedAt?: number; image?: string } = {},
): Promise<string> {
  const now: number = Date.now();
  const token: string = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,email_verified,image,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).bind(id, "Viewer", `${id}@example.test`, 1, options.image ?? null, now, now),
    env.DB.prepare(
      "INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      token,
      id,
      options.expiresAt ?? now + 604_800_000,
      now - 172_800_000,
      options.updatedAt ?? now,
      "192.0.2.1",
      "private-agent",
    ),
  ]);
  return token;
}

async function oauthCallback(
  provider: Provider = "twitch",
  authEnv: AppEnv = env,
  additionalData: Record<string, unknown> = { acceptance: { accepted: true, ...signupPolicy } },
): Promise<Request> {
  const clientAddress: string = `192.0.2.${oauthClient++}`;
  const response: Response = await createAuth(authEnv).handler(
    new Request(`${authEnv.APP_ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { origin: authEnv.APP_ORIGIN, "content-type": "application/json", "cf-connecting-ip": clientAddress },
      body: JSON.stringify({ provider, callbackURL: "/", additionalData }),
    }),
  );
  expect(response.status).toBe(200);
  const result: { url: string } = (await response.json()) as { url: string };
  const state: string | null = new URL(result.url).searchParams.get("state");
  expect(state).not.toBeNull();
  return new Request(
    `${authEnv.APP_ORIGIN}/api/auth/callback/${provider}?state=${encodeURIComponent(state ?? "")}&code=test-code`,
    {
      headers: {
        cookie: response.headers
          .getSetCookie()
          .map((cookie: string) => cookie.split(";")[0])
          .join("; "),
        "cf-connecting-ip": clientAddress,
      },
    },
  );
}

function stubGoogleIdentity(
  subject: string | undefined,
  email: string,
  picture: string = "https://provider.example.test/google-avatar.png",
  hostedDomain: string | null = "example.test",
): { restore: () => void; tokenRequests: URLSearchParams[] } {
  const originalFetch: typeof fetch = globalThis.fetch;
  const tokenRequests: URLSearchParams[] = [];
  const encode = (value: Record<string, unknown>): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now: number = Math.floor(Date.now() / 1000);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const tokenBody: string = `${encode({ alg: "RS256", typ: "JWT", kid: "test-google-key" })}.${encode({
    iss: "https://accounts.google.com",
    aud: env.GOOGLE_CLIENT_ID,
    sub: subject,
    iat: now,
    exp: now + 3600,
    email,
    email_verified: true,
    ...(hostedDomain ? { hd: hostedDomain } : {}),
    name: "Google viewer",
    picture,
  })}`;
  const idToken: string = `${tokenBody}.${sign("RSA-SHA256", Buffer.from(tokenBody), privateKey).toString("base64url")}`;
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url: string = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        tokenRequests.push(new URLSearchParams(await new Request(input, init).text()));
        // Authorization-code identity comes from the backchannel ID token; this path does not fetch userinfo or JWKS.
        return Response.json({
          access_token: "private-google-access-token",
          refresh_token: "private-google-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile",
          id_token: idToken,
        });
      }
      if (url === picture)
        return new Response(
          Uint8Array.from(
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
              "base64",
            ),
          ),
          { headers: { "Content-Type": "image/png" } },
        );
      if (new URL(url).hostname.endsWith("googleapis.com") || new URL(url).hostname === "accounts.google.com") {
        throw new Error("Unexpected Google network request in OAuth test");
      }
      return originalFetch(input, init);
    });
  return { restore: (): void => mock.mockRestore(), tokenRequests };
}

function stubTwitchIdentity(
  subject: string,
  email: string | null,
  name: string = "Twitch viewer",
  verification: { verified?: unknown } = { verified: true },
): () => void {
  const originalFetch: typeof fetch = globalThis.fetch;
  const encode = (value: Record<string, unknown>): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const idToken: string = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    sub: subject,
    email,
    email_verified: verification.verified,
    preferred_username: name,
    picture: "https://provider.example.test/avatar.png",
  })}.c2lnbmF0dXJl`;
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url: string = input instanceof Request ? input.url : String(input);
      if (url === "https://id.twitch.tv/oauth2/token") {
        return Response.json({
          access_token: "private-provider-access-token",
          refresh_token: "private-provider-refresh-token",
          token_type: "bearer",
          expires_in: 3600,
          id_token: idToken,
        });
      }
      return originalFetch(input, init);
    });
  return (): void => mock.mockRestore();
}

beforeAll(async () => {
  database = await createTestDatabase();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    POLL_ROOMS: {} as DurableObjectNamespace,
    REQUEST_LIMITER: {} as RateLimit,
    APP_ORIGIN: "https://stream.example.test",
    BETTER_AUTH_SECRET: secret,
    GOOGLE_CLIENT_ID: "test-google-client",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    TWITCH_CLIENT_ID: "test-twitch-client",
    TWITCH_CLIENT_SECRET: "test-twitch-secret",
  };
});

afterAll(async () => {
  await database.dispose();
});

describe("server identity", () => {
  it("rejects profile changes through the auth endpoint that bypasses account validation and quotas", async () => {
    const token: string = await seedSession("viewer-auth-update");
    const request: Request = await signedRequest(token);
    request.headers.set("origin", env.APP_ORIGIN);
    request.headers.set("content-type", "application/json");
    request.headers.set("cf-connecting-ip", "192.0.2.6");
    const response: Response = await createAuth(env).handler(
      new Request(`${env.APP_ORIGIN}/api/auth/update-user`, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({ name: `${"x".repeat(41)}\u0001`, image: "https://attacker.example.test/avatar.png" }),
      }),
    );
    expect(response.status).toBe(404);
    expect(await env.DB.prepare("SELECT name,image FROM user WHERE id=?").bind("viewer-auth-update").first()).toEqual({
      name: "Viewer",
      image: null,
    });
  });

  it("does not accept prototype identity or preview headers", async () => {
    const request: Request = new Request(`${env.APP_ORIGIN}/`, {
      headers: {
        "oai-authenticated-user-id": "attacker",
        "oai-authenticated-user-email": "owner@example.test",
        "x-preview-viewer": "false",
      },
    });
    expect(await getViewer(request, context())).toBeNull();
  });

  it("returns only public identity and rejects remote provider avatars", async () => {
    const token: string = await seedSession("viewer-public", { image: "https://provider.example.test/avatar.png" });
    expect(await getViewer(await signedRequest(token), context())).toEqual({
      id: "viewer-public",
      name: "Viewer",
      avatar: null,
      avatarPreset: null,
      locale: null,
      displayPrefs: null,
    });
  });

  it("serves only the signed-in users owned avatar", async () => {
    const token: string = await seedSession("viewer-avatar", { image: "/images/avatar/viewer-avatar" });
    expect((await getViewer(await signedRequest(token), context()))?.avatar).toBe("/images/avatar/viewer-avatar");
    await env.DB.prepare("UPDATE user SET image=? WHERE id=?")
      .bind("/images/avatar/someone-else", "viewer-avatar")
      .run();
    expect((await getViewer(await signedRequest(token), context()))?.avatar).toBeNull();
  });

  it("rejects expired and revoked sessions on the next request", async () => {
    const expired: string = await seedSession("viewer-expired", { expiresAt: Date.now() - 1000 });
    expect(await getViewer(await signedRequest(expired), context())).toBeNull();
    const token: string = await seedSession("viewer-revoked");
    expect(await getViewer(await signedRequest(token), context())).not.toBeNull();
    await env.DB.prepare("DELETE FROM session WHERE token=?").bind(token).run();
    expect(await getViewer(await signedRequest(token), context())).toBeNull();
  });

  it("rejects a tampered session cookie", async () => {
    const token: string = await seedSession("viewer-tampered");
    const request: Request = await signedRequest(token);
    request.headers.set("cookie", `${request.headers.get("cookie")}tampered`);
    expect(await getViewer(request, context())).toBeNull();
  });

  it("propagates a refreshed secure cookie without exposing the token", async () => {
    const token: string = await seedSession("viewer-refresh", {
      updatedAt: Date.now() - 172_800_000,
      expiresAt: Date.now() + 432_000_000,
    });
    const ctx: AppContext = context();
    expect(await getViewer(await signedRequest(token), ctx)).toEqual({
      id: "viewer-refresh",
      name: "Viewer",
      avatar: null,
      avatarPreset: null,
      locale: null,
      displayPrefs: null,
    });
    const cookies: string[] = ctx.responseHeaders.getSetCookie();
    expect(
      cookies.some(
        (cookie: string) =>
          cookie.includes("session_token=") &&
          /httponly/i.test(cookie) &&
          /secure/i.test(cookie) &&
          /samesite=lax/i.test(cookie),
      ),
    ).toBe(true);
  });
});

describe("OAuth boundary", () => {
  it.each([
    ["long", "x".repeat(41)],
    ["blank", "   "],
    ["multiline", "Viewer\nName"],
    ["control", "Viewer\u0085Name"],
    ["separator", "Viewer\u2028Name"],
  ])("rejects a %s OAuth display name before creating an account", async (label: string, name: string) => {
    const callback: Request = await oauthCallback();
    const email: string = `invalid-name-${label}@example.test`;
    const restore: () => void = stubTwitchIdentity(`invalid-name-${label}`, email, name);
    try {
      const response: Response = await createAuth(env).handler(callback);
      expect(response.status).toBe(302);
      const destination: URL = new URL(response.headers.get("location") ?? "", env.APP_ORIGIN);
      expect(destination.searchParams.get("error")).toBe("INVALID_DISPLAY_NAME");
      expect(destination.searchParams.get("error_description")).toBe(
        "Enter a display name with 1 to 40 characters on one line, then try again.",
      );
      expect(await env.DB.prepare("SELECT id FROM user WHERE email=?").bind(email).first()).toBeNull();
      expect(
        response.headers
          .getSetCookie()
          .some((value: string) => value.startsWith("__Host-stream-bullets.session_token=")),
      ).toBe(false);
    } finally {
      restore();
    }
  });

  it("keeps local HTTP OAuth sessions usable and expires the same cookie on sign-out", async () => {
    const localEnv: AppEnv = { ...env, APP_ORIGIN: "http://localhost:5173" };
    const callback: Request = await oauthCallback("twitch", localEnv);
    const restore: () => void = stubTwitchIdentity("local-http-viewer", "local-http@example.test");
    try {
      const response: Response = await createAuth(localEnv).handler(callback);
      expect(response.status).toBe(302);
      const session: string =
        response.headers.getSetCookie().find((value: string) => value.startsWith("stream-bullets.session_token=")) ??
        "";
      expect(session).toContain("Path=/");
      expect(session).toContain("HttpOnly");
      expect(session).toContain("SameSite=Lax");
      expect(session).not.toMatch(/;\s*Secure/i);
      const headers = new Headers({ cookie: session.split(";")[0], origin: localEnv.APP_ORIGIN });
      expect(
        await getViewer(new Request(localEnv.APP_ORIGIN, { headers }), { ...context(), env: localEnv }),
      ).toMatchObject({ name: "Twitch viewer" });
      const signedOut: Response = await createAuth(localEnv).handler(
        new Request(`${localEnv.APP_ORIGIN}/api/auth/sign-out`, { method: "POST", headers }),
      );
      expect(signedOut.status).toBe(200);
      expect(
        signedOut.headers.getSetCookie().find((value: string) => value.startsWith("stream-bullets.session_token=")),
      ).toContain("Max-Age=0");
      expect(
        await getViewer(new Request(localEnv.APP_ORIGIN, { headers }), { ...context(), env: localEnv }),
      ).toBeNull();
    } finally {
      restore();
    }
  });

  it("completes OAuth through D1, encrypts provider tokens, and rejects state replay", async () => {
    const callback: Request = await oauthCallback();
    const name: string = "N".repeat(40);
    const restore: () => void = stubTwitchIdentity("twitch-new-viewer", "new-viewer@example.test", name);
    try {
      const response: Response = await createAuth(env).handler(
        new Request(callback.url, { headers: callback.headers }),
      );
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).href).toBe(`${env.APP_ORIGIN}/`);
      const hostCookie: string =
        response.headers
          .getSetCookie()
          .find((value: string) => value.startsWith("__Host-stream-bullets.session_token=")) ?? "";
      expect(hostCookie).toMatch(/;\s*Secure/i);
      expect(hostCookie).toMatch(/;\s*Path=\//i);
      expect(hostCookie).not.toMatch(/;\s*Domain=/i);
      const record: { access_token: string; refresh_token: string; id_token: string } | null = await env.DB.prepare(
        "SELECT access_token,refresh_token,id_token FROM account WHERE provider_id=? AND account_id=?",
      )
        .bind("twitch", "twitch-new-viewer")
        .first();
      expect(record).not.toBeNull();
      expect(record?.access_token).not.toBe("private-provider-access-token");
      expect(record?.refresh_token).not.toBe("private-provider-refresh-token");
      expect(record?.access_token).not.toBeNull();
      const cookie: string = response.headers
        .getSetCookie()
        .map((value: string) => value.split(";")[0])
        .join("; ");
      expect(await getViewer(new Request(`${env.APP_ORIGIN}/`, { headers: { cookie } }), context())).toMatchObject({
        name,
        avatar: null,
      });
      const replay: Response = await createAuth(env).handler(new Request(callback.url, { headers: callback.headers }));
      expect(replay.status).toBe(302);
      expect(new URL(replay.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.has("error")).toBe(true);
      expect(
        replay.headers.getSetCookie().some((value: string) => value.startsWith("__Host-stream-bullets.session_token=")),
      ).toBe(false);
    } finally {
      restore();
    }
  });

  it("completes Google OAuth with a provider account, encrypted tokens, and a usable session", async () => {
    const callback: Request = await oauthCallback("google");
    const { restore, tokenRequests } = stubGoogleIdentity("google-new-viewer", "google-viewer@example.test");
    try {
      const response: Response = await createAuth(env).handler(callback);
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).href).toBe(`${env.APP_ORIGIN}/`);
      expect(tokenRequests).toHaveLength(1);
      expect(Object.fromEntries(tokenRequests[0])).toMatchObject({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: "test-code",
        redirect_uri: `${env.APP_ORIGIN}/api/auth/callback/google`,
      });
      expect(tokenRequests[0].get("code_verifier")).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);

      const record: { user_id: string; access_token: string; refresh_token: string } | null = await env.DB.prepare(
        "SELECT user_id,access_token,refresh_token FROM account WHERE provider_id=? AND account_id=?",
      )
        .bind("google", "google-new-viewer")
        .first();
      expect(record).not.toBeNull();
      expect(record?.access_token).not.toBe("private-google-access-token");
      expect(record?.refresh_token).not.toBe("private-google-refresh-token");
      expect(await symmetricDecrypt({ key: secret, data: record?.access_token ?? "" })).toBe(
        "private-google-access-token",
      );
      expect(await symmetricDecrypt({ key: secret, data: record?.refresh_token ?? "" })).toBe(
        "private-google-refresh-token",
      );
      expect(
        await env.DB.prepare("SELECT name,email,email_verified FROM user WHERE id=?")
          .bind(record?.user_id ?? "")
          .first(),
      ).toEqual({ name: "Google viewer", email: "google-viewer@example.test", email_verified: 1 });
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS count FROM session WHERE user_id=?")
          .bind(record?.user_id ?? "")
          .first(),
      ).toEqual({ count: 1 });
      const cookie: string = response.headers
        .getSetCookie()
        .map((value: string) => value.split(";")[0])
        .join("; ");
      expect(await getViewer(new Request(`${env.APP_ORIGIN}/`, { headers: { cookie } }), context())).toEqual({
        id: record?.user_id,
        name: "Google viewer",
        avatar: null,
        avatarPreset: null,
        locale: null,
        displayPrefs: null,
      });
    } finally {
      restore();
    }
  });

  it.each(["17841@instagram.invalid", "open-1@tiktok.placeholder.invalid", "open-1@tiktok.invalid"])(
    "refuses a sign-up from another provider that claims the placeholder %s",
    async (email: string) => {
      const callback: Request = await oauthCallback();
      const restore: () => void = stubTwitchIdentity(`squatter-${email}`, email);
      try {
        const response: Response = await createAuth(env).handler(callback);
        expect(response.status).toBe(302);
        const destination: URL = new URL(response.headers.get("location") ?? "", env.APP_ORIGIN);
        expect(destination.searchParams.get("error")).toBe("PLACEHOLDER_EMAIL");
        expect(await env.DB.prepare("SELECT id FROM user WHERE lower(email)=lower(?)").bind(email).first()).toBeNull();
      } finally {
        restore();
      }
    },
  );

  it("does not create a Google account or session without a stable provider subject", async () => {
    const callback: Request = await oauthCallback("google");
    const email: string = "google-missing-subject@example.test";
    const { restore } = stubGoogleIdentity(undefined, email);
    try {
      const response: Response = await createAuth(env).handler(callback);
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.has("error")).toBe(true);
      expect(await env.DB.prepare("SELECT id FROM user WHERE email=?").bind(email).first()).toBeNull();
      expect(
        await env.DB.prepare("SELECT id FROM account WHERE provider_id=? AND account_id=?")
          .bind("google", "undefined")
          .first(),
      ).toBeNull();
      expect(
        response.headers
          .getSetCookie()
          .some((value: string) => value.startsWith("__Host-stream-bullets.session_token=")),
      ).toBe(false);
    } finally {
      restore();
    }
  });

  it("does not link a provider email to an existing unverified account", async () => {
    await seedSession("viewer-implicit-link");
    await env.DB.prepare("UPDATE user SET email_verified=0 WHERE id=?").bind("viewer-implicit-link").run();
    const callback: Request = await oauthCallback();
    const restore: () => void = stubTwitchIdentity("twitch-unlinked-identity", "viewer-implicit-link@example.test");
    try {
      const response: Response = await createAuth(env).handler(callback);
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.has("error")).toBe(true);
      expect(
        await env.DB.prepare("SELECT id FROM account WHERE account_id=?").bind("twitch-unlinked-identity").first(),
      ).toBeNull();
      expect(
        response.headers
          .getSetCookie()
          .some((value: string) => value.startsWith("__Host-stream-bullets.session_token=")),
      ).toBe(false);
    } finally {
      restore();
    }
  });

  it("rejects cross-origin sign-out with a valid session cookie", async () => {
    const token: string = await seedSession("viewer-csrf");
    const request: Request = await signedRequest(token);
    request.headers.set("origin", "https://attacker.example.test");
    request.headers.set("content-type", "application/json");
    const response: Response = await createAuth(env).handler(
      new Request(`${env.APP_ORIGIN}/api/auth/sign-out`, {
        method: "POST",
        headers: request.headers,
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
    expect(await getViewer(await signedRequest(token), context())).not.toBeNull();
  });

  it("rejects OAuth callback state that was not issued to the browser", async () => {
    const response: Response = await createAuth(env).handler(
      new Request(`${env.APP_ORIGIN}/api/auth/callback/google?state=forged-state&code=forged-code`),
    );
    expect(response.status).toBe(302);
    const destination: URL = new URL(response.headers.get("location") ?? "", env.APP_ORIGIN);
    expect(destination.origin).toBe(env.APP_ORIGIN);
    expect(destination.searchParams.has("error")).toBe(true);
    expect(
      response.headers
        .getSetCookie()
        .some((cookie: string) => cookie.startsWith("__Host-stream-bullets.session_token=")),
    ).toBe(false);
  });

  it("requires a recent sign-in before linking an additional provider", async () => {
    const token: string = await seedSession("viewer-link");
    const request: Request = await signedRequest(token);
    request.headers.set("origin", env.APP_ORIGIN);
    request.headers.set("content-type", "application/json");
    request.headers.set("cf-connecting-ip", "192.0.2.5");
    const response: Response = await createAuth(env).handler(
      new Request(`${env.APP_ORIGIN}/api/auth/link-social`, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({ provider: "twitch", callbackURL: "/" }),
      }),
    );
    expect(response.ok).toBe(false);
    expect(await env.DB.prepare("SELECT id FROM account WHERE user_id=?").bind("viewer-link").first()).toBeNull();
  });

  it("rejects external callback destinations", async () => {
    const response: Response = await createAuth(env).handler(
      new Request(`${env.APP_ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { origin: env.APP_ORIGIN, "content-type": "application/json", "cf-connecting-ip": "192.0.2.2" },
        body: JSON.stringify({ provider: "google", callbackURL: "https://attacker.example.test/" }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("uses only the configured origin for provider callbacks", async () => {
    const response: Response = await createAuth(env).handler(
      new Request(`${env.APP_ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          origin: env.APP_ORIGIN,
          "content-type": "application/json",
          "cf-connecting-ip": "192.0.2.3",
          "x-forwarded-host": "attacker.example.test",
          "x-forwarded-proto": "http",
        },
        body: JSON.stringify({ provider: "google", callbackURL: "/" }),
      }),
    );
    expect(response.ok).toBe(true);
    const result: unknown = await response.json();
    expect(result).toHaveProperty("url");
    const url: URL = new URL((result as { url: string }).url);
    expect(url.searchParams.get("redirect_uri")).toBe(`${env.APP_ORIGIN}/api/auth/callback/google`);
  });

  it("cannot use email/password sign-up as a substitute for configured providers", async () => {
    const response: Response = await createAuth(env).handler(
      new Request(`${env.APP_ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin: env.APP_ORIGIN, "content-type": "application/json", "cf-connecting-ip": "192.0.2.4" },
        body: JSON.stringify({ email: "unauthorized@example.test", password: "a-test-password", name: "Unauthorized" }),
      }),
    );
    expect(response.ok).toBe(false);
    expect(
      await env.DB.prepare("SELECT id FROM user WHERE email=?").bind("unauthorized@example.test").first(),
    ).toBeNull();
  });

  it("rejects insecure or ambiguous origins and incomplete provider credentials", () => {
    for (const APP_ORIGIN of ["http://public.example.test", `${env.APP_ORIGIN}/path`, `${env.APP_ORIGIN}?query=1`]) {
      expect(() => createAuth({ ...env, APP_ORIGIN })).toThrow();
    }
    expect(() => configuredProviders({ ...env, TWITCH_CLIENT_SECRET: undefined })).toThrow(
      "Both twitch OAuth credentials",
    );
    expect(configuredProviders(env)).toEqual(["google", "twitch"]);
  });

  it("adds TikTok and Instagram only with both values of their credential pair, in button order", async () => {
    const all: AppEnv = {
      ...env,
      TIKTOK_CLIENT_KEY: "test-tiktok-key",
      TIKTOK_CLIENT_SECRET: "test-tiktok-secret",
      INSTAGRAM_CLIENT_ID: "test-instagram-client",
      INSTAGRAM_CLIENT_SECRET: "test-instagram-secret",
    };
    expect(configuredProviders(all)).toEqual(["google", "tiktok", "twitch", "instagram"]);
    expect(configuredProviders({ ...all, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined })).toEqual([
      "tiktok",
      "twitch",
      "instagram",
    ]);
    expect(() => configuredProviders({ ...all, TIKTOK_CLIENT_SECRET: undefined })).toThrow(
      "Both tiktok OAuth credentials",
    );
    expect(() => configuredProviders({ ...all, INSTAGRAM_CLIENT_ID: undefined })).toThrow(
      "Both instagram OAuth credentials",
    );
    expect(() => createAuth({ ...all, INSTAGRAM_CLIENT_SECRET: undefined })).toThrow(
      "Both instagram OAuth credentials",
    );
    const auth = createAuth(all);
    for (const [provider, host] of [
      ["tiktok", "www.tiktok.com"],
      ["instagram", "www.instagram.com"],
    ] as const) {
      const response = await auth.handler(
        new Request(`${env.APP_ORIGIN}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: env.APP_ORIGIN },
          body: JSON.stringify({ provider, callbackURL: "/streamers" }),
        }),
      );
      expect(response.status).toBe(200);
      const { url } = (await response.json()) as { url: string };
      expect(new URL(url).host).toBe(host);
    }
  });

  it("recognises the placeholder addresses of accounts without an email", () => {
    expect(placeholderEmail("instagram", "17841")).toBe("17841@instagram.invalid");
    expect(placeholderEmail("tiktok", "abc")).toBe("abc@tiktok.placeholder.invalid");
    expect(isPlaceholderEmail("17841@instagram.invalid")).toBe(true);
    expect(isPlaceholderEmail("open_id@tiktok.placeholder.invalid")).toBe(true);
    expect(isPlaceholderEmail("person@example.test")).toBe(false);
  });
});

describe("provider adapters", () => {
  interface InstagramConfig {
    getToken: (input: { code: string; redirectURI: string }) => Promise<{ accessToken: string; tokenType: string }>;
    getUserInfo: (tokens: { accessToken?: string }) => Promise<Record<string, unknown> | null>;
  }
  const withProviders = (): AppEnv => ({
    ...env,
    TIKTOK_CLIENT_KEY: "test-tiktok-key",
    TIKTOK_CLIENT_SECRET: "test-tiktok-secret",
    INSTAGRAM_CLIENT_ID: "test-instagram-client",
    INSTAGRAM_CLIENT_SECRET: "test-instagram-secret",
  });

  // Inspect the Instagram generic OAuth config; fail clearly if an upgrade changes this internal shape.
  function instagram(): InstagramConfig {
    const plugins: unknown = createAuth(withProviders()).options.plugins;
    const plugin = Array.isArray(plugins)
      ? (plugins as { id?: unknown; options?: { config?: unknown } }[]).find((item) => item?.id === "generic-oauth")
      : undefined;
    const configs: unknown = plugin?.options?.config;
    const config = Array.isArray(configs)
      ? (configs as { providerId?: unknown }[]).find((item) => item?.providerId === "instagram")
      : undefined;
    if (typeof (config as Partial<InstagramConfig> | undefined)?.getToken !== "function") {
      throw new Error(
        "Cannot find the Instagram provider in better-auth's generic-oauth plugin options; its internal shape changed.",
      );
    }
    return config as unknown as InstagramConfig;
  }

  // Return queued fetch bodies; preserve supplied Responses.
  function answer(...bodies: unknown[]) {
    const queue = [...bodies];
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (): Promise<Response> => {
      const next = queue.shift();
      return next instanceof Response ? next : Response.json(next);
    });
  }

  it("refuses a short authentication secret", () => {
    expect(() => createAuth({ ...env, BETTER_AUTH_SECRET: "too-short" })).toThrow(
      "Authentication secret is not configured.",
    );
  });

  it("lets only the owning provider create a placeholder address (security review finding 9)", () => {
    expect(placeholderAllowed("17841@instagram.invalid", "instagram")).toBe(true);
    expect(placeholderAllowed("open-1@tiktok.placeholder.invalid", "tiktok")).toBe(true);
    expect(placeholderAllowed("person@example.test", "twitch")).toBe(true);
    expect(placeholderAllowed("person@example.test", null)).toBe(true);
    for (const [email, provider] of [
      ["17841@instagram.invalid", "twitch"],
      ["17841@Instagram.INVALID", "google"],
      ["open-1@tiktok.placeholder.invalid", "instagram"],
      ["open-1@tiktok.invalid", "tiktok"],
      ["17841@instagram.invalid", null],
      ["someone@other.invalid", "twitch"],
      ["17841@instagram.invalid.", "instagram"],
    ] as const)
      expect([email, provider, placeholderAllowed(email, provider)]).toEqual([email, provider, false]);
  });

  it("posts the Instagram code as a form and reads a plain or a data-wrapped token", async () => {
    const fetchMock = answer(
      { access_token: "plain-token" },
      { data: [{ access_token: "wrapped-token", user_id: 7 }] },
    );
    try {
      const config = instagram();
      const plain = await config.getToken({ code: "code-1", redirectURI: "https://stream.example.test/cb" });
      expect(plain).toEqual({ accessToken: "plain-token", tokenType: "bearer" });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.instagram.com/oauth/access_token");
      expect(init.method).toBe("POST");
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
        client_id: "test-instagram-client",
        client_secret: "test-instagram-secret",
        grant_type: "authorization_code",
        redirect_uri: "https://stream.example.test/cb",
        code: "code-1",
      });
      expect(await config.getToken({ code: "code-2", redirectURI: "x" })).toMatchObject({
        accessToken: "wrapped-token",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("fails the Instagram sign-in when the token exchange fails or answers an unknown shape", async () => {
    const fetchMock = answer(new Response("no", { status: 400 }), { data: [] });
    try {
      const config = instagram();
      await expect(config.getToken({ code: "c", redirectURI: "r" })).rejects.toThrow("Instagram sign-in failed.");
      // Missing access_token is a parse error, not a sign-in refusal.
      await expect(config.getToken({ code: "c", redirectURI: "r" })).rejects.toBeInstanceOf(ZodError);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("maps the Instagram profile to a placeholder account and rejects incomplete profiles", async () => {
    const fetchMock = answer(
      { user_id: "1784", username: "nova_handle", name: "Nova" },
      { id: 99, username: "only_handle" },
      { id: 98 },
      { username: "no_id" },
      new Response("no", { status: 401 }),
    );
    try {
      const config = instagram();
      expect(await config.getUserInfo({})).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await config.getUserInfo({ accessToken: "t" })).toEqual({
        id: "1784",
        name: "Nova",
        email: "1784@instagram.invalid",
        emailVerified: false,
      });
      expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({ Authorization: "Bearer t" });
      expect(await config.getUserInfo({ accessToken: "t" })).toMatchObject({ id: "99", name: "only_handle" });
      expect(await config.getUserInfo({ accessToken: "t" })).toMatchObject({ id: "98", name: "" });
      expect(await config.getUserInfo({ accessToken: "t" })).toBeNull();
      expect(await config.getUserInfo({ accessToken: "t" })).toBeNull();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    {
      provider: "tiktok",
      subject: "tiktok-open-1",
      email: "tiktok-open-1@tiktok.placeholder.invalid",
      routes: {
        "https://open.tiktokapis.com/v2/oauth/token/": {
          access_token: "private-tiktok-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          open_id: "tiktok-open-1",
        },
        "https://open.tiktokapis.com/v2/user/info/": {
          data: { user: { open_id: "tiktok-open-1", display_name: "TikTok viewer" } },
        },
      },
    },
    {
      provider: "instagram",
      subject: "17841",
      email: "17841@instagram.invalid",
      routes: {
        "https://api.instagram.com/oauth/access_token": { access_token: "private-instagram-access-token" },
        "https://graph.instagram.com/me": { user_id: "17841", username: "nova_handle", name: "Nova" },
      },
    },
  ] as const)(
    "stores a $provider sign-in with an unverified placeholder email that is never an admin",
    async ({ provider, subject, email, routes }) => {
      const authEnv: AppEnv = withProviders();
      const callback: Request = await oauthCallback(provider, authEnv);
      const providerUrls: string[] = [];
      const originalFetch: typeof fetch = globalThis.fetch;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init): Promise<Response> => {
        const url: string = input instanceof Request ? input.url : String(input);
        const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
        if (!route) return originalFetch(input, init);
        providerUrls.push(url);
        return Response.json(route[1]);
      });
      try {
        const response: Response = await createAuth(authEnv).handler(callback);
        expect(response.status).toBe(302);
        expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.get("error")).toBeNull();
        expect(providerUrls).toHaveLength(2);
        const row = await env.DB.prepare(
          "SELECT u.id,u.email,u.email_verified FROM user u JOIN account a ON a.user_id=u.id WHERE a.provider_id=? AND a.account_id=?",
        )
          .bind(provider, subject)
          .first<{ id: string; email: string; email_verified: number }>();
        expect(row).toMatchObject({ email, email_verified: 0 });
        expect(isPlaceholderEmail(email)).toBe(true);
        const listed: AppEnv = { ...authEnv, ADMIN_EMAILS: email };
        expect(await isAdmin(listed, row?.id ?? "")).toBe(false);
        // Only the unverified flag excludes this placeholder address from admin access.
        await env.DB.prepare("UPDATE user SET email_verified=1 WHERE id=?")
          .bind(row?.id ?? "")
          .run();
        expect(await isAdmin(listed, row?.id ?? "")).toBe(true);
      } finally {
        fetchMock.mockRestore();
      }
    },
  );
});

async function accountRequest(
  token: string,
  path: string,
  body: Record<string, unknown>,
  authEnv: AppEnv = env,
): Promise<Response> {
  const request: Request = await signedRequest(token);
  request.headers.set("origin", env.APP_ORIGIN);
  request.headers.set("content-type", "application/json");
  request.headers.set("cf-connecting-ip", `192.0.2.${oauthClient++}`);
  return createAuth(authEnv).handler(
    new Request(`${env.APP_ORIGIN}/api/auth/${path}`, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(body),
    }),
  );
}

async function freshAccount(id: string): Promise<string> {
  const token: string = await seedSession(id);
  await env.DB.prepare("UPDATE session SET created_at=? WHERE user_id=?").bind(Date.now(), id).run();
  await env.DB.prepare(
    "INSERT INTO account(id,account_id,provider_id,user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(`${id}-google`, `${id}-subject`, "google", id, Date.now(), Date.now())
    .run();
  return token;
}

async function linkCallback(token: string, provider: Provider = "twitch", authEnv: AppEnv = env): Promise<Request> {
  const response: Response = await accountRequest(
    token,
    "link-social",
    {
      provider,
      callbackURL: "/settings",
    },
    authEnv,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { url: string };
  const state: string = new URL(body.url).searchParams.get("state") ?? "";
  const sessionRequest: Request = await signedRequest(token);
  const cookies: string = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  return new Request(
    `${env.APP_ORIGIN}/api/auth/callback/${provider}?state=${encodeURIComponent(state)}&code=link-code`,
    {
      headers: {
        cookie: `${sessionRequest.headers.get("cookie")}; ${cookies}`,
        "cf-connecting-ip": `192.0.2.${oauthClient++}`,
      },
    },
  );
}

describe("signup acceptance and defaults", () => {
  it.each([
    {},
    { acceptance: { accepted: false, ...signupPolicy } },
    { acceptance: { accepted: "true", ...signupPolicy } },
    { acceptance: { accepted: true, ...signupPolicy, termsVersion: "old" } },
    { serverContext: { acceptedAt: Date.now(), ...signupPolicy } },
  ])("rejects missing or tampered acknowledgement through a real OAuth callback", async (data) => {
    const id: string = crypto.randomUUID();
    const callback: Request = await oauthCallback("twitch", env, data);
    const restore: () => void = stubTwitchIdentity(id, `${id}@example.test`);
    try {
      const response: Response = await createAuth(env).handler(callback);
      expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.get("error")).toBe(
        "ELIGIBILITY_REQUIRED",
      );
      expect(await env.DB.prepare("SELECT id FROM user WHERE email=?").bind(`${id}@example.test`).first()).toBeNull();
    } finally {
      restore();
    }
  });

  it("accepts an editable correction, records consent privately, and preserves edits on later login", async () => {
    const callback: Request = await oauthCallback("twitch", env, {
      acceptance: { accepted: true, ...signupPolicy },
      displayName: "My chosen name",
    });
    const restore: () => void = stubTwitchIdentity("corrected-name", "corrected@example.test", "\n");
    try {
      const response: Response = await createAuth(env).handler(callback);
      expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.has("error")).toBe(false);
      const user = await env.DB.prepare("SELECT id,name FROM user WHERE email=?")
        .bind("corrected@example.test")
        .first<{ id: string; name: string }>();
      expect(user?.name).toBe("My chosen name");
      const acceptance = await env.DB.prepare("SELECT * FROM signup_acceptance WHERE user_id=?").bind(user?.id).first();
      expect(acceptance).toMatchObject({
        minimum_age: 16,
        terms_version: signupPolicy.termsVersion,
        privacy_version: signupPolicy.privacyVersion,
      });
      expect(acceptance?.accepted_at).toBeTypeOf("number");
      await env.DB.prepare("UPDATE user SET name=?,avatar_preset=? WHERE id=?").bind("Edited later", 4, user?.id).run();
      const repeat: Request = await oauthCallback("twitch", env, {});
      const repeatResponse: Response = await createAuth(env).handler(repeat);
      const cookie: string = repeatResponse.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      expect(await getViewer(new Request(env.APP_ORIGIN, { headers: { cookie } }), context())).toMatchObject({
        id: user?.id,
        name: "Edited later",
        avatarPreset: 4,
      });
      expect(await env.DB.prepare("SELECT name,avatar_preset FROM user WHERE id=?").bind(user?.id).first()).toEqual({
        name: "Edited later",
        avatar_preset: 4,
      });
      expect(await env.DB.prepare("SELECT * FROM signup_acceptance WHERE user_id=?").bind(user?.id).first()).toEqual(
        acceptance,
      );
    } finally {
      restore();
    }
  });

  it("records legacy account acceptance only after an explicit acknowledged sign-in", async () => {
    await freshAccount("legacy-consent");
    const restore = stubGoogleIdentity("legacy-consent-subject", "legacy-consent@example.test");
    try {
      const withoutAcceptance: Response = await createAuth(env).handler(await oauthCallback("google", env, {}));
      const cookie: string = withoutAcceptance.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      expect(await getViewer(new Request(env.APP_ORIGIN, { headers: { cookie } }), context())).toMatchObject({
        id: "legacy-consent",
      });
      expect(
        await env.DB.prepare("SELECT * FROM signup_acceptance WHERE user_id=?").bind("legacy-consent").first(),
      ).toBeNull();
      await createAuth(env).handler(await oauthCallback("google"));
      expect(
        await env.DB.prepare("SELECT minimum_age FROM signup_acceptance WHERE user_id=?")
          .bind("legacy-consent")
          .first(),
      ).toEqual({ minimum_age: 16 });
    } finally {
      restore.restore();
    }
  });

  it("records the policy acknowledged before deployment changes during an existing account sign-in", async () => {
    await freshAccount("legacy-policy-rollover");
    const callback: Request = await oauthCallback("google");
    const acceptedPolicy = { ...signupPolicy };
    const restore = stubGoogleIdentity("legacy-policy-rollover-subject", "legacy-policy-rollover@example.test");
    try {
      Object.assign(signupPolicy, { termsVersion: "next-terms", privacyVersion: "next-privacy" });
      const response: Response = await createAuth(env).handler(callback);
      expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.has("error")).toBe(false);
      expect(
        await env.DB.prepare("SELECT minimum_age,terms_version,privacy_version FROM signup_acceptance WHERE user_id=?")
          .bind("legacy-policy-rollover")
          .first(),
      ).toEqual({
        minimum_age: acceptedPolicy.minimumAge,
        terms_version: acceptedPolicy.termsVersion,
        privacy_version: acceptedPolicy.privacyVersion,
      });
    } finally {
      Object.assign(signupPolicy, acceptedPolicy);
      restore.restore();
    }
  });

  it("imports an allowed Google profile photo through the OAuth registration hook", async () => {
    const callback: Request = await oauthCallback("google");
    const restore = stubGoogleIdentity(
      "google-photo",
      "google-photo@example.test",
      "https://lh3.googleusercontent.com/test-photo",
    );
    try {
      const response: Response = await createAuth(env).handler(callback);
      const cookie: string = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const viewer = await getViewer(new Request(env.APP_ORIGIN, { headers: { cookie } }), context());
      expect(viewer).not.toBeNull();
      expect(viewer?.avatar).toBe(`/images/avatar/${viewer?.id}`);
      expect(
        await env.DB.prepare("SELECT version FROM image_versions WHERE owner_id=? AND kind='avatar'")
          .bind(viewer?.id)
          .first(),
      ).not.toBeNull();
    } finally {
      restore.restore();
    }
  });

  it("links verified normalized emails without treating aliases as equivalent", async () => {
    await freshAccount("email-case");
    const initial = stubGoogleIdentity("email-case-subject", "email-case@example.test");
    try {
      expect(
        await responseViewer(await createAuth(env).handler(await oauthCallback("google", env, {}))),
      ).not.toBeNull();
    } finally {
      initial.restore();
    }
    const restore: () => void = stubTwitchIdentity("case-collision", "EMAIL-CASE@EXAMPLE.TEST");
    try {
      const response: Response = await createAuth(env).handler(await oauthCallback());
      expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.has("error")).toBe(false);
      expect(await env.DB.prepare("SELECT user_id FROM account WHERE account_id='case-collision'").first()).toEqual({
        user_id: "email-case",
      });
    } finally {
      restore();
    }
    const aliasRestore: () => void = stubTwitchIdentity("email-alias", "email-case+alias@example.test");
    try {
      await createAuth(env).handler(await oauthCallback());
      const row = await env.DB.prepare("SELECT id FROM user WHERE email=?")
        .bind("email-case+alias@example.test")
        .first<{ id: string }>();
      expect(row).not.toBeNull();
      expect(row?.id).not.toBe("email-case");
    } finally {
      aliasRestore();
    }
  });
});

describe("explicit login methods", () => {
  it("links a different email and uses the same user ID without replacing the profile", async () => {
    const token: string = await freshAccount("explicit-link");
    const callback: Request = await linkCallback(token);
    const restore: () => void = stubTwitchIdentity(
      "explicit-twitch",
      "different-address@example.test",
      "Different name",
    );
    try {
      const response: Response = await createAuth(env).handler(callback);
      expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).pathname).toBe("/settings");
      expect(
        await env.DB.prepare(
          "SELECT user_id FROM account WHERE provider_id='twitch' AND account_id='explicit-twitch'",
        ).first(),
      ).toEqual({ user_id: "explicit-link" });
      const signedIn: Response = await createAuth(env).handler(await oauthCallback("twitch", env, {}));
      const cookie: string = signedIn.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      expect(await getViewer(new Request(env.APP_ORIGIN, { headers: { cookie } }), context())).toMatchObject({
        id: "explicit-link",
        name: "Viewer",
      });
    } finally {
      restore();
    }
  });

  it("rejects ownership reassignment and revoked linking sessions", async () => {
    const owner: string = await freshAccount("link-owner");
    const stranger: string = await freshAccount("link-stranger");
    const restore: () => void = stubTwitchIdentity("owned-twitch", "owned@example.test");
    try {
      await createAuth(env).handler(await linkCallback(owner));
      const conflict: Response = await createAuth(env).handler(await linkCallback(stranger));
      expect(new URL(conflict.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.get("error")).toBe(
        "account_already_linked_to_different_user",
      );
      const revoked: Request = await linkCallback(stranger);
      await env.DB.prepare("DELETE FROM session WHERE user_id=?").bind("link-stranger").run();
      const response: Response = await createAuth(env).handler(revoked);
      expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.get("error")).toBe(
        "unable_to_link_account",
      );
      expect(await env.DB.prepare("SELECT user_id FROM account WHERE account_id='owned-twitch'").first()).toEqual({
        user_id: "link-owner",
      });
    } finally {
      restore();
    }
  });

  it("links Google explicitly and signs back into the same profile", async () => {
    const token: string = await freshAccount("explicit-google-link");
    const callback: Request = await linkCallback(token, "google");
    const restore = stubGoogleIdentity("explicit-google-new", "different-google@example.test");
    try {
      const linked: Response = await createAuth(env).handler(callback);
      expect(new URL(linked.headers.get("location") ?? "", env.APP_ORIGIN).pathname).toBe("/settings");
      const response: Response = await createAuth(env).handler(await oauthCallback("google", env, {}));
      const cookie: string = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      expect(await getViewer(new Request(env.APP_ORIGIN, { headers: { cookie } }), context())).toMatchObject({
        id: "explicit-google-link",
        name: "Viewer",
      });
    } finally {
      restore.restore();
    }
  });

  it.each(["aged", "mismatched"] as const)("rejects a %s session at the linking callback", async (condition) => {
    const ownerId: string = `callback-${condition}`;
    const token: string = await freshAccount(ownerId);
    const callback: Request = await linkCallback(token);
    if (condition === "aged") {
      await env.DB.prepare("UPDATE session SET created_at=? WHERE user_id=?")
        .bind(Date.now() - 601_000, ownerId)
        .run();
    } else {
      const other: string = await freshAccount("callback-other-session");
      const signed: Request = await signedRequest(other);
      const stateCookies: string = (callback.headers.get("cookie") ?? "")
        .split("; ")
        .filter((value) => !value.startsWith("__Host-stream-bullets.session_token="))
        .join("; ");
      callback.headers.set("cookie", `${signed.headers.get("cookie")}; ${stateCookies}`);
    }
    const restore: () => void = stubTwitchIdentity(`subject-${condition}`, `callback-${condition}@example.test`);
    try {
      const response: Response = await createAuth(env).handler(callback);
      expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.get("error")).toBe(
        "reauth_required",
      );
      expect(
        await env.DB.prepare("SELECT id FROM account WHERE provider_id='twitch' AND account_id=?")
          .bind(`subject-${condition}`)
          .first(),
      ).toBeNull();
    } finally {
      restore();
    }
  });

  it("keeps the last configured login method when another stored provider is disabled", async () => {
    const token: string = await freshAccount("disabled-fallback");
    await env.DB.prepare(
      "INSERT INTO account(id,account_id,provider_id,user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        "disabled-fallback-twitch",
        "disabled-fallback-subject",
        "twitch",
        "disabled-fallback",
        Date.now(),
        Date.now(),
      )
      .run();
    const authEnv: AppEnv = { ...env, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined };
    const response: Response = await accountRequest(
      token,
      "unlink-account",
      { accountId: "disabled-fallback-twitch" },
      authEnv,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "LOGIN_METHOD_REQUIRED" });
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM account WHERE user_id='disabled-fallback'").first(),
    ).toEqual({ count: 2 });
    const removedDisabled: Response = await accountRequest(
      token,
      "unlink-account",
      { accountId: "disabled-fallback-google" },
      authEnv,
    );
    expect(removedDisabled.status).toBe(200);
    expect(await env.DB.prepare("SELECT provider_id FROM account WHERE user_id='disabled-fallback'").first()).toEqual({
      provider_id: "twitch",
    });
  });

  it("keeps one login method when two removals run concurrently", async () => {
    const token: string = await freshAccount("unlink-race");
    await env.DB.prepare(
      "INSERT INTO account(id,account_id,provider_id,user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    )
      .bind("unlink-race-twitch", "unlink-subject", "twitch", "unlink-race", Date.now(), Date.now())
      .run();
    const responses: Response[] = await Promise.all([
      accountRequest(token, "unlink-account", { accountId: "unlink-race-google" }),
      accountRequest(token, "unlink-account", { accountId: "unlink-race-twitch" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM account WHERE user_id='unlink-race'").first()).toEqual({
      count: 1,
    });
  });
});

describe("verified email account discovery", () => {
  it.each([false, undefined, "true", 1])(
    "does not automatically link a provider verification claim of %s",
    async (verified: unknown) => {
      const suffix: string = crypto.randomUUID();
      const id: string = `unverified-${suffix}`;
      await freshAccount(id);
      await env.DB.prepare("UPDATE user SET email_link_verified=1 WHERE id=?").bind(id).run();
      const restore: () => void = stubTwitchIdentity(`twitch-${suffix}`, `${id}@example.test`, "Viewer", { verified });
      try {
        const callback: Request = await oauthCallback();
        const response: Response = await createAuth(env).handler(callback);
        expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.has("error")).toBe(true);
        expect(
          await env.DB.prepare("SELECT id FROM account WHERE account_id=?").bind(`twitch-${suffix}`).first(),
        ).toBeNull();
        expect(
          await env.DB.prepare("SELECT count(*) AS count FROM user WHERE email=?").bind(`${id}@example.test`).first(),
        ).toEqual({ count: 1 });
      } finally {
        restore();
      }
      const verifiedRestore: () => void = stubTwitchIdentity(`twitch-${suffix}`, `${id}@example.test`);
      try {
        const response: Response = await createAuth(env).handler(await oauthCallback("twitch", env, {}));
        expect((await responseViewer(response))?.id).toBe(id);
      } finally {
        verifiedRestore();
      }
    },
  );

  it("rejects a missing Twitch email without creating an account", async () => {
    const restore: () => void = stubTwitchIdentity("no-email", null, "Viewer", { verified: false });
    try {
      const response: Response = await createAuth(env).handler(await oauthCallback());
      expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.get("error")).toBe(
        "email_not_found",
      );
      expect(await env.DB.prepare("SELECT id FROM account WHERE account_id='no-email'").first()).toBeNull();
    } finally {
      restore();
    }
  });

  it.each(["google", "twitch"] as const)(
    "signs up with %s then discovers the same account through the other verified provider",
    async (first: "google" | "twitch") => {
      const suffix: string = crypto.randomUUID();
      const email: string = `${suffix}@example.test`;
      const google = (): { restore: () => void } => stubGoogleIdentity(`google-${suffix}`, email);
      const twitch = (): { restore: () => void } => ({ restore: stubTwitchIdentity(`twitch-${suffix}`, email) });
      const initial = first === "google" ? google() : twitch();
      let id: string;
      try {
        const response: Response = await createAuth(env).handler(await oauthCallback(first));
        const signedViewer = await responseViewer(response);
        expect(signedViewer).not.toBeNull();
        id = signedViewer?.id ?? "";
      } finally {
        initial.restore();
      }
      const second: "google" | "twitch" = first === "google" ? "twitch" : "google";
      const next = second === "google" ? google() : twitch();
      try {
        const response: Response = await createAuth(env).handler(await oauthCallback(second, env, {}));
        expect((await responseViewer(response))?.id).toBe(id);
        expect(await env.DB.prepare("SELECT count(*) AS count FROM user WHERE email=?").bind(email).first()).toEqual({
          count: 1,
        });
        expect(await env.DB.prepare("SELECT count(*) AS count FROM account WHERE user_id=?").bind(id).first()).toEqual({
          count: 2,
        });
      } finally {
        next.restore();
      }
    },
  );

  it("enforces normalized-email uniqueness on concurrent database inserts", async () => {
    const now: number = Date.now();
    const rows = [" Race@Example.Test ", "race@example.test"];
    const results = await Promise.allSettled(
      rows.map((email: string, index: number) =>
        env.DB.prepare("INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,?,?)")
          .bind(`email-race-${index}`, "Viewer", email, 1, now, now)
          .run(),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM user WHERE lower(trim(email))='race@example.test'").first(),
    ).toEqual({ count: 1 });
  });
});

async function responseViewer(response: Response): Promise<Viewer | null> {
  const cookie: string = response.headers
    .getSetCookie()
    .map((value: string) => value.split(";")[0])
    .join("; ");
  return getViewer(new Request(env.APP_ORIGIN, { headers: { cookie } }), context());
}

it("does not create duplicate users when OAuth signups race for the same normalized email", async () => {
  const callbacks: Request[] = [await oauthCallback(), await oauthCallback()];
  const restore: () => void = stubTwitchIdentity("concurrent-signup", " Concurrent-Signup@Example.Test ");
  try {
    const responses: Response[] = await Promise.all(
      callbacks.map((request: Request) => createAuth(env).handler(request)),
    );
    expect(
      responses.some((response: Response) =>
        response.headers
          .getSetCookie()
          .some((cookie: string) => cookie.startsWith("__Host-stream-bullets.session_token=")),
      ),
    ).toBe(true);
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM user WHERE email='concurrent-signup@example.test'").first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM account WHERE account_id='concurrent-signup'").first(),
    ).toEqual({ count: 1 });
  } finally {
    restore();
  }
});

it("allows explicit proof of provider control without trusting an unverified email for automatic linking", async () => {
  const token: string = await freshAccount("explicit-unverified");
  const auth = createAuth(env);
  const restore: () => void = stubTwitchIdentity(
    "explicit-unverified-subject",
    "other-unverified@example.test",
    "Viewer",
    { verified: false },
  );
  try {
    const linked: Response = await auth.handler(await linkCallback(token));
    expect(new URL(linked.headers.get("location") ?? "", env.APP_ORIGIN).pathname).toBe("/settings");
    expect(
      await env.DB.prepare("SELECT user_id FROM account WHERE account_id='explicit-unverified-subject'").first(),
    ).toEqual({ user_id: "explicit-unverified" });
    expect(
      await env.DB.prepare("SELECT email,email_verified FROM user WHERE id='explicit-unverified'").first(),
    ).toEqual({ email: "explicit-unverified@example.test", email_verified: 1 });
  } finally {
    restore();
  }
  const unverifiedRestore: () => void = stubTwitchIdentity(
    "automatic-unverified-subject",
    "explicit-unverified@example.test",
    "Viewer",
    { verified: false },
  );
  try {
    const rejected: Response = await auth.handler(await oauthCallback());
    expect(new URL(rejected.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.get("error")).toBe(
      "account_not_linked",
    );
    expect(
      await env.DB.prepare("SELECT id FROM account WHERE account_id='automatic-unverified-subject'").first(),
    ).toBeNull();
  } finally {
    unverifiedRestore();
  }
});

it("explicitly connects a configured provider with no contact email", async () => {
  const token: string = await freshAccount("explicit-tiktok");
  const authEnv: AppEnv = { ...env, TIKTOK_CLIENT_KEY: "test-tiktok-key", TIKTOK_CLIENT_SECRET: "test-tiktok-secret" };
  const callback: Request = await linkCallback(token, "tiktok", authEnv);
  const originalFetch: typeof fetch = globalThis.fetch;
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init): Promise<Response> => {
    const url: string = input instanceof Request ? input.url : String(input);
    if (url === "https://open.tiktokapis.com/v2/oauth/token/")
      return Response.json({
        access_token: "tiktok-link-token",
        token_type: "Bearer",
        expires_in: 3600,
        open_id: "explicit-open-id",
      });
    if (url.startsWith("https://open.tiktokapis.com/v2/user/info/"))
      return Response.json({ data: { user: { open_id: "explicit-open-id", display_name: "Other display name" } } });
    return originalFetch(input, init);
  });
  try {
    const response: Response = await createAuth(authEnv).handler(callback);
    expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).pathname).toBe("/settings");
    expect(
      await env.DB.prepare(
        "SELECT user_id FROM account WHERE provider_id='tiktok' AND account_id='explicit-open-id'",
      ).first(),
    ).toEqual({ user_id: "explicit-tiktok" });
    expect(await env.DB.prepare("SELECT name,email FROM user WHERE id='explicit-tiktok'").first()).toEqual({
      name: "Viewer",
      email: "explicit-tiktok@example.test",
    });
  } finally {
    mock.mockRestore();
  }
});

it("requires explicit linking for a Google third-party email without hosted-domain authority", async () => {
  await freshAccount("third-party-email");
  await env.DB.prepare("UPDATE user SET email_link_verified=1 WHERE id=?").bind("third-party-email").run();
  const provider = stubGoogleIdentity(
    "third-party-subject",
    "third-party-email@example.test",
    "https://provider.example.test/photo",
    null,
  );
  try {
    const response: Response = await createAuth(env).handler(await oauthCallback("google"));
    expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.get("error")).toBe(
      "account_not_linked",
    );
    expect(await env.DB.prepare("SELECT id FROM account WHERE account_id='third-party-subject'").first()).toBeNull();
  } finally {
    provider.restore();
  }
  const authoritative = stubGoogleIdentity("third-party-subject", "third-party-email@example.test");
  try {
    const response: Response = await createAuth(env).handler(await oauthCallback("google", env, {}));
    expect((await responseViewer(response))?.id).toBe("third-party-email");
  } finally {
    authoritative.restore();
  }
});

describe("email authority provenance", () => {
  it("preserves Google external-address admin verification without granting automatic-link authority", async () => {
    const callback: Request = await oauthCallback("google", env, {
      acceptance: { accepted: true, ...signupPolicy },
      emailLinkVerified: true,
      serverContext: { emailLinkVerified: true },
    });
    const google = stubGoogleIdentity(
      "external-admin",
      "admin@forwarded.example",
      "https://provider.example.test/photo",
      null,
    );
    let id: string;
    try {
      const response: Response = await createAuth(env).handler(callback);
      const viewer = await responseViewer(response);
      expect(viewer).not.toBeNull();
      id = viewer?.id ?? "";
      expect(
        await env.DB.prepare("SELECT email_verified,email_link_verified FROM user WHERE id=?").bind(id).first(),
      ).toEqual({ email_verified: 1, email_link_verified: 0 });
      expect(await isAdmin({ ...env, ADMIN_EMAILS: "admin@forwarded.example" }, id)).toBe(true);
      const cookie: string = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const session: Response = await createAuth(env).handler(
        new Request(`${env.APP_ORIGIN}/api/auth/get-session`, { headers: { cookie } }),
      );
      expect(JSON.stringify(await session.json())).not.toContain("emailLinkVerified");
    } finally {
      google.restore();
    }
    const twitch: () => void = stubTwitchIdentity("external-admin-twitch", "admin@forwarded.example");
    try {
      const response: Response = await createAuth(env).handler(await oauthCallback("twitch", env, {}));
      expect(await responseViewer(response)).toBeNull();
      expect(
        await env.DB.prepare("SELECT id FROM account WHERE account_id='external-admin-twitch'").first(),
      ).toBeNull();
    } finally {
      twitch();
    }
  });

  it("does not promote canonical email authority through explicit links or later sign-ins using a different email", async () => {
    const token: string = await freshAccount("separate-primary-email");
    const twitch: () => void = stubTwitchIdentity("separate-primary-twitch", "other-primary@example.test");
    try {
      const linked: Response = await createAuth(env).handler(await linkCallback(token));
      expect(new URL(linked.headers.get("location") ?? "", env.APP_ORIGIN).pathname).toBe("/settings");
      expect(
        await env.DB.prepare("SELECT email_link_verified FROM user WHERE id='separate-primary-email'").first(),
      ).toEqual({ email_link_verified: 0 });
      const response: Response = await createAuth(env).handler(await oauthCallback("twitch", env, {}));
      expect((await responseViewer(response))?.id).toBe("separate-primary-email");
      expect(
        await env.DB.prepare("SELECT email,email_link_verified FROM user WHERE id='separate-primary-email'").first(),
      ).toEqual({ email: "separate-primary-email@example.test", email_link_verified: 0 });
    } finally {
      twitch();
    }
  });

  it("migrates legacy ownership conservatively and blocks automatic discovery of a historical external Google address", async () => {
    const legacy = await createTestDatabase({ migrate: false });
    const files: string[] = await migrationFiles();
    const authEnv: AppEnv = { ...env, DB: legacy.db, IMAGES: legacy.bucket };
    try {
      await applyMigrations(
        legacy.db,
        files.filter((file) => file < "0025"),
      );
      for (const [id, email, provider, verified] of [
        ["legacy-external", "legacy-external@example.test", "google", 1],
        ["legacy-gmail", "legacy-owner@gmail.com", "google", 1],
        ["legacy-twitch", "legacy-twitch@example.test", "twitch", 1],
        ["legacy-unverified", "legacy-unverified@example.test", "twitch", 0],
        ["legacy-multiple", "legacy-multiple@example.test", "google", 1],
      ] as const) {
        await legacy.db
          .prepare("INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,?,0,0)")
          .bind(id, "Existing viewer", email, verified)
          .run();
        await legacy.db
          .prepare("INSERT INTO account(id,account_id,provider_id,user_id,created_at,updated_at) VALUES(?,?,?,?,0,0)")
          .bind(id, `${id}-subject`, provider, id)
          .run();
      }
      await legacy.db
        .prepare(
          "INSERT INTO account(id,account_id,provider_id,user_id,created_at,updated_at) VALUES('legacy-second','second-subject','twitch','legacy-multiple',0,0)",
        )
        .run();
      await applyMigrations(
        legacy.db,
        files.filter((file) => file >= "0025"),
      );
      const migrated = await legacy.db
        .prepare("SELECT id,email_verified,email_link_verified FROM user WHERE id LIKE 'legacy-%' ORDER BY id")
        .all();
      expect(migrated.results).toEqual([
        { id: "legacy-external", email_verified: 1, email_link_verified: 0 },
        { id: "legacy-gmail", email_verified: 1, email_link_verified: 1 },
        { id: "legacy-multiple", email_verified: 1, email_link_verified: 0 },
        { id: "legacy-twitch", email_verified: 1, email_link_verified: 1 },
        { id: "legacy-unverified", email_verified: 0, email_link_verified: 0 },
      ]);
      const twitch: () => void = stubTwitchIdentity("legacy-intruder", "legacy-external@example.test");
      try {
        const response: Response = await createAuth(authEnv).handler(await oauthCallback("twitch", authEnv, {}));
        expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.get("error")).toBe(
          "account_not_linked",
        );
        expect(await legacy.db.prepare("SELECT id FROM account WHERE account_id='legacy-intruder'").first()).toBeNull();
      } finally {
        twitch();
      }
      const original = stubGoogleIdentity("legacy-external-subject", "legacy-external@example.test");
      try {
        const response: Response = await createAuth(authEnv).handler(await oauthCallback("google", authEnv, {}));
        expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.has("error")).toBe(false);
        expect(
          await legacy.db.prepare("SELECT email_link_verified FROM user WHERE id='legacy-external'").first(),
        ).toEqual({ email_link_verified: 1 });
      } finally {
        original.restore();
      }
      const verifiedTwitch: () => void = stubTwitchIdentity("legacy-now-linked", "legacy-external@example.test");
      try {
        const response: Response = await createAuth(authEnv).handler(await oauthCallback("twitch", authEnv, {}));
        expect(new URL(response.headers.get("location") ?? "", env.APP_ORIGIN).searchParams.has("error")).toBe(false);
        expect(
          await legacy.db.prepare("SELECT user_id FROM account WHERE account_id='legacy-now-linked'").first(),
        ).toEqual({ user_id: "legacy-external" });
      } finally {
        verifiedTwitch();
      }
    } finally {
      await legacy.dispose();
    }
  });
});
