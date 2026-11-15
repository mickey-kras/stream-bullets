import { useSyncExternalStore, type ReactNode } from "react";
import { personPicture, portraitStyle, streamerPicture, type PictureSource } from "../../lib/avatars";

// Images retain URLs; tab-local version parameters refresh every instance after replacement.
let versions: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

// Call after replacing an avatar, logo or background URL.
export function bumpImage(url: string): void {
  const updated = new Map(versions);
  updated.set(url.split("?")[0], Date.now());
  versions = updated;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Append this tab's replacement version.
export function useImageUrl(url: string | null): string | null {
  const map = useSyncExternalStore(
    subscribe,
    () => versions,
    () => versions,
  );
  if (!url || url.startsWith("blob:")) return url;
  const version: number | undefined = map.get(url.split("?")[0]);
  if (!version) return url;
  const separator: string = url.includes("?") ? "&" : "?";
  return `${url}${separator}v=${version}`;
}

function Photo({ url, className }: Readonly<{ url: string; className: string }>): ReactNode {
  return <img className={`user-avatar ${className}`.trim()} src={useImageUrl(url) ?? url} alt="" loading="lazy" />;
}

// Decorative image; adjacent text provides the name.
export function Picture({
  source,
  className = "",
}: Readonly<{ source: PictureSource; className?: string }>): ReactNode {
  if (source.kind === "photo") return <Photo url={source.url} className={className} />;
  return (
    <span
      className={`user-avatar portrait ${className}`.trim()}
      style={portraitStyle(source.preset)}
      data-preset={source.preset}
      aria-hidden="true"
    />
  );
}

// Fallback: upload, preset, default Space explorer (14). Keep name for existing callers; never show initials.
export function Avatar({
  url,
  preset = null,
  className = "",
}: Readonly<{
  name?: string;
  url: string | null;
  preset?: number | null;
  className?: string;
}>): ReactNode {
  return <Picture source={personPicture(url, preset)} className={className} />;
}

// Page image fallback: logo, owner picture, default Space explorer.
export function StreamerLogo({
  streamer,
  className = "",
}: Readonly<{
  streamer: { logo?: string | null; avatar?: string | null; ownerAvatarPreset?: number | null };
  className?: string;
}>): ReactNode {
  return <Picture source={streamerPicture(streamer)} className={className} />;
}
