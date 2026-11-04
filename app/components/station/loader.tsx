import type { ReactNode } from "react";

/* Loading indicator for the station: a glowing atom drawn and animated entirely in CSS (see
   landing.css). It needs no script, so it moves from the first paint and keeps moving while the
   station is being built on the main thread. */

const ORBITS = ["vertical", "rising", "falling"] as const;

/** Glowing atom shown while the station loads. */
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
