import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { t, type MessageId } from "../../i18n";
import { withItem, withPlaced, withRemoved } from "../../lib/layer-geometry";
import {
  GRID_LAYERS,
  ORIENTATIONS,
  onAnyOutput,
  onStream,
  type CellRect,
  type GridLayer,
  type LayerCells,
  type OverlayLayers,
  type Orientation,
} from "../../lib/overlay-layers";
import type { OverlayState } from "../../types";
import type { LayoutAction, OverlayLayouts } from "../../lib/overlay-layouts";
import { announce } from "../a11y/announcer";
import { motionReduced } from "../station/motion";
import { type ActivityFeed, useActivityFeed } from "./activity-feed";
import { type CharactersControl, useCharactersControl } from "./characters-controls";
import { LayerPalette } from "./layer-palette";
import { LayoutPicker, type LayoutAct } from "./layout-picker";
import { LayerProperties, type ChangeLayers, type OverlayAction } from "./layer-properties";
import {
  GridHelp,
  LAYER_NAMES,
  LayoutGrid,
  type LayoutGridHandle,
  type PreviewBackground,
  type RemoveDrop,
} from "./layout-grid";
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
 * Step 1 of the Overlay section of Streamer tools: the overlay studio. The toolbar is one line: the output tabs, the
 * layout list, and at the right edge the icon buttons that save a new layout, reset a preset and start the test.
 * The line below it has the preview background, which comes before the grid in the tab sequence, so Tab goes from
 * the grid to the settings. Then come the layer palette and the layout grid of the selected output over a preview
 * of what OBS shows. The
 * settings of the selected layer are below the grid of the horizontal output and beside the grid of the vertical
 * output. On a phone they are below the grid. The help for the grid is closed until the owner opens it. The preview
 * plays sample chat. While the characters layer is on stream, it opens the owner's characters socket and shows the
 * live playground. While the goal layer has a place on a grid, it opens the owner's activity socket for the count of
 * the goal. One socket serves the two. Layer edits go live at once.
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
  const { shown, status, error, edit, flush } = useLayerDraft(layers, onSaved);
  // True while a layout action runs: the grid edits save first, and the grid takes no edit.
  const [switching, setSwitching] = useState<boolean>(false);
  const actOnLayout: LayoutAct = async (action: LayoutAction): Promise<boolean> => {
    setSwitching(true);
    try {
      await flush();
      return await layoutAct(action);
    } finally {
      setSwitching(false);
    }
  };
  const orientation: Orientation = shown.orientation;
  const cells: LayerCells = shown.cells[orientation];
  // The preview shows the live playground while the characters layer is on stream: the owner's characters socket.
  const charactersOn: boolean = CHARACTERS_READY && onStream(shown, "characters");
  // The settings of the goal show the count of the server while the goal layer has a place on a grid: the server
  // counts only then. One owner socket serves the two: with the characters on, it also has the playground.
  const goalPlaced: boolean = ORIENTATIONS.some((output: Orientation): boolean => shown.cells[output].goal !== null);
  const ownerFeed: ActivityFeed = useActivityFeed(scene.handle, null, charactersOn || goalPlaced, {
    characters: charactersOn,
    owner: true,
  });
  const charactersFeed: ActivityFeed | null = charactersOn ? ownerFeed : null;
  // The server checks the saved layers, so an unsaved draft does not make the test or the controls available.
  const characters: CharactersControl = useCharactersControl(
    charactersFeed,
    CHARACTERS_READY && onStream(layers, "characters"),
    scene.now,
  );
  const placed: GridLayer[] = GRID_LAYERS.filter((layer: GridLayer): boolean => cells[layer] !== null);
  // The settings show for the selected layer while it is on the grid of this orientation.
  const active: GridLayer | null = selected && cells[selected] ? selected : null;

  const change: ChangeLayers = (update: (current: OverlayLayers) => OverlayLayers, when: EditTiming = "now"): void => {
    if (!switching) edit(update, when);
  };
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
  // The Remove button goes away with its layer: the focus moves to the chip of that layer in the palette. A closed
  // group of the palette opens first, because a chip in a closed group cannot take the focus.
  const removeSelected = (layer: GridLayer): void => {
    remove(layer);
    announce(t("overlay.grid.removed", { layer: t(LAYER_NAMES[layer]) }));
    const chip: HTMLButtonElement | null =
      palette.current?.querySelector<HTMLButtonElement>(`[data-comp-layer="${layer}"]`) ?? null;
    const group: HTMLDetailsElement | null = chip?.closest("details") ?? null;
    if (group) group.open = true;
    chip?.focus();
  };

  let statusText: string = "";
  if (status === "saving") statusText = t("overlay.comp.saving");
  else if (status === "saved") statusText = t("overlay.comp.saved");

  return (
    <section className="ov-step ov-comp" aria-labelledby={buildId} data-step="build" data-composition-editor>
      <StepHeading step={1} id={buildId} title={t("overlay.step.build")} />
      <div className="ov-comp-bar" data-comp-toolbar>
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
                {t(ORIENTATION_NAMES[value])}
              </button>
            ))}
          </div>
        </fieldset>
        <LayoutPicker
          output={orientation}
          layers={shown}
          layouts={layouts}
          busy={layoutBusy || switching}
          act={actOnLayout}
        >
          <StudioTest
            chatUntil={state.chatTestUntil}
            now={scene.now}
            chatOn={onStream(layers, "chat")}
            alertsOn={onAnyOutput(layers, "alerts")}
            characters={characters}
            onSaved={onSaved}
          />
        </LayoutPicker>
      </div>
      <div className="ov-comp-notes">
        <p className="muted ov-comp-note" id={orientationNoteId} data-comp-orientation-note>
          {t("overlay.grid.orientationNote")}
        </p>
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
        <p className="ov-live-note" data-comp-live-note>
          <span className="ov-live-dot" aria-hidden="true" />
          {t("overlay.comp.liveNote")}
        </p>
      </div>
      <div className="ov-studio">
        <LayerPalette
          placed={placed}
          selected={active}
          grid={grid}
          onSelect={selectChip}
          drop={removeDrop}
          ref={palette}
        />
        <div className="ov-work" data-orientation={orientation}>
          <div className="ov-comp-stage">
            <LayoutGrid
              ref={grid}
              layers={shown}
              scene={scene}
              background={background}
              charactersFeed={charactersFeed}
              selected={active}
              onSelect={setSelected}
              onPlace={place}
              onRemove={remove}
              removeZone={palette}
              onRemoveDrop={setRemoveDrop}
            />
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
              feed={goalPlaced ? ownerFeed : null}
              onRemove={removeSelected}
            />
            <output className="ov-comp-status">{statusText}</output>
            {error && <EditorAlert error={error} />}
          </div>
          <GridHelp orientation={orientation} />
        </div>
      </div>
    </section>
  );
}
