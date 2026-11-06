import { generateKeyPairSync, sign } from "node:crypto";
import { makeSignature, symmetricDecrypt } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppContext, AppEnv } from "../app/env";
import { configuredProviders, createAuth, getViewer } from "../app/server/auth.server";
import { createTestDatabase } from "./helpers/database";

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
    headers: { cookie: `__Secure-stream-bullets.session_token=${encodeURIComponent(`${token}.${signature}`)}` },
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

async function oauthCallback(provider: "google" | "twitch" = "twitch"): Promise<Request> {
  const clientAddress: string = `192.0.2.${oauthClient++}`;
  const response: Response = await createAuth(env).handler(
    new Request(`${env.APP_ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { origin: env.APP_ORIGIN, "content-type": "application/json", "cf-connecting-ip": clientAddress },
      body: JSON.stringify({ provider, callbackURL: "/" }),
    }),
  );
  expect(response.status).toBe(200);
  const result: { url: string } = (await response.json()) as { url: string };
  const state: string | null = new URL(result.url).searchParams.get("state");
  expect(state).not.toBeNull();
  return new Request(
    `${env.APP_ORIGIN}/api/auth/callback/${provider}?state=${encodeURIComponent(state ?? "")}&code=test-code`,
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
    name: "Google viewer",
    picture: "https://provider.example.test/google-avatar.png",
  })}`;
  const idToken: string = `${tokenBody}.${sign("RSA-SHA256", Buffer.from(tokenBody), privateKey).toString("base64url")}`;
  const mock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url: string = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        tokenRequests.push(new URLSearchParams(await new Request(input, init).text()));
        // The authorization-code flow reads identity from this backchannel ID token;
        // userinfo and JWKS fetches belong to other provider authentication paths.
        return Response.json({
          access_token: "private-google-access-token",
          refresh_token: "private-google-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile",
          id_token: idToken,
        });
      }
      if (new URL(url).hostname.endsWith("googleapis.com") || new URL(url).hostname === "accounts.google.com") {
        throw new Error("Unexpected Google network request in OAuth test");
      }
      return originalFetch(input, init);
    });
  return { restore: (): void => mock.mockRestore(), tokenRequests };
}

function stubTwitchIdentity(subject: string, email: string, name: string = "Twitch viewer"): () => void {
  const originalFetch: typeof fetch = globalThis.fetch;
  const encode = (value: Record<string, unknown>): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const idToken: string = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    sub: subject,
    email,
    email_verified: true,
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
    IMAGES: {} as R2Bucket,
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
        "Set your provider display name to 1 to 40 characters on one line, then sign in again.",
      );
      expect(await env.DB.prepare("SELECT id FROM user WHERE email=?").bind(email).first()).toBeNull();
      expect(
        response.headers
          .getSetCookie()
          .some((value: string) => value.startsWith("__Secure-stream-bullets.session_token=")),
      ).toBe(false);
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
        replay.headers
          .getSetCookie()
          .some((value: string) => value.startsWith("__Secure-stream-bullets.session_token=")),
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
          .some((value: string) => value.startsWith("__Secure-stream-bullets.session_token=")),
      ).toBe(false);
    } finally {
      restore();
    }
  });

  it("does not grant an existing account to a different provider identity with the same email", async () => {
    await seedSession("viewer-implicit-link");
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
          .some((value: string) => value.startsWith("__Secure-stream-bullets.session_token=")),
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
        .some((cookie: string) => cookie.startsWith("__Secure-stream-bullets.session_token=")),
    ).toBe(false);
  });

  it("does not link an additional provider to an existing account", async () => {
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
});
