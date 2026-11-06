import type { ReactNode } from "react";

/** A person's or a page's picture, or the first letter of the name when there is none. Always decorative. */
export function Avatar({
  name,
  url,
  className = "",
}: Readonly<{
  name: string;
  url: string | null;
  className?: string;
}>): ReactNode {
  return url ? (
    <img className={`user-avatar ${className}`.trim()} src={url} alt="" loading="lazy" />
  ) : (
    <span className={`user-avatar avatar-initial ${className}`.trim()} aria-hidden="true">
      {name.trim().slice(0, 1).toUpperCase() || "S"}
    </span>
  );
}
