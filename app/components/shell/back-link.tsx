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

// Remember exact content-route URL/name for back links from account, Admin, legal and error pages.
export function useRememberContentRoute(href: string, label: string): void {
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ href, label } satisfies ContentRoute));
    } catch {
      // Blocked storage falls back to Streamers.
    }
  }, [href, label]);
}

// String snapshots remain stable across renders.
function storedContentRoute(): string | null {
  try {
    return sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

// Read once on mount; no subscription.
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
    // Invalid or blocked storage falls back to Streamers.
  }
  return null;
}

export function BackLink(): ReactNode {
  // Null server snapshot preserves hydration; restore the route afterward.
  const stored: string | null = useSyncExternalStore(noSubscription, storedContentRoute, () => null);
  const target: ContentRoute | null = parseContentRoute(stored);
  return (
    <Link className="back-link" to={target?.href ?? paths.streamers}>
      <Icon name="chevron-left" size={16} />
      {t("shell.backTo", { name: target?.label ?? t("nav.streamers") })}
    </Link>
  );
}
