import { useSyncExternalStore, type ReactNode } from "react";
import { personPicture, portraitStyle, streamerPicture, type PictureSource } from "../../lib/avatars";

/* Uploaded pictures keep their URL (`/images/avatar/{id}`), so after an upload in this tab every <img> of that
   URL gets a version parameter and loads the new file. */
let versions: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

/** Call after replacing the image at `url` (avatar, logo or background). */
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

/** `url` with this tab's version of it, if it was replaced here. */
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

/** One round picture: an uploaded image or a preset portrait. Always decorative (the name is next to it). */
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

/**
 * A person's picture: their upload, else their preset, else the default Space explorer (preset 14, item 9).
 * `name` is kept for call sites; the picture never shows initials any more.
 */
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

/**
 * A streamer page's picture everywhere it appears (header, About, directory, admin): the uploaded page logo,
 * else the owner's profile picture, else the default Space explorer (item 18).
 */
export function StreamerLogo({
  streamer,
  className = "",
}: Readonly<{
  streamer: { logo?: string | null; avatar?: string | null; ownerAvatarPreset?: number | null };
  className?: string;
}>): ReactNode {
  return <Picture source={streamerPicture(streamer)} className={className} />;
}
