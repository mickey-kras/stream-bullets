import { useContext, useId, useState, type FormEvent, type ReactNode } from "react";
import { t, tAround, type MessageId } from "../../i18n";
import { withEnabled, withItem } from "../../lib/layer-geometry";
import { MASH_NAME } from "../../lib/mash";
import { channelsSectionPath } from "../../lib/shell";
import {
  LAYER_BACKGROUND,
  layerEnabled,
  type ContentLayer,
  type GridLayer,
  type OverlayLayers,
} from "../../lib/overlay-layers";
import type { OverlayData, OverlayMessageStyle, OverlayState } from "../../types";
import { ChatDeliveryContext } from "../channels/use-live-channels";
import { Icon } from "../ui/icon";
import { Select, type SelectOption } from "../ui/select";
import { CharactersControls, type CharactersControl } from "./characters-controls";
import { LAYER_NAMES } from "./layout-grid";
import { CHARACTERS_READY } from "./overlay-composition";
import type { EditTiming } from "./use-layer-draft";

// Must match overlay_state_message_check.
export const OVERLAY_MESSAGE_MAX = 120;

const STYLES: readonly [OverlayMessageStyle, MessageId][] = [
  ["info", "overlay.style.info"],
  ["hype", "overlay.style.hype"],
];

/** The overlay settings that are not in the layers. `POST /api/overlay` saves them. */
export type OverlayAction =
  | { action: "showResults"; on: boolean }
  | { action: "message"; text: string; style: OverlayMessageStyle };

/** Changes the layers as shown. `when` is "idle" for a change that saves after a pause, like a slider step. */
export type ChangeLayers = (update: (current: OverlayLayers) => OverlayLayers, when?: EditTiming) => void;

/** What the settings of one layer read and change. */
interface SettingsProps {
  /** The layers as shown: saved plus local edits. */
  layers: OverlayLayers;
  /** The newest saved or live state. */
  state: OverlayState;
  data: OverlayData;
  /** A request of `run` is in flight. */
  busy: boolean;
  run: (action: OverlayAction) => void;
  change: ChangeLayers;
}

/** The value of the poll picker for "Latest active poll": a poll layer without a ref. Poll IDs are UUIDs. */
const LATEST_POLL = "latest";

// The picker names the author of each viewer poll.
function pollLabel(poll: OverlayData["polls"][number]): string {
  const title: string = poll.mash ? `${MASH_NAME}: ${poll.title}` : poll.title;
  return poll.byOwner ? title : t("overlay.pollBy", { title, author: poll.author });
}

/** A labelled picker for the poll, topic or card of a layer. `empty` shows when the page has nothing to pick. */
function RefPicker({
  label,
  options,
  value,
  empty,
  onPick,
}: Readonly<{
  label: string;
  options: readonly SelectOption[];
  value: string | undefined;
  empty: string;
  onPick: (value: string) => void;
}>): ReactNode {
  const labelId: string = useId();
  return (
    <div className="ov-props-field" data-props-ref>
      <span className="field-label" id={labelId}>
        {label}
      </span>
      {options.length > 0 ? (
        <Select labelledBy={labelId} options={options} placeholder={label} value={value} onValueChange={onPick} />
      ) : (
        <p className="muted ov-comp-note">{empty}</p>
      )}
    </div>
  );
}

function PollSettings({ layers, state, data, busy, run, change }: Readonly<SettingsProps>): ReactNode {
  const options: SelectOption[] = [
    { value: LATEST_POLL, label: t("overlay.props.latestPoll"), icon: "polls" },
    ...data.polls.map(
      (poll): SelectOption => ({ value: poll.id, label: pollLabel(poll), icon: poll.mash ? "zap" : "poll-choice" }),
    ),
  ];
  return (
    <>
      <RefPicker
        label={t("overlay.pickPoll")}
        options={options}
        value={layers.items.poll.ref ?? LATEST_POLL}
        empty=""
        onPick={(value: string) => {
          const ref: string | null = value === LATEST_POLL ? null : value;
          change((current: OverlayLayers) => withItem(current, "poll", { ref }));
        }}
      />
      {data.polls.length === 0 && <p className="muted ov-comp-note">{t("overlay.noPolls")}</p>}
      <label className="choice">
        <input
          type="checkbox"
          checked={state.showResults}
          disabled={busy}
          onChange={(event) => run({ action: "showResults", on: event.currentTarget.checked })}
          data-props-results
        />
        <span>{t("overlay.showResults")}</span>
      </label>
    </>
  );
}

function TopicSettings({ layers, data, change }: Readonly<SettingsProps>): ReactNode {
  return (
    <RefPicker
      label={t("overlay.pickTopic")}
      options={data.topics.map((topic): SelectOption => ({ value: topic.id, label: topic.title, icon: "topics" }))}
      value={layers.items.topic.ref ?? undefined}
      empty={t("overlay.noTopics")}
      onPick={(ref: string) => change((current: OverlayLayers) => withItem(current, "topic", { ref }))}
    />
  );
}

function CardSettings({ layers, data, change }: Readonly<SettingsProps>): ReactNode {
  return (
    <RefPicker
      label={t("overlay.pickCard")}
      options={data.cards.map((card): SelectOption => ({ value: card.id, label: card.title }))}
      // A card layer without a ref shows the first card.
      value={layers.items.card.ref ?? data.cards[0]?.id}
      empty={t("overlay.noCards")}
      onPick={(ref: string) => change((current: OverlayLayers) => withItem(current, "card", { ref }))}
    />
  );
}

/** The text and the style of the message banner. The text saves with its button, the style at once. */
function MessageEditor({ state, busy, run }: Readonly<Pick<SettingsProps, "state" | "busy" | "run">>): ReactNode {
  const [text, setText] = useState<string>(state.message);
  const inputId: string = useId();
  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    run({ action: "message", text, style: state.messageStyle });
  }
  return (
    <form className="ov-props-field" onSubmit={save}>
      <label className="field-label" htmlFor={inputId}>
        {t("overlay.messageLabel", { n: OVERLAY_MESSAGE_MAX })}
      </label>
      <input
        id={inputId}
        maxLength={OVERLAY_MESSAGE_MAX}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        data-ov-message
      />
      <fieldset className="field ov-seg-field">
        <legend className="field-label">{t("overlay.messageStyle")}</legend>
        <div className="seg">
          {STYLES.map(([style, id]) => (
            <button
              key={style}
              type="button"
              aria-pressed={state.messageStyle === style}
              disabled={busy}
              onClick={() => run({ action: "message", text, style })}
            >
              {t(id)}
            </button>
          ))}
        </div>
      </fieldset>
      <button type="submit" className="small-button" disabled={busy || text === state.message}>
        <Icon name="save" size={16} />
        {t("overlay.saveMessage")}
      </button>
    </form>
  );
}

function ChatSettings({ layers, change }: Readonly<Pick<SettingsProps, "layers" | "change">>): ReactNode {
  const commandsId: string = useId();
  const [sourceBefore, sourceAfter] = tAround("overlay.comp.chatSource", "link");
  const [downBefore, downAfter] = tAround("overlay.comp.chatDown", "link");
  // The chat is on stream, and no connected platform delivers chat at the moment.
  const down: boolean = !useContext(ChatDeliveryContext) && layerEnabled(layers, "chat");
  return (
    <>
      {down && (
        <p className="ch-problem ov-comp-note" data-comp-chat-down>
          <Icon name="warning" size={16} />
          <span>
            {downBefore}
            <a className="text-link" href={channelsSectionPath}>
              {t("overlay.comp.chatDownLink")}
            </a>
            {downAfter}
          </span>
        </p>
      )}
      <p className="muted ov-comp-note" data-comp-chat-source>
        {sourceBefore}
        <a className="text-link" href={channelsSectionPath}>
          {t("overlay.comp.chatSourceLink")}
        </a>
        {sourceAfter}
      </p>
      <label className="choice">
        <input
          type="checkbox"
          checked={layers.chat.hideCommands}
          aria-describedby={commandsId}
          onChange={(event) => {
            const hideCommands: boolean = event.currentTarget.checked;
            change((current: OverlayLayers) => ({ ...current, chat: { ...current.chat, hideCommands } }));
          }}
          data-props-commands
        />
        <span>{t("overlay.comp.hideCommands")}</span>
      </label>
      <p className="muted ov-comp-note" id={commandsId}>
        {t("overlay.comp.hideCommandsHint")}
      </p>
    </>
  );
}

/** The background opacity of a layer. The preview follows each step. The save waits for a pause. */
function BackgroundRange({
  label,
  hint,
  value,
  onValue,
}: Readonly<{ label: string; hint: string; value: number; onValue: (percent: number) => void }>): ReactNode {
  const inputId: string = useId();
  const hintId: string = useId();
  const text: string = t("overlay.comp.chatBackgroundValue", { percent: value });
  return (
    <div className="ov-comp-range" data-props-background>
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type="range"
        min={LAYER_BACKGROUND.min}
        max={LAYER_BACKGROUND.max}
        step={LAYER_BACKGROUND.step}
        value={value}
        aria-valuetext={text}
        aria-describedby={hintId}
        onChange={(event) => onValue(event.currentTarget.valueAsNumber)}
      />
      {/* The slider already names the value (aria-valuetext), so a screen reader skips this copy. */}
      <span className="ov-comp-range-value" aria-hidden="true" data-props-background-value>
        {text}
      </span>
      <p className="muted ov-comp-note" id={hintId}>
        {hint}
      </p>
    </div>
  );
}

/** The background slider of a layer. The characters layer has none. */
function LayerBackground({
  layer,
  layers,
  change,
}: Readonly<{ layer: GridLayer; layers: OverlayLayers; change: ChangeLayers }>): ReactNode {
  if (layer === "characters") return null;
  if (layer === "chat")
    return (
      <BackgroundRange
        label={t("overlay.comp.chatBackground")}
        hint={t("overlay.comp.chatBackgroundHint")}
        value={layers.chat.backgroundOpacity}
        onValue={(backgroundOpacity: number) =>
          change((current: OverlayLayers) => ({ ...current, chat: { ...current.chat, backgroundOpacity } }), "idle")
        }
      />
    );
  return (
    <BackgroundRange
      label={t("overlay.props.background")}
      hint={t("overlay.props.backgroundHint")}
      value={layers.items[layer].backgroundOpacity}
      onValue={(backgroundOpacity: number) =>
        change((current: OverlayLayers) => withItem(current, layer, { backgroundOpacity }), "idle")
      }
    />
  );
}

/** The QR code switch of a content layer. The message banner has no page to open, so it has no switch. */
function QrSetting({
  layer,
  layers,
  change,
}: Readonly<{ layer: GridLayer; layers: OverlayLayers; change: ChangeLayers }>): ReactNode {
  const hintId: string = useId();
  if (layer === "chat" || layer === "characters" || layer === "message") return null;
  return (
    <>
      <label className="choice">
        <input
          type="checkbox"
          checked={layers.items[layer].qr}
          aria-describedby={hintId}
          onChange={(event) => {
            const qr: boolean = event.currentTarget.checked;
            change((current: OverlayLayers) => withItem(current, layer, { qr }));
          }}
          data-props-qr
        />
        <span>{t("overlay.props.qr")}</span>
      </label>
      <p className="muted ov-comp-note" id={hintId}>
        {t("overlay.props.qrHint")}
      </p>
    </>
  );
}

/** The settings that only one content layer has. Up next and the support banner have none. */
function ContentSettings({ layer, ...props }: Readonly<SettingsProps & { layer: ContentLayer }>): ReactNode {
  if (layer === "poll") return <PollSettings {...props} />;
  if (layer === "topic") return <TopicSettings {...props} />;
  if (layer === "card") return <CardSettings {...props} />;
  // The key gives the field the saved text again after a save from another tab.
  if (layer === "message") return <MessageEditor key={props.state.message} {...props} />;
  return null;
}

/**
 * The settings of the selected layer: "Show on stream", what it shows, its QR code, its background and "Remove from
 * grid". With no layer (`layer` null) a hint shows. Layer settings save through `change` like grid edits. The poll
 * results switch and the message save through `run`.
 */
export function LayerProperties({
  layer,
  characters,
  onRemove,
  ...props
}: Readonly<
  SettingsProps & {
    /** The selected layer when it is on the grid, or null. */
    layer: GridLayer | null;
    characters: CharactersControl;
    onRemove: (layer: GridLayer) => void;
  }
>): ReactNode {
  const titleId: string = useId();
  const { layers, change } = props;
  if (layer === null)
    return (
      <section className="ov-props" aria-labelledby={titleId} data-comp-props="">
        <h3 className="ov-props-name" id={titleId}>
          {t("overlay.props.none")}
        </h3>
        <p className="muted ov-comp-note">{t("overlay.props.noneHint")}</p>
      </section>
    );
  return (
    <section className="ov-props" aria-labelledby={titleId} data-comp-props={layer}>
      <p className="eyebrow ov-studio-title">{t("overlay.props.title")}</p>
      <h3 className="ov-props-name" id={titleId}>
        {t(LAYER_NAMES[layer])}
      </h3>
      {layer === "characters" && <p className="muted ov-comp-note">{t("overlay.characters.intro")}</p>}
      <label className="choice">
        <input
          type="checkbox"
          checked={layerEnabled(layers, layer)}
          disabled={layer === "characters" && !CHARACTERS_READY}
          onChange={(event) => {
            const enabled: boolean = event.currentTarget.checked;
            change((current: OverlayLayers) => withEnabled(current, layer, enabled));
          }}
          data-props-show
        />
        <span>{t("overlay.comp.show")}</span>
      </label>
      {layer === "chat" && <ChatSettings layers={layers} change={change} />}
      {layer === "characters" && (
        <CharactersControls
          control={characters}
          timeout={layers.characters.timeout}
          onTimeout={(timeout: number) =>
            change((current: OverlayLayers) => ({ ...current, characters: { ...current.characters, timeout } }))
          }
          max={layers.characters.max}
          onMax={(max: number) =>
            change((current: OverlayLayers) => ({ ...current, characters: { ...current.characters, max } }))
          }
        />
      )}
      {layer !== "chat" && layer !== "characters" && <ContentSettings layer={layer} {...props} />}
      <QrSetting layer={layer} layers={layers} change={change} />
      <LayerBackground layer={layer} layers={layers} change={change} />
      <button type="button" onClick={() => onRemove(layer)} data-props-remove>
        {t("overlay.props.remove")}
      </button>
    </section>
  );
}
