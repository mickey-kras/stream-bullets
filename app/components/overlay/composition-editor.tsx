import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { t, tAround, type MessageId } from "../../i18n";
import { CHAT_TEST_MS, chatTestLeft } from "../../lib/chat-test";
import { onGrid, withPlaced, withRemoved } from "../../lib/layer-geometry";
import {
  CHAT_BACKGROUND,
  GRID,
  GRID_LAYERS,
  ORIENTATIONS,
  frameSize,
  layerPixels,
  type CellRect,
  type GridLayer,
  type OverlayLayers,
  type Orientation,
} from "../../lib/overlay-layers";
import type { OverlaySourceRef, OverlayState } from "../../types";
import { errorMessage, postJson } from "../api";
import { motionReduced } from "../station/motion";
import { useToast } from "../ui/toast";
import { type ActivityFeed, useActivityFeed } from "./activity-feed";
import { CharactersControls } from "./characters-controls";
import { LayerPalette } from "./layer-palette";
import { LayoutGrid, type LayoutGridHandle, type PreviewBackground, type RemoveDrop } from "./layout-grid";
import { CHARACTERS_READY } from "./overlay-composition";
import { showsContent, type OverlayScene } from "./overlay-stage";
import { StepHeading } from "./step-heading";
import { useChatOverlap } from "./use-chat-overlap";
import { useLayerDraft, type EditorError, type EditTiming } from "./use-layer-draft";

const BACKGROUNDS: readonly (readonly [PreviewBackground, MessageId])[] = [
  ["checker", "overlay.comp.bgChecker"],
  ["game", "overlay.comp.bgGame"],
];
const ORIENTATION_NAMES: Readonly<Record<Orientation, MessageId>> = {
  horizontal: "overlay.grid.horizontal",
  vertical: "overlay.grid.vertical",
};

/** Debounce for the overlap note: it changes only once a move has settled. */
const OVERLAP_NOTE_MS = 500;

/**
 * The save error under the editor. The error of a change sent while leaving can show when the editor opens, below
 * the visible part of the page, so it scrolls into view (at once with reduced motion).
 */
function EditorAlert({ error }: Readonly<{ error: EditorError }>): ReactNode {
  const box = useRef<HTMLParagraphElement | null>(null);
  const { leaving } = error;
  useEffect(() => {
    if (!leaving) return;
    box.current?.scrollIntoView({ block: "nearest", behavior: motionReduced() ? "auto" : "smooth" });
  }, [error, leaving]);
  const text: string = leaving
    ? t("overlay.comp.leaveFailed", { error: error.message })
    : t("overlay.comp.failed", { error: error.message });
  return (
    <p className="ov-comp-error" role="alert" data-comp-error ref={box}>
      {text}
    </p>
  );
}

/**
 * Start and Stop for the chat test, with the time left. The test needs the chat layer on. The button never takes the
 * `disabled` attribute: it keeps focus during its own request and when the test ends, and ignores presses while it
 * is unavailable. A polite region says when the test starts, stops or ends; the time left is not read each second.
 */
function ChatTest({
  until,
  now,
  enabled,
  onSaved,
}: Readonly<{
  until: number;
  /** Server time. */
  now: number;
  /** The saved chat layer is on. */
  enabled: boolean;
  onSaved: (overlay: OverlayState) => void;
}>): ReactNode {
  const toast = useToast();
  const hintId: string = useId();
  const [busy, setBusy] = useState<boolean>(false);
  const left: number = chatTestLeft(until, now);
  const running: boolean = left > 0;
  const unavailable: boolean = busy || (!running && !enabled);
  // Empty on page load; set when `running` changes, so the region speaks only for a start or a stop.
  const [news, setNews] = useState<string>("");
  const wasRunning = useRef<boolean>(running);
  // True from this editor's Stop press until its request fails: the end is then "stopped", not "ended" by the timer,
  // the chat layer or another tab. The live room can bring the stop before the response.
  const stoppedHere = useRef<boolean>(false);
  useEffect(() => {
    if (wasRunning.current === running) return;
    wasRunning.current = running;
    let text: MessageId = "overlay.test.ended";
    if (running) text = "overlay.test.started";
    else if (stoppedHere.current) text = "overlay.test.stopped";
    setNews(t(text));
  }, [running]);
  async function send(on: boolean): Promise<void> {
    setBusy(true);
    stoppedHere.current = !on;
    try {
      const result = await postJson<{ overlay: OverlayState }>("/api/overlay", { action: "chatTest", on });
      onSaved(result.overlay);
    } catch (error_: unknown) {
      stoppedHere.current = false;
      toast(t("overlay.test.failed", { error: errorMessage(error_) }), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  const idleStatus: string = t(enabled ? "overlay.test.hint" : "overlay.test.needsChat", {
    seconds: CHAT_TEST_MS / 1000,
  });
  const statusText: string = running ? t("overlay.test.left", { seconds: Math.ceil(left / 1000) }) : idleStatus;
  return (
    <div className="ov-comp-test" data-chat-test-control>
      <button
        type="button"
        aria-disabled={unavailable}
        aria-describedby={hintId}
        onClick={() => {
          if (!unavailable) void send(!running);
        }}
        data-chat-test-toggle
      >
        {t(running ? "overlay.test.stop" : "overlay.test.start")}
      </button>
      <p className="muted ov-comp-note" id={hintId} data-chat-test-status>
        {statusText}
      </p>
      <p className="sr-only" aria-live="polite" data-chat-test-news>
        {news}
      </p>
    </div>
  );
}

/**
 * Steps 2 and 3 of Overlay control. Step 2 has the live control (`live`) and the switches of the chat and characters
 * layers. Step 3 has the layout grid of the selected orientation over a preview of what OBS shows. The preview plays
 * sample chat. While the characters layer is on, it opens the owner's characters socket and shows the live
 * playground. Layer edits go live at once.
 */
export function CompositionEditor({
  layers,
  scene,
  source,
  chatTestUntil,
  onSaved,
  live,
}: Readonly<{
  /** The newest saved or live layers. */
  layers: OverlayLayers;
  scene: OverlayScene;
  /** What is on air. */
  source: OverlaySourceRef;
  /** Server time when the chat test ends. */
  chatTestUntil: number;
  onSaved: (overlay: OverlayState) => void;
  /** The live control of the on-air content: monitors, Take and sources. */
  live: ReactNode;
}>): ReactNode {
  const showId: string = useId();
  const placeId: string = useId();
  const commandsId: string = useId();
  const backgroundId: string = useId();
  const backgroundHintId: string = useId();
  const orientationNoteId: string = useId();
  const [background, setBackground] = useState<PreviewBackground>("checker");
  // The selected layer of the grid. It is here, not in the grid, so that other controls can read and set it.
  const [selected, setSelected] = useState<GridLayer>("chat");
  const grid = useRef<LayoutGridHandle | null>(null);
  // The palette takes a layer that a pointer drags off the grid: the grid reads its box and sets what it shows.
  const palette = useRef<HTMLFieldSetElement | null>(null);
  const [removeDrop, setRemoveDrop] = useState<RemoveDrop | null>(null);
  const { shown, status, error, edit } = useLayerDraft(layers, onSaved);
  const orientation: Orientation = shown.orientation;
  // The preview shows the live playground while the characters layer is on: the owner's own characters socket.
  const charactersOn: boolean = CHARACTERS_READY && shown.characters.enabled;
  const charactersFeed: ActivityFeed = useActivityFeed(scene.handle, null, charactersOn, {
    characters: true,
    owner: true,
  });
  const content: CellRect | null = shown.cells[orientation].content;
  const free: GridLayer[] = GRID_LAYERS.filter((layer: GridLayer): boolean => !onGrid(shown, orientation, layer));
  const frame = useRef<HTMLDivElement | null>(null);
  const covers: boolean = useChatOverlap(
    frame,
    { enabled: shown.chat.enabled && content === null, rect: layerPixels(shown, "chat") ?? { x: 0, y: 0, w: 0, h: 0 } },
    source,
  );
  // The preview dims a sample: a content cell with nothing on air.
  const dimmed: boolean = content !== null && !showsContent(source, scene.data);
  const [sourceBefore, sourceAfter] = tAround("overlay.comp.chatSource", "link");
  // The overlap note follows `covers` OVERLAP_NOTE_MS after the last change. It speaks only after the owner's first
  // edit, not on page load.
  const [note, setNote] = useState<boolean>(false);
  const [armed, setArmed] = useState<boolean>(false);
  useEffect(() => {
    const wait = setTimeout(() => setNote(covers), OVERLAP_NOTE_MS);
    return (): void => clearTimeout(wait);
  }, [covers]);

  const change = (update: (current: OverlayLayers) => OverlayLayers, when: EditTiming = "now"): void => {
    setArmed(true);
    edit(update, when);
  };
  // The grid checks a cell before it calls `place`, so a cell that no longer fits changes nothing.
  const place = (layer: GridLayer, rect: CellRect, when: EditTiming): void =>
    change((current: OverlayLayers) => withPlaced(current, current.orientation, layer, rect) ?? current, when);
  const remove = (layer: GridLayer): void =>
    change((current: OverlayLayers) => withRemoved(current, current.orientation, layer));

  const backgroundText: string = t("overlay.comp.chatBackgroundValue", { percent: shown.chat.backgroundOpacity });
  let statusText: string = "";
  if (status === "saving") statusText = t("overlay.comp.saving");
  else if (status === "saved") statusText = t("overlay.comp.saved");

  return (
    <div className="ov-comp" data-composition-editor>
      <section className="ov-step" aria-labelledby={showId} data-step="show">
        <StepHeading step={2} id={showId} title={t("overlay.step.show")} />
        {live}
        <div className="ov-comp-layers ov-step-layers">
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
                checked={shown.chat.enabled}
                onChange={(event) => {
                  const enabled: boolean = event.currentTarget.checked;
                  change((current) => ({ ...current, chat: { ...current.chat, enabled } }));
                }}
              />
              <span>{t("overlay.comp.show")}</span>
            </label>
            <p className="muted ov-comp-note" data-comp-scale>
              {t("overlay.comp.scaleNote")}
            </p>
            <label className="choice">
              <input
                type="checkbox"
                checked={shown.chat.hideCommands}
                aria-describedby={commandsId}
                onChange={(event) => {
                  const hideCommands: boolean = event.currentTarget.checked;
                  change((current) => ({ ...current, chat: { ...current.chat, hideCommands } }));
                }}
              />
              <span>{t("overlay.comp.hideCommands")}</span>
            </label>
            <p className="muted ov-comp-note" id={commandsId}>
              {t("overlay.comp.hideCommandsHint")}
            </p>
            <div className="ov-comp-range" data-comp-chat-background>
              <label htmlFor={backgroundId}>{t("overlay.comp.chatBackground")}</label>
              <input
                id={backgroundId}
                type="range"
                min={CHAT_BACKGROUND.min}
                max={CHAT_BACKGROUND.max}
                step={CHAT_BACKGROUND.step}
                value={shown.chat.backgroundOpacity}
                aria-valuetext={backgroundText}
                aria-describedby={backgroundHintId}
                onChange={(event) => {
                  const backgroundOpacity: number = event.currentTarget.valueAsNumber;
                  // The preview follows each step. The save waits for a pause, like a keyboard move on the grid.
                  change((current) => ({ ...current, chat: { ...current.chat, backgroundOpacity } }), "idle");
                }}
              />
              {/* The slider already names the value (aria-valuetext), so a screen reader skips this copy. */}
              <span className="ov-comp-range-value" aria-hidden="true" data-comp-chat-background-value>
                {backgroundText}
              </span>
              <p className="muted ov-comp-note" id={backgroundHintId}>
                {t("overlay.comp.chatBackgroundHint")}
              </p>
            </div>
            {/* The server checks the saved layers, so an unsaved draft does not make the test available. */}
            <ChatTest until={chatTestUntil} now={scene.now} enabled={layers.chat.enabled} onSaved={onSaved} />
          </fieldset>
          <fieldset className="ov-comp-layer" data-comp-layer="characters">
            <legend>{t("overlay.comp.characters")}</legend>
            <p className="muted ov-comp-note">{t("overlay.characters.intro")}</p>
            <label className="choice">
              <input
                type="checkbox"
                checked={shown.characters.enabled}
                disabled={!CHARACTERS_READY}
                onChange={(event) => {
                  const enabled: boolean = event.currentTarget.checked;
                  change((current) => ({ ...current, characters: { ...current.characters, enabled } }));
                }}
              />
              <span>{t("overlay.comp.show")}</span>
            </label>
            {/* The server checks the saved layers, so an unsaved draft does not make the test available. */}
            <CharactersControls
              feed={charactersOn ? charactersFeed : null}
              enabled={layers.characters.enabled}
              timeout={shown.characters.timeout}
              onTimeout={(timeout: number) =>
                change((current) => ({ ...current, characters: { ...current.characters, timeout } }))
              }
              now={scene.now}
            />
          </fieldset>
        </div>
      </section>
      <section className="ov-step" aria-labelledby={placeId} data-step="place">
        <StepHeading step={3} id={placeId} title={t("overlay.step.place")} />
        <p className="muted ov-step-intro">{t("overlay.comp.intro")}</p>
        <div className="ov-comp-body">
          <div className="ov-comp-stage" ref={frame}>
            <div className="ov-comp-bar">
              <fieldset className="field ov-seg-field">
                <legend className="field-label">{t("overlay.grid.orientation")}</legend>
                <div className="seg">
                  {ORIENTATIONS.map((value: Orientation) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={orientation === value}
                      aria-describedby={orientationNoteId}
                      onClick={() => change((current) => ({ ...current, orientation: value }))}
                      data-comp-orientation={value}
                    >
                      {t(ORIENTATION_NAMES[value], { cols: GRID[value].cols, rows: GRID[value].rows })}
                    </button>
                  ))}
                </div>
                <p className="muted ov-comp-note" id={orientationNoteId} data-comp-orientation-note>
                  {t("overlay.grid.orientationNote")}
                </p>
              </fieldset>
              <fieldset className="field ov-seg-field">
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
              <LayerPalette free={free} grid={grid} drop={removeDrop} ref={palette} />
            </div>
            <LayoutGrid
              ref={grid}
              layers={shown}
              scene={scene}
              source={source}
              background={background}
              charactersFeed={charactersOn ? charactersFeed : null}
              selected={selected}
              onSelect={setSelected}
              onPlace={place}
              onRemove={remove}
              removeZone={palette}
              onRemoveDrop={setRemoveDrop}
            />
            <p className="muted ov-comp-help" data-comp-frame-size>
              {t("overlay.grid.obsSize", frameSize(orientation))}
            </p>
            {/* Always mounted, so a screen reader follows it. Silent until the owner first changes the layout. */}
            <p className="ov-comp-help ov-comp-overlap" data-comp-overlap aria-live={armed ? "polite" : "off"}>
              {note ? t("overlay.comp.overlap") : ""}
            </p>
            {shown.chat.enabled && (
              <p className="muted ov-comp-help" data-comp-sample>
                {t("overlay.comp.sampleChat")}
              </p>
            )}
            {dimmed && (
              <p className="muted ov-comp-help" data-comp-sample-off>
                {t("overlay.comp.sampleOff")}
              </p>
            )}
          </div>
          <div className="ov-comp-layers">
            <fieldset className="ov-comp-layer" data-comp-layer="content">
              <legend>{t("overlay.comp.content")}</legend>
              {/* Polite: the text changes when the content gets a cell or the Remove button takes it away. */}
              <p className="muted ov-comp-note" data-comp-content-note aria-live="polite">
                {t(content ? "overlay.comp.contentCell" : "overlay.comp.contentFull")}
              </p>
              {/* aria-disabled, not disabled: the button keeps focus after it removes the cell. */}
              <button
                type="button"
                aria-disabled={content === null}
                onClick={() => {
                  if (content !== null) remove("content");
                }}
                data-comp-remove
              >
                {t("overlay.comp.contentRemove")}
              </button>
            </fieldset>
            <output className="ov-comp-status">{statusText}</output>
            {error && <EditorAlert error={error} />}
          </div>
        </div>
      </section>
    </div>
  );
}
