import { useEffect, useMemo, useRef, useState } from "react";
import {
  diffLayers,
  isEmptyPatch,
  layersAction,
  mergePatches,
  withoutSent,
  type LayersWrite,
} from "../../lib/layer-geometry";
import { mergeLayers, type LayersPatch, type OverlayLayers } from "../../lib/overlay-layers";
import type { OverlayState } from "../../types";
import { errorMessage, postJson, sendJson } from "../api";

/** Keyboard edits save after this much idle time. Drags and buttons save at once. */
const SAVE_IDLE_MS = 400;

export type SaveStatus = "idle" | "saving" | "saved";

/**
 * An error to show under the editor. `leaving` is true for the error of a change sent while leaving the editor, false
 * for the error of a save while the editor is open.
 */
export interface EditorError {
  message: string;
  leaving: boolean;
}

/** A failed change sent while leaving shows in the next editor only within this time. Later it is stale. */
const LEAVE_FAILURE_MS = 60_000;

/**
 * The error of a change sent while leaving the editor, with the local time it came. The editor is gone when the
 * answer comes, so the next editor on this page shows it (after in-app navigation back), if it opens within
 * LEAVE_FAILURE_MS. After a back-forward cache restore the same editor shows it.
 */
let leaveFailure: { message: string; at: number } | null = null;
/** The open editors: one that shows when a change sent while leaving fails, if the answer comes after it opened. */
const leaveListeners = new Set<(error: EditorError) => void>();

/** The stored error of a change sent while leaving, unless it is stale. */
function freshLeaveFailure(): EditorError | null {
  if (!leaveFailure || Date.now() - leaveFailure.at >= LEAVE_FAILURE_MS) return null;
  return { message: leaveFailure.message, leaving: true };
}

/** A save request in flight: the fields it sends and a promise that settles when it is answered. */
interface Inflight {
  sent: LayersPatch;
  done: Promise<void>;
}

function ignore(): void {
  // A settled request; its result is handled where it was sent.
}

/** A random id for one editor. The server orders the writes of one editor by their numbers. */
function newWriter(): string {
  return crypto.randomUUID();
}

/** The next write of an editor: its id and the next number. */
function nextWrite(writer: string, seq: { current: number }): LayersWrite {
  seq.current += 1;
  return { writer, seq: seq.current };
}

export type EditTiming = "now" | "idle";

/**
 * Optimistic layer edits, tracked per field. Local changes show at once over the newest saved or live layers and save
 * in the background, one request at a time. A request sends only the fields changed since the last request, so an
 * edit made in another tab is never reverted. A failed save rolls back only the fields of that request, reports the
 * error and still saves later edits.
 *
 * Each request carries this editor's id and the next write number. The server ignores a write of this editor with a
 * number that it already passed, so a request that arrives late (a save in flight when the page is left) never
 * overwrites a newer one.
 */
export function useLayerDraft(
  layers: OverlayLayers,
  onSaved: (overlay: OverlayState) => void,
): {
  shown: OverlayLayers;
  status: SaveStatus;
  error: EditorError | null;
  edit: (change: (current: OverlayLayers) => OverlayLayers, when: EditTiming) => void;
} {
  // Every unconfirmed local field (sent or not), and the subset not sent yet.
  const [draft, setDraft] = useState<LayersPatch>({});
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<EditorError | null>(freshLeaveFailure);
  const draftRef = useRef<LayersPatch>({});
  const unsent = useRef<LayersPatch>({});
  const inflight = useRef<Inflight | null>(null);
  const savedRef = useRef<OverlayLayers>(layers);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef<boolean>(false);
  const again = useRef<boolean>(false);
  const savedCallback = useRef(onSaved);
  const [writer] = useState<string>(newWriter);
  const seq = useRef<number>(0);
  useEffect(() => {
    savedRef.current = layers;
    savedCallback.current = onSaved;
  }, [layers, onSaved]);

  const setBoth = (next: LayersPatch): void => {
    draftRef.current = next;
    setDraft(next);
  };

  // Leaving the page or closing the editor sends the edits not sent yet, without waiting for the answer. Closing the
  // editor (the page stays) sends them after the save in flight is answered. Leaving the page cannot wait, so it sends
  // the fields in flight again with the newer ones in one request, with a higher write number: if the older request
  // arrives last, the server ignores it.
  useEffect(() => {
    // The error of an earlier editor is now on screen. A later one shows when it comes.
    leaveFailure = null;
    leaveListeners.add(setError);
    const leave = (closing: boolean): void => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const pending: LayersPatch = unsent.current;
      if (isEmptyPatch(pending)) return;
      unsent.current = {};
      const active: Inflight | null = inflight.current;
      const send = (patch: LayersPatch): Promise<{ overlay: OverlayState }> =>
        sendJson<{ overlay: OverlayState }>("POST", "/api/overlay", layersAction(patch, nextWrite(writer, seq)), {
          keepalive: true,
        });
      let request: Promise<{ overlay: OverlayState }>;
      if (!active) request = send(pending);
      else if (closing) request = active.done.then(() => send(pending));
      else request = send(mergePatches(active.sent, pending));
      // The draft keeps the values until the answer, so a restored page shows them meanwhile.
      request.then(
        (result: { overlay: OverlayState }): void => {
          savedCallback.current(result.overlay);
          setBoth(withoutSent(draftRef.current, pending));
        },
        (error_: unknown): void => {
          const message: string = errorMessage(error_);
          // An editor that is open (this one after a back-forward cache restore, or the next one) shows it at once.
          if (leaveListeners.size === 0) leaveFailure = { message, at: Date.now() };
          for (const listener of leaveListeners) listener({ message, leaving: true });
          setBoth(withoutSent(draftRef.current, pending));
        },
      );
    };
    const hide = (): void => leave(false);
    window.addEventListener("pagehide", hide);
    return (): void => {
      window.removeEventListener("pagehide", hide);
      leaveListeners.delete(setError);
      leave(true);
    };
    // `writer` never changes: the listeners are set up once per editor.
  }, [writer]);

  async function save(): Promise<void> {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (busy.current) {
      again.current = true;
      return;
    }
    const sent: LayersPatch = unsent.current;
    if (isEmptyPatch(sent)) return;
    unsent.current = {};
    busy.current = true;
    setStatus("saving");
    const request: Promise<{ overlay: OverlayState }> = postJson<{ overlay: OverlayState }>(
      "/api/overlay",
      layersAction(sent, nextWrite(writer, seq)),
    );
    inflight.current = { sent, done: request.then(ignore, ignore) };
    try {
      const result = await request;
      savedCallback.current(result.overlay);
      setError(null);
      setStatus("saved");
    } catch (error_: unknown) {
      // 400, 409, 423, 429 and network errors: these fields show the saved layers again.
      setError({ message: errorMessage(error_), leaving: false });
      setStatus("idle");
    } finally {
      inflight.current = null;
      // Either way the sent fields leave the draft, unless they were edited again since.
      setBoth(withoutSent(draftRef.current, sent));
      busy.current = false;
      // Edits made during the request save now, after a failure too.
      if (again.current) {
        again.current = false;
        void save();
      }
    }
  }

  const edit = (change: (current: OverlayLayers) => OverlayLayers, when: EditTiming): void => {
    const before: OverlayLayers = mergeLayers(savedRef.current, draftRef.current);
    const patch: LayersPatch = diffLayers(before, change(before));
    if (isEmptyPatch(patch)) return;
    setBoth(mergePatches(draftRef.current, patch));
    unsent.current = mergePatches(unsent.current, patch);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (when === "now") void save();
    else timer.current = setTimeout((): void => void save(), SAVE_IDLE_MS);
  };

  const shown: OverlayLayers = useMemo(() => mergeLayers(layers, draft), [layers, draft]);
  return { shown, status, error, edit };
}
