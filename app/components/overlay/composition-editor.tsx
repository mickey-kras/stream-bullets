import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { t, tAround, type MessageId } from "../../i18n";
import { SAMPLE_CHAT } from "../../lib/chat-feed";
import {
  diffLayers,
  isEmptyPatch,
  layersAction,
  mergePatches,
  moveRect,
  resizeRect,
  setRectField,
  withoutSent,
  withRect,
  type EditableLayer,
  type RectField,
} from "../../lib/layer-geometry";
import {
  DESIGN_H,
  DESIGN_W,
  MIN_RECT,
  mergeLayers,
  type CharactersLayer,
  type ChatLayer,
  type LayerRect,
  type LayersPatch,
  type OverlayLayers,
} from "../../lib/overlay-layers";
import type { OverlaySourceRef, OverlayState } from "../../types";
import { errorMessage, postJson, sendJson } from "../api";
import { CHARACTERS_READY, OverlayComposition } from "./overlay-composition";
import type { OverlayScene } from "./overlay-stage";
import { useChatOverlap } from "./use-chat-overlap";
import { useDesignScale } from "./use-design-scale";

/** Keyboard and number-field edits save after this much idle time. Drags save on pointer-up. */
export const SAVE_IDLE_MS = 400;

export type PreviewBackground = "checker" | "game";

const LAYER_NAMES: Readonly<Record<EditableLayer, MessageId>> = {
  chat: "overlay.comp.chat",
  characters: "overlay.comp.characters",
};
const FIELDS: readonly (readonly [RectField, MessageId])[] = [
  ["x", "overlay.comp.x"],
  ["y", "overlay.comp.y"],
  ["w", "overlay.comp.w"],
  ["h", "overlay.comp.h"],
];
const BACKGROUNDS: readonly (readonly [PreviewBackground, MessageId])[] = [
  ["checker", "overlay.comp.bgChecker"],
  ["game", "overlay.comp.bgGame"],
];
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

interface Drag {
  layer: EditableLayer;
  mode: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  rect: LayerRect;
  scale: number;
  moved: boolean;
}

type SaveStatus = "idle" | "saving" | "saved";

/**
 * Optimistic layer edits, tracked per field. Local changes show at once over the newest saved or live layers and save
 * in the background, one request at a time. A request sends only the fields changed since the last request, so an
 * edit made in another tab is never reverted. A failed save rolls back only the fields of that request, reports the
 * error and still saves later edits.
 */
function useLayerDraft(
  layers: OverlayLayers,
  onSaved: (overlay: OverlayState) => void,
): {
  shown: OverlayLayers;
  status: SaveStatus;
  error: string | null;
  edit: (change: (current: OverlayLayers) => OverlayLayers, when: "now" | "idle" | "later") => void;
  flush: () => void;
} {
  // Every unconfirmed local field (sent or not), and the subset not sent yet.
  const [draft, setDraft] = useState<LayersPatch>({});
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef<LayersPatch>({});
  const unsent = useRef<LayersPatch>({});
  const savedRef = useRef<OverlayLayers>(layers);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef<boolean>(false);
  const again = useRef<boolean>(false);
  const savedCallback = useRef(onSaved);
  useEffect(() => {
    savedRef.current = layers;
    savedCallback.current = onSaved;
  }, [layers, onSaved]);
  // Leaving the page or closing the editor sends the edits not sent yet, without waiting for the answer.
  useEffect(() => {
    const leave = (): void => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const pending: LayersPatch = unsent.current;
      if (isEmptyPatch(pending)) return;
      unsent.current = {};
      draftRef.current = withoutSent(draftRef.current, pending);
      setDraft(draftRef.current);
      sendJson("POST", "/api/overlay", layersAction(pending), { keepalive: true }).catch((): void => undefined);
    };
    window.addEventListener("pagehide", leave);
    return (): void => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, []);

  const setBoth = (next: LayersPatch): void => {
    draftRef.current = next;
    setDraft(next);
  };

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
    try {
      const result = await postJson<{ overlay: OverlayState }>("/api/overlay", layersAction(sent));
      savedCallback.current(result.overlay);
      setError(null);
      setStatus("saved");
    } catch (failure: unknown) {
      // 400, 409, 423, 429 and network errors: these fields show the saved layers again.
      setError(errorMessage(failure));
      setStatus("idle");
    } finally {
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
  const flush = (): void => {
    void save();
  };

  const edit = (change: (current: OverlayLayers) => OverlayLayers, when: "now" | "idle" | "later"): void => {
    const before: OverlayLayers = mergeLayers(savedRef.current, draftRef.current);
    const patch: LayersPatch = diffLayers(before, change(before));
    if (isEmptyPatch(patch)) return;
    setBoth(mergePatches(draftRef.current, patch));
    unsent.current = mergePatches(unsent.current, patch);
    if (when === "later") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (when === "now") flush();
    else timer.current = setTimeout(flush, SAVE_IDLE_MS);
  };

  const shown: OverlayLayers = useMemo(() => mergeLayers(layers, draft), [layers, draft]);
  return { shown, status, error, edit, flush };
}

/** A whole-number field for one rect value. It keeps what is typed until it is a valid value or loses focus. */
function RectInput({
  label,
  value,
  min,
  max,
  disabled,
  onValue,
}: Readonly<{
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onValue: (value: number, final: boolean) => void;
}>): ReactNode {
  const id: string = useId();
  const [text, setText] = useState<string | null>(null);
  const change = (event: ChangeEvent<HTMLInputElement>): void => {
    const next: string = event.currentTarget.value;
    setText(next);
    const parsed: number = Number(next);
    if (next.trim() !== "" && Number.isInteger(parsed) && parsed >= min && parsed <= max) onValue(parsed, false);
  };
  const commit = (): void => {
    if (text === null) return;
    const parsed: number = Number(text);
    if (text.trim() !== "" && Number.isFinite(parsed)) onValue(Math.round(parsed), true);
    setText(null);
  };
  return (
    <label className="ov-comp-num" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        step={1}
        min={min}
        max={max}
        value={text ?? String(value)}
        disabled={disabled}
        onChange={change}
        onBlur={commit}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Enter") commit();
        }}
      />
    </label>
  );
}

function RectFields({
  layer,
  rect,
  disabled,
  onField,
}: Readonly<{
  layer: EditableLayer;
  rect: LayerRect;
  disabled: boolean;
  onField: (field: RectField, value: number, final: boolean) => void;
}>): ReactNode {
  const min = MIN_RECT[layer];
  const limits: Readonly<Record<RectField, readonly [number, number]>> = {
    x: [0, DESIGN_W - rect.w],
    y: [0, DESIGN_H - rect.h],
    w: [min.w, DESIGN_W],
    h: [min.h, DESIGN_H],
  };
  return (
    <div className="ov-comp-nums" data-comp-fields={layer}>
      {FIELDS.map(([field, label]) => (
        <RectInput
          key={field}
          label={t(label)}
          value={rect[field]}
          min={limits[field][0]}
          max={limits[field][1]}
          disabled={disabled}
          onValue={(value: number, final: boolean) => onField(field, value, final)}
        />
      ))}
    </div>
  );
}

/** The movable box over a layer in the preview, with a resize handle in its bottom-right corner. */
function LayerHandle({
  layer,
  rect,
  helpId,
  resizeHelpId,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onNudge,
}: Readonly<{
  layer: EditableLayer;
  rect: LayerRect;
  helpId: string;
  resizeHelpId: string;
  onPointerDown: (event: PointerEvent<HTMLElement>, mode: Drag["mode"]) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerEnd: (event: PointerEvent<HTMLElement>) => void;
  onNudge: (mode: Drag["mode"], dx: number, dy: number) => void;
}>): ReactNode {
  const name: string = t(LAYER_NAMES[layer]);
  const keys =
    (mode: Drag["mode"]) =>
    (event: KeyboardEvent<HTMLElement>): void => {
      const arrow: readonly [number, number] | undefined = ARROWS[event.key];
      if (!arrow || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const step: number = event.shiftKey ? 10 : 1;
      onNudge(mode, arrow[0] * step, arrow[1] * step);
    };
  // A positioned wrapper with two native buttons: the box body moves the layer, the corner resizes it.
  return (
    <div className="ov-comp-box" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <button
        type="button"
        className="ov-comp-move"
        data-comp-box={layer}
        aria-roledescription={t("overlay.comp.movable")}
        aria-label={t("overlay.comp.box", { layer: name, x: rect.x, y: rect.y, w: rect.w, h: rect.h })}
        aria-describedby={helpId}
        onPointerDown={(event) => onPointerDown(event, "move")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={keys("move")}
      >
        <span className="ov-comp-box-label" aria-hidden="true">
          {name}
        </span>
      </button>
      <button
        type="button"
        className="ov-comp-resize"
        data-comp-resize={layer}
        aria-label={t("overlay.comp.resize", { layer: name })}
        aria-describedby={resizeHelpId}
        onPointerDown={(event) => onPointerDown(event, "resize")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={keys("resize")}
      />
    </div>
  );
}

/**
 * The Composition section of Overlay control: a 1920x1080 preview of what OBS shows, with the chat and characters
 * layers placed on it. It plays sample chat and never opens an activity socket.
 */
export function CompositionEditor({
  layers,
  scene,
  source,
  onSaved,
}: Readonly<{
  /** The newest saved or live layers. */
  layers: OverlayLayers;
  scene: OverlayScene;
  /** What is on air. */
  source: OverlaySourceRef;
  onSaved: (overlay: OverlayState) => void;
}>): ReactNode {
  const titleId: string = useId();
  const helpId: string = useId();
  const resizeHelpId: string = useId();
  const commandsId: string = useId();
  const frame = useRef<HTMLElement | null>(null);
  useDesignScale(frame, DESIGN_W);
  const [background, setBackground] = useState<PreviewBackground>("checker");
  const { shown, status, error, edit, flush } = useLayerDraft(layers, onSaved);
  const covers: boolean = useChatOverlap(frame, shown.chat, source);
  const [sourceBefore, sourceAfter] = tAround("overlay.comp.chatSource", "link");
  const drag = useRef<Drag | null>(null);

  const setRect = (layer: EditableLayer, rect: LayerRect, when: "now" | "idle" | "later"): void =>
    edit((current: OverlayLayers) => withRect(current, layer, rect), when);

  const pointerDown = (layer: EditableLayer) => (event: PointerEvent<HTMLElement>, mode: Drag["mode"]) => {
    const element: HTMLElement | null = frame.current;
    if (event.button !== 0 || !element || drag.current) return;
    event.preventDefault();
    event.stopPropagation();
    const target: HTMLElement = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    target.focus({ preventScroll: true });
    drag.current = {
      layer,
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect: shown[layer].rect,
      scale: element.clientWidth / DESIGN_W || 1,
      moved: false,
    };
  };
  const pointerMove = (event: PointerEvent<HTMLElement>): void => {
    const active: Drag | null = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx: number = (event.clientX - active.startX) / active.scale;
    const dy: number = (event.clientY - active.startY) / active.scale;
    const rect: LayerRect =
      active.mode === "move" ? moveRect(active.rect, dx, dy) : resizeRect(active.rect, dx, dy, MIN_RECT[active.layer]);
    const before: LayerRect = shown[active.layer].rect;
    if (rect.x === before.x && rect.y === before.y && rect.w === before.w && rect.h === before.h) return;
    active.moved = true;
    setRect(active.layer, rect, "later");
  };
  const pointerEnd = (event: PointerEvent<HTMLElement>): void => {
    const active: Drag | null = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    if (active.moved) flush();
  };
  const nudge = (layer: EditableLayer) => (mode: Drag["mode"], dx: number, dy: number) => {
    const rect: LayerRect = shown[layer].rect;
    setRect(layer, mode === "move" ? moveRect(rect, dx, dy) : resizeRect(rect, dx, dy, MIN_RECT[layer]), "idle");
  };
  const field = (layer: EditableLayer) => (name: RectField, value: number, final: boolean) =>
    setRect(layer, setRectField(shown[layer].rect, name, value, MIN_RECT[layer]), final ? "now" : "idle");

  const charactersEditable: boolean = CHARACTERS_READY;
  const chat: ChatLayer = shown.chat;
  const characters: CharactersLayer = shown.characters;
  let statusText: string = "";
  if (status === "saving") statusText = t("overlay.comp.saving");
  else if (status === "saved") statusText = t("overlay.comp.saved");

  return (
    <section className="ov-comp" aria-labelledby={titleId} data-composition-editor>
      <div className="ov-comp-head">
        <h2 id={titleId}>{t("overlay.comp.title")}</h2>
        <p className="muted">{t("overlay.comp.intro")}</p>
      </div>
      <div className="ov-comp-body">
        <div className="ov-comp-stage">
          <fieldset className="field ov-seg-field ov-comp-bg-field">
            <legend className="field-label">{t("overlay.comp.background")}</legend>
            <div className="seg">
              {BACKGROUNDS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={background === value}
                  onClick={() => setBackground(value)}
                >
                  {t(label)}
                </button>
              ))}
            </div>
          </fieldset>
          <section
            className="ov-frame ov-comp-frame"
            data-background={background}
            ref={frame}
            aria-label={t("overlay.comp.preview")}
          >
            <div className="ov-scaler">
              {background === "game" && <div className="ov-comp-game" aria-hidden="true" />}
              <div
                className="ov-comp-placeholder"
                data-comp-placeholder="characters"
                data-enabled={characters.enabled || undefined}
                style={{
                  left: characters.rect.x,
                  top: characters.rect.y,
                  width: characters.rect.w,
                  height: characters.rect.h,
                }}
              >
                <span>{t("overlay.comp.layerSoon", { layer: t("overlay.comp.characters") })}</span>
              </div>
              <OverlayComposition
                scene={scene}
                source={source}
                layers={shown}
                only={null}
                feed={null}
                samples={SAMPLE_CHAT}
              />
              {chat.enabled && (
                <LayerHandle
                  layer="chat"
                  rect={chat.rect}
                  helpId={helpId}
                  resizeHelpId={resizeHelpId}
                  onPointerDown={pointerDown("chat")}
                  onPointerMove={pointerMove}
                  onPointerEnd={pointerEnd}
                  onNudge={nudge("chat")}
                />
              )}
              {charactersEditable && characters.enabled && (
                <LayerHandle
                  layer="characters"
                  rect={characters.rect}
                  helpId={helpId}
                  resizeHelpId={resizeHelpId}
                  onPointerDown={pointerDown("characters")}
                  onPointerMove={pointerMove}
                  onPointerEnd={pointerEnd}
                  onNudge={nudge("characters")}
                />
              )}
            </div>
          </section>
          <p className="muted ov-comp-help" id={helpId}>
            {t("overlay.comp.moveHelp")}
          </p>
          <div aria-live="polite">
            {chat.enabled && covers && (
              <p className="ov-comp-help ov-comp-overlap" data-comp-overlap>
                {t("overlay.comp.overlap")}
              </p>
            )}
          </div>
          {chat.enabled && (
            <p className="muted ov-comp-help" data-comp-sample>
              {t("overlay.comp.sampleChat")}
            </p>
          )}
          <p className="sr-only" id={resizeHelpId}>
            {t("overlay.comp.resizeHelp")}
          </p>
        </div>
        <div className="ov-comp-layers">
          <fieldset className="ov-comp-layer" data-comp-layer="chat">
            <legend>{t("overlay.comp.chat")}</legend>
            <p className="muted ov-comp-note" data-comp-chat-source>
              {sourceBefore}
              <a className="text-link" href="#channels-title">
                {t("overlay.comp.chatSourceLink")}
              </a>
              {sourceAfter}
            </p>
            <label className="choice">
              <input
                type="checkbox"
                checked={chat.enabled}
                onChange={(event) => {
                  const enabled: boolean = event.currentTarget.checked;
                  edit((current) => ({ ...current, chat: { ...current.chat, enabled } }), "now");
                }}
              />
              <span>{t("overlay.comp.show")}</span>
            </label>
            <p className="muted ov-comp-note" data-comp-refresh>
              {t("overlay.comp.refreshHint")}
            </p>
            <label className="choice">
              <input
                type="checkbox"
                checked={chat.hideCommands}
                aria-describedby={commandsId}
                onChange={(event) => {
                  const hideCommands: boolean = event.currentTarget.checked;
                  edit((current) => ({ ...current, chat: { ...current.chat, hideCommands } }), "now");
                }}
              />
              <span>{t("overlay.comp.hideCommands")}</span>
            </label>
            <p className="muted ov-comp-note" id={commandsId}>
              {t("overlay.comp.hideCommandsHint")}
            </p>
            <RectFields layer="chat" rect={chat.rect} disabled={!chat.enabled} onField={field("chat")} />
          </fieldset>
          <fieldset className="ov-comp-layer" data-comp-layer="characters" aria-describedby={`${titleId}-soon`}>
            <legend>
              {t("overlay.comp.characters")} <span className="ov-comp-soon">{t("overlay.comp.soon")}</span>
            </legend>
            <label className="choice">
              <input
                type="checkbox"
                checked={characters.enabled}
                disabled={!charactersEditable}
                onChange={(event) => {
                  const enabled: boolean = event.currentTarget.checked;
                  edit((current) => ({ ...current, characters: { ...current.characters, enabled } }), "now");
                }}
              />
              <span>{t("overlay.comp.show")}</span>
            </label>
            <p className="muted ov-comp-note" id={`${titleId}-soon`}>
              {t("overlay.comp.charactersSoon")}
            </p>
            <RectFields
              layer="characters"
              rect={characters.rect}
              disabled={!charactersEditable || !characters.enabled}
              onField={field("characters")}
            />
          </fieldset>
          <output className="ov-comp-status">{statusText}</output>
          {error && (
            <p className="ov-comp-error" role="alert" data-comp-error>
              {t("overlay.comp.failed", { error })}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
