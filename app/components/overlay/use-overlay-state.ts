import { useState } from "react";
import { onAnyOutput, type LayersPatch } from "../../lib/overlay-layers";
import type { OverlayPublic, OverlayState } from "../../types";
import { errorMessage, postJson } from "../api";
import { useToast } from "../ui/toast";
import type { OverlayAction } from "./layer-properties";

// Use the newest saved, loaded or live overlay state. A live message has the message only while the message layer
// is on stream. Otherwise keep the draft until a reload catches up.
export function controlState(
  saved: OverlayState,
  loaded: OverlayState,
  live: OverlayPublic | null | undefined,
): OverlayState {
  const base: OverlayState = loaded.revision > saved.revision ? loaded : saved;
  if (!live || live.revision <= base.revision) return base;
  return { ...live, message: onAnyOutput(live.layers, "message") ? live.message : base.message };
}

/** A change of some layer fields, as POST /api/overlay takes it. */
export type LayersChange = { action: "layers" } & LayersPatch;
export type ControlAction = OverlayAction | LayersChange;

export interface OverlayControlState {
  /** The newest state: saved here, loaded, or from the live room. */
  state: OverlayState;
  /** True while a save of `send` runs. */
  busy: boolean;
  /** Saves an action. False when the server refused it: a toast then gives the reason. */
  send: (action: ControlAction) => Promise<boolean>;
  /** `send` for an event handler. */
  run: (action: ControlAction) => void;
  /** Takes a saved state from another save path. An older revision does not replace a newer one. */
  keepNewest: (next: OverlayState) => void;
}

/**
 * The overlay state of a section of Streamer tools. POST /api/overlay saves control changes; the live room updates
 * OBS immediately.
 */
export function useOverlayState(initial: OverlayState, live: OverlayPublic | null | undefined): OverlayControlState {
  const toast = useToast();
  const [saved, setSaved] = useState<OverlayState>(initial);
  const [busy, setBusy] = useState<boolean>(false);
  // Save responses can arrive out of order; an older revision must not replace a newer one.
  const keepNewest = (next: OverlayState): void =>
    setSaved((prev: OverlayState): OverlayState => (next.revision >= prev.revision ? next : prev));

  async function send(action: ControlAction): Promise<boolean> {
    setBusy(true);
    try {
      const result = await postJson<{ overlay: OverlayState }>("/api/overlay", action);
      keepNewest(result.overlay);
      return true;
    } catch (error: unknown) {
      toast(errorMessage(error), { tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  }
  const run = (action: ControlAction): void => {
    void send(action);
  };
  return { state: controlState(saved, initial, live), busy, send, run, keepNewest };
}
