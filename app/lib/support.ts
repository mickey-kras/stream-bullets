import { t, type MessageId } from "../i18n";
import type { SupportLinkKind } from "../types";
import { isPlainUrlText } from "./url-text";

export interface SupportProvider {
  // Button label; other uses the owner's label.
  label: string;
  // Allow www. prefixes. Empty host list permits any public host (other).
  hosts: readonly string[];
  // Required path prefix, such as /subs/ for Twitch.
  pathPrefix?: string;
  icon: "gift" | "heart" | "star" | "link";
}

// External links only; no payment handling. Restrict each provider to its own domain.
export const SUPPORT_PROVIDERS: Readonly<Record<SupportLinkKind, SupportProvider>> = {
  kofi: { label: "Ko-fi", hosts: ["ko-fi.com"], icon: "gift" },
  patreon: { label: "Patreon", hosts: ["patreon.com"], icon: "heart" },
  bmac: { label: "Buy Me a Coffee", hosts: ["buymeacoffee.com"], icon: "gift" },
  paypal: { label: "PayPal.me", hosts: ["paypal.me"], icon: "heart" },
  streamlabs: { label: "Streamlabs tip page", hosts: ["streamlabs.com"], icon: "heart" },
  streamelements: { label: "StreamElements tip page", hosts: ["streamelements.com"], icon: "heart" },
  twitch: { label: "Twitch subscribe", hosts: ["twitch.tv"], pathPrefix: "/subs/", icon: "star" },
  youtube: { label: "YouTube memberships", hosts: ["youtube.com"], icon: "star" },
  other: { label: "Other", hosts: [], icon: "link" },
};

// HTTPS provider URL with a non-root path.
export function isAllowedSupportLink(kind: SupportLinkKind, url: string): boolean {
  if (url.length > 500 || !isPlainUrlText(url) || !URL.canParse(url)) return false;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
  const host = parsed.hostname.toLowerCase();
  const provider = SUPPORT_PROVIDERS[kind];
  if (provider.hosts.length === 0) {
    // Public hostname: contains a dot and letters; excludes IP addresses.
    return host.includes(".") && /[a-z]/.test(host) && !host.startsWith("[") && !/^[\d.]+$/.test(host);
  }
  if (!provider.hosts.some((allowed: string): boolean => host === allowed || host === `www.${allowed}`)) return false;
  const path = parsed.pathname;
  if (provider.pathPrefix)
    return path.toLowerCase().startsWith(provider.pathPrefix) && path.length > provider.pathPrefix.length;
  return path.length > 1;
}

// Translate generic names; retain brands.
const PROVIDER_WORDS: Partial<Record<SupportLinkKind, MessageId>> = {
  streamlabs: "support.provider.streamlabs",
  streamelements: "support.provider.streamelements",
  twitch: "support.provider.twitch",
  youtube: "support.provider.youtube",
  other: "support.provider.other",
};

export function providerLabel(kind: SupportLinkKind): string {
  const id: MessageId | undefined = PROVIDER_WORDS[kind];
  return id ? t(id) : SUPPORT_PROVIDERS[kind].label;
}

export function supportLabel(link: { kind: SupportLinkKind; label: string | null }): string {
  return link.kind === "other" ? link.label || t("support.fallbackLabel") : providerLabel(link.kind);
}
