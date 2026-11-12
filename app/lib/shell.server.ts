import type { AppContext } from "../env";
import { readCookie, requestLocale } from "../i18n/resolve";
import { isAdmin } from "../server/access.server";
import { configuredProviders, getViewerSession } from "../server/auth.server";
import { getOwnStreamer } from "../server/data.server";
import { readDisplayPrefs } from "../server/validation";
import type { DisplayPrefs, Viewer } from "../types";
import { PREFS_COOKIE } from "./prefs";
import type { ShellData } from "./shell";

export type ViewerSession = Awaited<ReturnType<typeof getViewerSession>>;

// Share one session lookup and Set-Cookie across root/route loaders through their request AppContext.
const sessions = new WeakMap<AppContext, Promise<ViewerSession>>();

export function requestSession(request: Request, app: AppContext): Promise<ViewerSession> {
  let session: Promise<ViewerSession> | undefined = sessions.get(app);
  if (!session) {
    session = getViewerSession(request, app);
    sessions.set(app, session);
  }
  return session;
}

export async function requestViewer(request: Request, app: AppContext): Promise<Viewer | null> {
  return (await requestSession(request, app))?.viewer ?? null;
}

export async function loadShell(request: Request, app: AppContext): Promise<ShellData> {
  const viewer: Viewer | null = await requestViewer(request, app);
  const providers = configuredProviders(app.env);
  const locale = requestLocale(request, viewer?.locale ?? null);
  // Render locale for entry.server.tsx.
  app.locale = locale;
  const prefs: DisplayPrefs =
    viewer?.displayPrefs ?? readDisplayPrefs(readCookie(request.headers.get("Cookie"), PREFS_COOKIE)) ?? {};
  const page = { providers, locale, prefs, origin: app.env.APP_ORIGIN };
  if (!viewer) return { viewer: null, admin: false, ownStreamer: null, ...page };
  const [admin, own] = await Promise.all([isAdmin(app.env, viewer.id), getOwnStreamer(app.env, viewer.id)]);
  const ownStreamer = own
    ? {
        handle: own.handle,
        name: own.name,
        status: own.status,
        statusReason: own.statusReason,
        statusChangedAt: own.statusChangedAt,
      }
    : null;
  return { viewer, admin, ownStreamer, ...page };
}
