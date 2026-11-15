import type { ReactNode } from "react";
import type { ActivityPlatform } from "../../../lib/activity";

/*
 * The chat card artwork, drawn in code in currentColor. The platform icons are monochrome outline shapes from the
 * approved reference (issue #663). Each platform has its own silhouette, so colour is never the only cue.
 */

function IconPaths({ platform }: Readonly<{ platform: ActivityPlatform }>): ReactNode {
  if (platform === "youtube")
    return (
      <>
        <rect x="2" y="5" width="20" height="14" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <path fill="currentColor" d="m10 8 6 4-6 4z" />
      </>
    );
  if (platform === "twitch")
    return (
      <>
        <path fill="currentColor" d="M4 2h18v13l-6 6h-5l-4 3v-3H2V6zm1 3v12h5v3l3-3h4l3-3V5z" />
        <path stroke="currentColor" strokeWidth="2" d="M11 7v6m5-6v6" />
      </>
    );
  return <path fill="currentColor" d="M3 3h5v7h3V7h3V3h7v6h-4v3h-3v2h3v3h4v4h-7v-3h-3v-3H8v6H3z" />;
}

/**
 * The platform icon. The drawing is hidden from assistive technology; the platform name is visually hidden text
 * after it, so a screen reader reads the name before the user name.
 */
export function PlatformIcon({
  platform,
  label,
  className,
}: Readonly<{ platform: ActivityPlatform; label: string; className?: string }>): ReactNode {
  return (
    <>
      <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-platform={platform}>
        <IconPaths platform={platform} />
      </svg>
      <span className="sr-only">{`${label} `}</span>
    </>
  );
}

/** The vault mark at the right end of each card: a ring with a hub and two pairs of side ticks. Decorative. */
export function VaultMark({ className }: Readonly<{ className?: string }>): ReactNode {
  return (
    <svg className={className} viewBox="0 0 36 24" aria-hidden="true" focusable="false">
      <path d="M1 9h10M1 15h10M25 9h10M25 15h10" />
      <circle cx="18" cy="12" r="9" />
      <circle cx="18" cy="12" r="4" />
    </svg>
  );
}
