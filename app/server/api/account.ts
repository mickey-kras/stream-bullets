import type { AppContext, AppEnv } from "../../env";
import type { Provider } from "../../types";
import { getStreamerAccess } from "../access.server";
import { deleteAccount, exportAccount } from "../account.server";
import { configuredProviders, createAuth } from "../auth.server";
import { consumeMutationQuota, getOwnStreamer, setDisplayPrefs, setLocale, updateProfile } from "../data.server";
import { HttpError, json, queryParams, readJson } from "../http.server";
import { accountDeletionSchema, displayPrefsSchema, localeSchema, profileSchema } from "../validation";
import { get, write, type ApiRoute } from "./router";

/** The provider this account signs in with ("Signed in with TikTok" in Your profile and Your data). */
async function signInProvider(env: AppEnv, userId: string): Promise<Provider | null> {
  const row = await env.DB.prepare("SELECT provider_id FROM account WHERE user_id=? ORDER BY created_at LIMIT 1")
    .bind(userId)
    .first<{ provider_id: string }>();
  const provider = row?.provider_id;
  return provider === "google" || provider === "tiktok" || provider === "twitch" || provider === "instagram"
    ? provider
    : null;
}

async function exportResponse(request: Request, env: AppEnv, viewerId: string | null): Promise<Response> {
  queryParams(request, []);
  if (request.headers.get("Sec-Fetch-Site") === "cross-site")
    throw new HttpError(403, "Use this site to download your data.");
  if (!viewerId) throw new HttpError(401, "Sign in to continue.");
  await consumeMutationQuota(env, viewerId, true);
  const data = await exportAccount(env, viewerId);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="streambullets-data-${data.exportedAt.slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Ends the deleted account's browser session. Better Auth expires its cookies with their original attributes. */
async function endSession(request: Request, app: AppContext): Promise<void> {
  const { headers } = await createAuth(app.env).api.signOut({ headers: request.headers, returnHeaders: true });
  // Drop any refreshed session cookie that was queued while reading the viewer.
  app.responseHeaders.delete("Set-Cookie");
  for (const cookie of headers.getSetCookie()) app.responseHeaders.append("Set-Cookie", cookie);
}

/** The signed-in account: profile, language, display preferences, data export and deletion. */
export const accountRoutes: ApiRoute[] = [
  get(/me/, async ({ request, env, viewer }) => {
    queryParams(request, []);
    return json({
      viewer,
      streamer: viewer ? await getOwnStreamer(env, viewer.id) : null,
      access: viewer ? await getStreamerAccess(env, viewer.id) : null,
      providers: configuredProviders(env),
      signInProvider: viewer ? await signInProvider(env, viewer.id) : null,
    });
  }),
  get(/account\/export/, async ({ request, env, viewer }) => exportResponse(request, env, viewer?.id ?? null)),

  // PATCH /api/profile {name?, avatarPreset?: 0..17 | null} → {viewer}
  write("PATCH", /profile/, async ({ request, env, viewer }) => {
    const profile = await updateProfile(env, viewer.id, await readJson(request, profileSchema));
    return json({ viewer: { ...viewer, ...profile } });
  }),
  // PATCH /api/me/locale {locale: Locale | null} → {locale}
  write("PATCH", /me\/locale/, async ({ request, env, viewer }) =>
    json({ locale: await setLocale(env, viewer.id, await readJson(request, localeSchema)) }),
  ),
  // PATCH /api/me/preferences {...DisplayPrefs} → {preferences}
  write("PATCH", /me\/preferences/, async ({ request, env, viewer }) =>
    json({ preferences: await setDisplayPrefs(env, viewer.id, await readJson(request, displayPrefsSchema)) }),
  ),
  write("POST", /account\/delete/, async ({ request, app, env, viewer }) => {
    await readJson(request, accountDeletionSchema);
    await consumeMutationQuota(env, viewer.id);
    await deleteAccount(env, viewer.id);
    await endSession(request, app);
    return json({ deleted: true });
  }),
];
