import { useRouteLoaderData } from "react-router";
import type { Provider, Viewer } from "../types";

export type { Provider } from "../types";

/** The root loader's data: everything the headers, account menu and footer need on every page. */
export interface ShellData {
  viewer: Viewer | null;
  providers: Provider[];
  admin: boolean;
  ownStreamer: { handle: string; name: string } | null;
}

export type ShellRole = "signed-out" | "viewer" | "owner" | "admin";

const signedOut: ShellData = { viewer: null, providers: [], admin: false, ownStreamer: null };

/** Shell data from the root loader. Falls back to signed out where the root loader did not run (some 404s). */
export function useShell(): ShellData {
  return useRouteLoaderData<ShellData>("root") ?? signedOut;
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
  privacy: "/privacy",
  terms: "/terms",
  reporting: "/terms#reporting",
  streamer: (handle: string): string => `/@${handle}`,
} as const;
