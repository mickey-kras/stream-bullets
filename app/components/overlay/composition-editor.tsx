import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { t, type MessageId } from "../../i18n";
import { withItem, withPlaced, withRemoved } from "../../lib/layer-geometry";
import {
  GRID,
  GRID_LAYERS,
  ORIENTATIONS,
  frameSize,
  onStream,
  type CellRect,
  type GridLayer,
  type LayerCells,
  type OverlayLayers,
  type Orientation,
} from "../../lib/overlay-layers";
import type { OverlayState } from "../../types";
import type { OverlayLayouts } from "../../lib/overlay-layouts";
import { announce } from "../a11y/announcer";
import { motionReduced } from "../station/motion";
import { type ActivityFeed, useActivityFeed } from "./activity-feed";
import { type CharactersControl, useCharactersControl } from "./characters-controls";
import { LayerPalette } from "./layer-palette";
import { LayoutPicker, type LayoutAct } from "./layout-picker";
import { LayerProperties, type ChangeLayers, type OverlayAction } from "./layer-properties";
import { LAYER_NAMES, LayoutGrid, type LayoutGridHandle, type PreviewBackground, type RemoveDrop } from "./layout-grid";
import { CHARACTERS_READY } from "./overlay-composition";
import type { OverlayScene } from "./overlay-stage";
import { StepHeading } from "./step-heading";
import { StudioTest } from "./studio-test";
import { useLayerDraft, type EditorError, type EditTiming } from "./use-layer-draft";

const BACKGROUNDS: readonly (readonly [PreviewBackground, MessageId])[] = [
  ["checker", "overlay.comp.bgChecker"],
  ["game", "overlay.comp.bgGame"],
];
const ORIENTATION_NAMES: Readonly<Record<Orientation, MessageId>> = {
  horizontal: "overlay.grid.horizontal",
  vertical: "overlay.grid.vertical",
};

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
 * `layers` with `layer` on the grid at `rect`. A topic layer that comes on the grid without a topic takes
 * `topic`, the newest topic of the page. The grid checks a cell before it places a layer, so a cell that no longer
 * fits changes nothing.
 */
function placedLayers(layers: OverlayLayers, layer: GridLayer, rect: CellRect, topic: string | null): OverlayLayers {
  const orientation: Orientation = layers.orientation;
  const placed: OverlayLayers | null = withPlaced(layers, orientation, layer, rect);
  if (!placed) return layers;
  const added: boolean = layers.cells[orientation][layer] === null;
  const pick: boolean = layer === "topic" && added && placed.items.topic.ref === null && topic !== null;
  return pick ? withItem(placed, "topic", { ref: topic }) : placed;
}

/**
 * Step 1 of the Overlay section of Streamer tools: the overlay studio. A toolbar sets the orientation and the preview background and
 * starts the test. Below it are the layer palette, the layout grid of the selected orientation over a preview of
 * what OBS shows, and the settings of the selected layer. The preview plays sample chat. While the characters layer
 * is on stream, it opens the owner's characters socket and shows the live playground. Layer edits go live at once.
 */
export function CompositionEditor({
  scene,
  state,
  busy,
  run,
  onSaved,
  layouts,
  layoutBusy,
  layoutAct,
}: Readonly<{
  scene: OverlayScene;
  /** The newest saved or live state, with the layers. */
  state: OverlayState;
  /** A request of `run` is in flight. */
  busy: boolean;
  /** Saves a setting that is not in the layers: the poll results switch or the message. */
  run: (action: OverlayAction) => void;
  onSaved: (overlay: OverlayState) => void;
  /** The saved layouts of each output, and the layout on stream. */
  layouts: OverlayLayouts;
  /** True while a layout action saves. */
  layoutBusy: boolean;
  layoutAct: LayoutAct;
}>): ReactNode {
  const { layers } = state;
  const buildId: string = useId();
  const orientationNoteId: string = useId();
  const [background, setBackground] = useState<PreviewBackground>("checker");
  // The selected layer of the grid. It is here, not in the grid, so that other controls can read and set it.
  const [selected, setSelected] = useState<GridLayer | null>(null);
  const grid = useRef<LayoutGridHandle | null>(null);
  // The palette takes a layer that a pointer drags off the grid: the grid reads its box and sets what it shows.
  const palette = useRef<HTMLFieldSetElement | null>(null);
  const [removeDrop, setRemoveDrop] = useState<RemoveDrop | null>(null);
  const { shown, status, error, edit } = useLayerDraft(layers, onSaved);
  const orientation: Orientation = shown.orientation;
  const cells: LayerCells = shown.cells[orientation];
  // The preview shows the live playground while the characters layer is on stream: the owner's characters socket.
  const charactersOn: boolean = CHARACTERS_READY && onStream(shown, "characters");
  const charactersFeed: ActivityFeed = useActivityFeed(scene.handle, null, charactersOn, {
    characters: true,
    owner: true,
  });
  // The server checks the saved layers, so an unsaved draft does not make the test or the controls available.
  const characters: CharactersControl = useCharactersControl(
    charactersOn ? charactersFeed : null,
    CHARACTERS_READY && onStream(layers, "characters"),
    scene.now,
  );
  const placed: GridLayer[] = GRID_LAYERS.filter((layer: GridLayer): boolean => cells[layer] !== null);
  // The settings show for the selected layer while it is on the grid of this orientation.
  const active: GridLayer | null = selected && cells[selected] ? selected : null;

  const change: ChangeLayers = (update: (current: OverlayLayers) => OverlayLayers, when: EditTiming = "now"): void =>
    edit(update, when);
  const newestTopic: string | null = scene.data.topics[0]?.id ?? null;
  const place = (layer: GridLayer, rect: CellRect, when: EditTiming): void =>
    change((current: OverlayLayers) => placedLayers(current, layer, rect, newestTopic), when);
  const remove = (layer: GridLayer): void =>
    change((current: OverlayLayers) => withRemoved(current, current.orientation, layer));
  // The grid tells its own selections. A selection from the palette is told here.
  const selectChip = (layer: GridLayer): void => {
    setSelected(layer);
    announce(t("overlay.grid.selected", { layer: t(LAYER_NAMES[layer]) }));
  };
  // The Remove button goes away with its layer: the focus moves to the chip of that layer in the palette.
  const removeSelected = (layer: GridLayer): void => {
    remove(layer);
    announce(t("overlay.grid.removed", { layer: t(LAYER_NAMES[layer]) }));
    palette.current?.querySelector<HTMLButtonElement>(`[data-comp-layer="${layer}"]`)?.focus();
  };

  let statusText: string = "";
  if (status === "saving") statusText = t("overlay.comp.saving");
  else if (status === "saved") statusText = t("overlay.comp.saved");

  return (
    <section className="ov-step ov-comp" aria-labelledby={buildId} data-step="build" data-composition-editor>
      <StepHeading step={1} id={buildId} title={t("overlay.step.build")} />
      <div className="ov-comp-bar">
        <fieldset className="ov-seg-field">
          <legend className="sr-only">{t("overlay.grid.orientation")}</legend>
          <div className="seg">
            {ORIENTATIONS.map((value: Orientation) => (
              <button
                key={value}
                type="button"
                aria-pressed={orientation === value}
                aria-describedby={orientationNoteId}
                onClick={() => change((current: OverlayLayers) => ({ ...current, orientation: value }))}
                data-comp-orientation={value}
              >
                {t(ORIENTATION_NAMES[value], { cols: GRID[value].cols, rows: GRID[value].rows })}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="ov-seg-field">
          <legend className="sr-only">{t("overlay.comp.background")}</legend>
          <div className="seg">
            {BACKGROUNDS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={background === value}
                onClick={() => setBackground(value)}
                data-comp-background={value}
              >
                {t(label)}
              </button>
            ))}
          </div>
        </fieldset>
        <StudioTest
          chatUntil={state.chatTestUntil}
          now={scene.now}
          chatOn={onStream(layers, "chat")}
          characters={characters}
          onSaved={onSaved}
        />
        <p className="ov-live-note" data-comp-live-note>
          <span className="ov-live-dot" aria-hidden="true" />
          {t("overlay.comp.liveNote")}
        </p>
      </div>
      <p className="muted ov-comp-note" id={orientationNoteId} data-comp-orientation-note>
        {t("overlay.grid.orientationNote")}
      </p>
      <LayoutPicker output={orientation} layers={shown} layouts={layouts} busy={layoutBusy} act={layoutAct} />
      <div className="ov-studio">
        <LayerPalette
          placed={placed}
          selected={active}
          grid={grid}
          onSelect={selectChip}
          drop={removeDrop}
          ref={palette}
        />
        <div className="ov-comp-stage">
          <LayoutGrid
            ref={grid}
            layers={shown}
            scene={scene}
            background={background}
            charactersFeed={charactersOn ? charactersFeed : null}
            selected={active}
            onSelect={setSelected}
            onPlace={place}
            onRemove={remove}
            removeZone={palette}
            onRemoveDrop={setRemoveDrop}
          />
          <p className="muted ov-comp-help" data-comp-frame-size>
            {t("overlay.grid.obsSize", frameSize(orientation))}
          </p>
          {onStream(shown, "chat") && (
            <p className="muted ov-comp-help" data-comp-sample>
              {t("overlay.comp.sampleChat")}
            </p>
          )}
        </div>
        <div className="ov-studio-side">
          <LayerProperties
            layer={active}
            layers={shown}
            state={state}
            data={scene.data}
            busy={busy}
            run={run}
            change={change}
            characters={characters}
            onRemove={removeSelected}
          />
          <output className="ov-comp-status">{statusText}</output>
          {error && <EditorAlert error={error} />}
        </div>
      </div>
    </section>
  );
}
