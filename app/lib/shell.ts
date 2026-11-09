import { useRouteLoaderData } from "react-router";
import { getLocale, type Locale } from "../i18n";
import type { DisplayPrefs, Provider, StreamerStatus, Viewer } from "../types";

export type { Provider } from "../types";

/** The root loader's data: everything the headers, account menu and footer need on every page. */
export interface ShellData {
  viewer: Viewer | null;
  providers: Provider[];
  admin: boolean;
  /** The viewer's own page. A frozen or suspended page shows its owner a notice in the account menu (R13). */
  ownStreamer: {
    handle: string;
    name: string;
    status: StreamerStatus;
    statusReason: string | null;
    statusChangedAt: number | null;
  } | null;
  /** The page's language: the account's, then the cookie's, then the browser's, then English. */
  locale: Locale;
  /** Display preferences: the account's when signed in and saved, else this browser's cookie. */
  prefs: DisplayPrefs;
  /** The site's origin (APP_ORIGIN), for absolute links in structured data. */
  origin: string;
}

export type ShellRole = "signed-out" | "viewer" | "owner" | "admin";

/** Shell data from the root loader. Falls back to signed out where the root loader did not run (some 404s). */
export function useShell(): ShellData {
  return (
    useRouteLoaderData<ShellData>("root") ?? {
      viewer: null,
      providers: [],
      admin: false,
      ownStreamer: null,
      locale: getLocale(),
      prefs: {},
      origin: "",
    }
  );
}

/** The root loader's data inside a route's `meta` function. */
export function shellFromMatches(
  matches: readonly ({ id: string; loaderData?: unknown } | undefined)[],
): ShellData | null {
  const root = matches.find((match) => match?.id === "root");
  return (root?.loaderData as ShellData | undefined) ?? null;
}

export function shellRole(shell: ShellData): ShellRole {
  if (!shell.viewer) return "signed-out";
  if (shell.admin) return "admin";
  return shell.ownStreamer ? "owner" : "viewer";
}

/** App paths the shell links to. Account settings are dialogs (`?dialog=profile`); /settings redirects there. */
export const paths = {
  home: "/",
  streamers: "/streamers",
  profile: "/streamers?dialog=profile",
  admin: "/admin",
  overlayControl: "/overlay-control",
  privacy: "/privacy",
  terms: "/terms",
  reporting: "/terms#reporting",
  /** The official Ideas board, with Suggest an improvement open (item 46). */
  ideas: "/@streambullets?intent=suggest",
  ai: "/ai",
  streamer: (handle: string): string => `/@${handle}`,
} as const;

/**
 * Where a page under `/@from` moves when that handle becomes `to`, or null when `pathname` is not on that page.
 * Only the whole first segment counts, so `/@abcd` is not a page of `abc`.
 */
export function renamedPath(pathname: string, from: string, to: string): string | null {
  const old = `/@${from}`;
  if (pathname !== old && !pathname.startsWith(`${old}/`)) return null;
  return `/@${to}${pathname.slice(old.length)}`;
}
