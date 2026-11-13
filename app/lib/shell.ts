import { useRouteLoaderData } from "react-router";
import { getLocale, type Locale } from "../i18n";
import type { DisplayPrefs, Provider, StreamerStatus, Viewer } from "../types";

export type { Provider } from "../types";

// Shared root loader data.
export interface ShellData {
  viewer: Viewer | null;
  providers: Provider[];
  admin: boolean;
  // Owner's page; frozen/suspended status appears in the account menu.
  ownStreamer: {
    handle: string;
    name: string;
    status: StreamerStatus;
    statusReason: string | null;
    statusChangedAt: number | null;
  } | null;
  // Locale priority: account, cookie, browser, English.
  locale: Locale;
  // Saved account preferences; otherwise browser cookie.
  prefs: DisplayPrefs;
  // APP_ORIGIN for absolute structured-data links.
  origin: string;
}

// Default to signed out if the root loader did not run, such as some 404s.
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

export function shellFromMatches(
  matches: readonly ({ id: string; loaderData?: unknown } | undefined)[],
): ShellData | null {
  const root = matches.find((match) => match?.id === "root");
  return (root?.loaderData as ShellData | undefined) ?? null;
}

// Account settings use ?dialog=profile; /settings redirects there.
export const paths = {
  home: "/",
  streamers: "/streamers",
  profile: "/streamers?dialog=profile",
  admin: "/admin",
  overlayControl: "/overlay-control",
  privacy: "/privacy",
  terms: "/terms",
  reporting: "/terms#reporting",
  // Official board with the suggestion dialog open.
  ideas: "/@streambullets?intent=suggest",
  ai: "/ai",
  streamer: (handle: string): string => `/@${handle}`,
} as const;

// Validate ?next= as a same-origin path. Reject external URLs, backslashes, control characters, and absent values.
export function localPath(value: string | null | undefined): string | null {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    [...value].some(
      (char: string): boolean => char === "\\" || char.codePointAt(0)! < 32 || char.codePointAt(0) === 127,
    )
  )
    return null;
  const base = "https://local.invalid";
  const url = new URL(value, base);
  return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : null;
}

// Replace only the complete /@from segment; /@abcd must not match abc. Return null for other pages.
export function renamedPath(pathname: string, from: string, to: string): string | null {
  const old = `/@${from}`;
  if (pathname !== old && !pathname.startsWith(`${old}/`)) return null;
  return `/@${to}${pathname.slice(old.length)}`;
}
