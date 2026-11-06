import { z } from "zod";
import type { AppContext, AppEnv } from "../../env";
import { getStreamerAccess } from "../access.server";
import { deleteAccount, exportAccount } from "../account.server";
import { configuredProviders, createAuth } from "../auth.server";
import { consumeMutationQuota, getOwnStreamer, setDisplayPrefs, setLocale, updateProfile } from "../data.server";
import { HttpError, json, queryParams, readJson } from "../http.server";
import {
  accountDeletionSchema,
  displayNameSchema,
  displayPrefsSchema,
  localeSchema,
  profileSchema,
} from "../validation";
import { get, write, type ApiRoute } from "./router";

/** The original settings form's name change. `PATCH /api/profile` replaces it. */
const accountSchema = z.object({ name: displayNameSchema }).strict();

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
  // POST /api/account {name} → {viewer}. Kept for the settings page until the profile dialog replaces it.
  write("POST", /account/, async ({ request, env, viewer }) => {
    const input = await readJson(request, accountSchema);
    const profile = await updateProfile(env, viewer.id, { name: input.name });
    return json({ viewer: { ...viewer, ...profile } });
  }),
  write("POST", /account\/delete/, async ({ request, app, env, viewer }) => {
    await readJson(request, accountDeletionSchema);
    await consumeMutationQuota(env, viewer.id);
    await deleteAccount(env, viewer.id);
    await endSession(request, app);
    return json({ deleted: true });
  }),
];
