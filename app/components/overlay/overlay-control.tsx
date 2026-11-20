import { useEffect, useId, useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { onStream } from "../../lib/overlay-layers";
import type { OverlayPublic, OverlayState } from "../../types";
import { announce } from "../a11y/announcer";
import { errorMessage, postJson } from "../api";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { CompositionEditor } from "./composition-editor";
import type { OverlayAction } from "./layer-properties";
import { OverlayLink } from "./overlay-link";
import type { OverlayScene } from "./overlay-stage";
import { StepHeading } from "./step-heading";

// Use the newest saved, loaded or live overlay state. A live message has the message only while the message layer
// is on stream. Otherwise keep the draft until a reload catches up.
export function controlState(
  saved: OverlayState,
  loaded: OverlayState,
  live: OverlayPublic | null | undefined,
): OverlayState {
  const base: OverlayState = loaded.revision > saved.revision ? loaded : saved;
  if (!live || live.revision <= base.revision) return base;
  return { ...live, message: onStream(live.layers, "message") ? live.message : base.message };
}

// POST /api/overlay saves control changes; live room updates OBS immediately.
export function OverlayControl({
  initial,
  live,
  scene,
  hasOverlayKey,
  connected = true,
  reconnect,
  channels,
}: Readonly<{
  initial: OverlayState;
  // Latest live overlay state includes changes from other tabs.
  live?: OverlayPublic | null;
  scene: Omit<OverlayScene, "overlay">;
  // Private-link existence only; never return its key.
  hasOverlayKey: boolean;
  // Offline changes save but reach OBS after reconnect.
  connected?: boolean;
  reconnect?: () => void;
  // The channel connections section: the first step of the page.
  channels?: ReactNode;
}>): ReactNode {
  const toast = useToast();
  const [saved, setSaved] = useState<OverlayState>(initial);
  const state: OverlayState = controlState(saved, initial, live);
  const [busy, setBusy] = useState<boolean>(false);
  const offline: boolean = reconnect !== undefined;
  useEffect(() => {
    if (!connected) announce(t(offline ? "overlay.offline" : "overlay.disconnected"));
  }, [connected, offline]);
  const obsId: string = useId();
  const view: OverlayScene = { ...scene, overlay: state };
  // Save responses can arrive out of order; an older revision must not replace a newer one.
  const keepNewest = (next: OverlayState): void =>
    setSaved((prev: OverlayState): OverlayState => (next.revision >= prev.revision ? next : prev));

  async function send(action: OverlayAction): Promise<void> {
    setBusy(true);
    try {
      const result = await postJson<{ overlay: OverlayState }>("/api/overlay", action);
      keepNewest(result.overlay);
    } catch (error: unknown) {
      toast(errorMessage(error), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  const run = (action: OverlayAction): void => {
    void send(action);
  };
  return (
    <>
      <div className="ov-head">
        <div>
          <span className="eyebrow">{t("overlay.eyebrow")}</span>
          <h1>{t("overlay.controlTitle")}</h1>
        </div>
      </div>
      {!connected && (
        <p className="ov-conn">
          <Icon name="wifi-off" size={18} />
          <span>
            <strong>{t(offline ? "overlay.offline" : "overlay.disconnected")}</strong> {t("overlay.disconnectedBody")}
          </span>
          {reconnect && (
            <button type="button" onClick={reconnect}>
              {t("overlay.reconnect")}
            </button>
          )}
        </p>
      )}
      {channels}
      <CompositionEditor scene={view} state={state} busy={busy} run={run} onSaved={keepNewest} />
      <section className="ov-step" aria-labelledby={obsId} data-step="obs">
        <StepHeading step={3} id={obsId} title={t("overlay.step.obs")} />
        <OverlayLink hasKey={hasOverlayKey} layers={state.layers} />
      </section>
    </>
  );
}
