import type { ReactNode } from "react";

// CSS/compositor atom animates from first paint while model construction occupies the main thread.

const ORBITS = ["vertical", "rising", "falling"] as const;

export function AtomLoader({ label }: Readonly<{ label: string }>): ReactNode {
  return (
    <output className="station-loader" aria-label={label}>
      {ORBITS.map(
        (orbit: (typeof ORBITS)[number]): ReactNode => (
          <span className="atom-orbit" key={orbit} aria-hidden="true">
            <span className="atom-spin">
              <span className="atom-trail" />
              <span className="atom-head" />
            </span>
          </span>
        ),
      )}
    </output>
  );
}
