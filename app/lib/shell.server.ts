import type { AppContext } from "../env";
import { isAdmin } from "../server/access.server";
import { configuredProviders, getViewerSession } from "../server/auth.server";
import { getOwnStreamer } from "../server/data.server";
import type { Viewer } from "../types";
import type { ShellData } from "./shell";

export type ViewerSession = Awaited<ReturnType<typeof getViewerSession>>;

/**
 * The signed-in viewer and their session, looked up once per request. The root loader (shell) and the route loader
 * run in the same request with the same AppContext, so they share one session lookup and one Set-Cookie.
 */
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

/** What every header and the account menu need: who is signed in, their role and their own page. */
export async function loadShell(request: Request, app: AppContext): Promise<ShellData> {
  const viewer: Viewer | null = await requestViewer(request, app);
  const providers = configuredProviders(app.env);
  if (!viewer) return { viewer: null, providers, admin: false, ownStreamer: null };
  const [admin, own] = await Promise.all([isAdmin(app.env, viewer.id), getOwnStreamer(app.env, viewer.id)]);
  return { viewer, providers, admin, ownStreamer: own ? { handle: own.handle, name: own.name } : null };
}
