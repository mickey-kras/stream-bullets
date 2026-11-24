import { z } from "zod";
import { LOCALES } from "../../i18n";
import { LOCALE_COOKIE } from "../../i18n/resolve";
import { PREFS_COOKIE } from "../../lib/prefs";
import { getOrigin, readJson } from "../http.server";
import { displayPrefsSchema } from "../validation";
import { openWrite, type ApiRoute } from "./router";

// `POST /api/preference-cookies`: the language and display preferences to keep in this browser.
export const preferenceCookiesSchema = z
  .object({ locale: z.enum(LOCALES).optional(), prefs: displayPrefsSchema.optional() })
  .strict();

const ONE_YEAR_S = 31_536_000;

// Preserve existing cookie names and values when upgrading their attributes.
export function preferenceCookies(value: z.infer<typeof preferenceCookiesSchema>, secure: boolean): string[] {
  const cookie = (name: string, text: string): string =>
    `${name}=${encodeURIComponent(text)}; Path=/; Max-Age=${ONE_YEAR_S}; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`;
  const cookies: string[] = [];
  if (value.locale) cookies.push(cookie(LOCALE_COOKIE, value.locale));
  if (value.prefs) cookies.push(cookie(PREFS_COOKIE, JSON.stringify(value.prefs)));
  return cookies;
}

// Signed-out visitors can save preferences on this origin.
export const cookieRoutes: ApiRoute[] = [
  // POST /api/preference-cookies {locale?, prefs?} → 204 with Set-Cookie
  openWrite("POST", /preference-cookies/, async ({ request, env }) => {
    const value = await readJson(request, preferenceCookiesSchema);
    const headers = new Headers({ "Cache-Control": "no-store" });
    for (const cookie of preferenceCookies(value, getOrigin(env).startsWith("https:")))
      headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 204, headers });
  }),
];
