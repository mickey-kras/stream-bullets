import { useContext, useId, type ReactNode } from "react";
import { t, type MessageId } from "../../i18n";
import { ORIENTATIONS, type GridLayer, type Orientation, type OverlayLayers } from "../../lib/overlay-layers";
import { toolsPath } from "../../lib/shell";
import { ControlApiContext } from "../overlay/control-api";
import { StepHeading } from "../overlay/step-heading";

/**
 * One part of the Live section: a titled panel. `name` is for styles and tests. `action` is a control beside the
 * title, at the end of the title line.
 */
export function LivePart({
  name,
  title,
  action,
  children,
}: Readonly<{ name: string; title: string; action?: ReactNode; children: ReactNode }>): ReactNode {
  const id: string = useId();
  const heading: ReactNode = <StepHeading id={id} title={title} />;
  return (
    <section className="ov-step tl-part" aria-labelledby={id} data-live-part={name}>
      {action ? (
        <div className="tl-part-head">
          {heading}
          {action}
        </div>
      ) : (
        heading
      )}
      {children}
    </section>
  );
}

/** True when `layer` has a cell in an output, so "Show on stream" can put it on air. */
export function placed(layers: OverlayLayers, layer: GridLayer): boolean {
  return ORIENTATIONS.some((output: Orientation): boolean => layers.cells[output][layer] !== null);
}

const NOT_ON_GRID: Readonly<Record<"poll" | "topic" | "message", MessageId>> = {
  poll: "tools.live.notOnGrid.poll",
  topic: "tools.live.notOnGrid.topic",
  message: "tools.live.notOnGrid.message",
};

/**
 * The note for a layer without a place on the grid: Live does not choose a place on stream for the owner. The link
 * opens the Overlay section, where the owner puts the layer on the grid.
 */
export function NotOnGrid({ layer }: Readonly<{ layer: "poll" | "topic" | "message" }>): ReactNode {
  // The dock has no session, so a link to Streamer tools leads nowhere there.
  const session: boolean = useContext(ControlApiContext).key === null;
  return (
    <p className="muted tl-note" data-live-not-on-grid={layer}>
      {t(NOT_ON_GRID[layer])}{" "}
      {session && (
        <a className="text-link" href={toolsPath("overlay")}>
          {t("tools.live.openOverlay")}
        </a>
      )}
    </p>
  );
}
