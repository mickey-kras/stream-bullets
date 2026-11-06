import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router";
import { t } from "../../i18n";
import { paths } from "../../lib/shell";
import { Icon } from "../ui/icon";

const storageKey = "sb.lastContent";

interface ContentRoute {
  href: string;
  label: string;
}

/**
 * Records the last content route (a streamer page now, the Streamers directory in P3) so a back link on Settings,
 * Admin, the legal pages or a 404 returns there. Call it from content routes with their exact URL and name.
 */
export function useRememberContentRoute(href: string, label: string): void {
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ href, label } satisfies ContentRoute));
    } catch {
      // Storage can be unavailable (private mode, blocked site data); the link then falls back to Streamers.
    }
  }, [href, label]);
}

/** The stored JSON string. A string snapshot stays stable between renders, unlike a parsed object. */
function storedContentRoute(): string | null {
  try {
    return sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

/** The back link reads storage once at mount, so it does not subscribe to changes. */
function noSubscription(): () => void {
  return () => undefined;
}

function parseContentRoute(stored: string | null): ContentRoute | null {
  try {
    const value: unknown = JSON.parse(stored ?? "null");
    if (
      value &&
      typeof value === "object" &&
      typeof (value as ContentRoute).href === "string" &&
      (value as ContentRoute).href.startsWith("/") &&
      !(value as ContentRoute).href.startsWith("//") &&
      typeof (value as ContentRoute).label === "string"
    )
      return value as ContentRoute;
  } catch {
    // Fall back to Streamers.
  }
  return null;
}

/** "‹ Back to {name}": the first element of the page column on Settings, Admin, the legal pages and 404. */
export function BackLink(): ReactNode {
  // The server snapshot is null, so the hydrated markup matches and the stored route appears after hydration.
  const stored: string | null = useSyncExternalStore(noSubscription, storedContentRoute, () => null);
  const target: ContentRoute | null = parseContentRoute(stored);
  return (
    <Link className="back-link" to={target?.href ?? paths.streamers}>
      <Icon name="chevron-left" size={16} />
      {t("shell.backTo", { name: target?.label ?? t("nav.streamers") })}
    </Link>
  );
}
