import { useId, type ReactNode } from "react";
import { t } from "../../i18n";
import type { Orientation } from "../../lib/overlay-layers";
import type { OverlayPublic, OverlayState } from "../../types";
import type { OverlaySources } from "../live";
import { CompositionEditor } from "./composition-editor";
import { ConnectionNote } from "./connection-note";
import { OverlayLink } from "./overlay-link";
import type { OverlayScene } from "./overlay-stage";
import { StepHeading } from "./step-heading";
import { useOverlayState } from "./use-overlay-state";

export { controlState } from "./use-overlay-state";

// The Overlay section of Streamer tools. POST /api/overlay saves control changes; live room updates OBS immediately.
export function OverlayControl({
  initial,
  live,
  scene,
  hasOverlayKey,
  sources = null,
  connected = true,
  reconnect,
}: Readonly<{
  initial: OverlayState;
  // Latest live overlay state includes changes from other tabs.
  live?: OverlayPublic | null;
  scene: Omit<OverlayScene, "overlay">;
  // Private-link existence only; never return its key.
  hasOverlayKey: Readonly<Record<Orientation, boolean>>;
  // The connected OBS sources, from the live room. Null while the room did not tell.
  sources?: OverlaySources | null;
  // Offline changes save but reach OBS after reconnect.
  connected?: boolean;
  reconnect?: () => void;
}>): ReactNode {
  const { state, busy, run, keepNewest } = useOverlayState(initial, live);
  const obsId: string = useId();
  const view: OverlayScene = { ...scene, overlay: state };
  return (
    <>
      <ConnectionNote connected={connected} reconnect={reconnect} />
      <CompositionEditor scene={view} state={state} busy={busy} run={run} onSaved={keepNewest} />
      <section className="ov-step" aria-labelledby={obsId} data-step="obs">
        <StepHeading step={2} id={obsId} title={t("overlay.step.obs")} />
        <OverlayLink hasKey={hasOverlayKey} layers={state.layers} sources={sources} now={scene.now} />
      </section>
    </>
  );
}
