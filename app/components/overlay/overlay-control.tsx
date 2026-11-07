import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { t, type MessageId } from "../../i18n";
import { MASH_NAME } from "../../lib/mash";
import type {
  OverlayData,
  OverlayMessageStyle,
  OverlayPosition,
  OverlayPublic,
  OverlaySize,
  OverlaySource,
  OverlaySourceRef,
  OverlayState,
} from "../../types";
import { announce } from "../a11y/announcer";
import { errorMessage, postJson } from "../api";
import { IconButton } from "../ui/icon-button";
import { Icon, type IconName } from "../ui/icon";
import { Select } from "../ui/select";
import { useToast } from "../ui/toast";
import { OverlayStage, type OverlayScene } from "./overlay-stage";

/** The overlay message limit (the `overlay_state_message_check` constraint). */
export const OVERLAY_MESSAGE_MAX = 120;

const SOURCES: readonly { type: OverlaySource; label: MessageId; hint: MessageId; icon: IconName }[] = [
  { type: "auto", label: "overlay.src.auto", hint: "overlay.src.autoHint", icon: "polls" },
  { type: "poll", label: "overlay.src.poll", hint: "overlay.src.pollHint", icon: "poll-choice" },
  { type: "topic", label: "overlay.src.topic", hint: "overlay.src.topicHint", icon: "topics" },
  { type: "next", label: "overlay.src.next", hint: "overlay.src.nextHint", icon: "schedule" },
  { type: "message", label: "overlay.src.message", hint: "overlay.src.messageHint", icon: "megaphone" },
  { type: "card", label: "overlay.src.card", hint: "overlay.src.cardHint", icon: "community" },
  { type: "support", label: "overlay.src.support", hint: "overlay.src.supportHint", icon: "heart" },
  { type: "hidden", label: "overlay.src.hidden", hint: "overlay.src.hiddenHint", icon: "eye-off" },
];
const POSITIONS: readonly [OverlayPosition, MessageId][] = [
  ["lower", "overlay.pos.lower"],
  ["top", "overlay.pos.top"],
  ["corner", "overlay.pos.corner"],
  ["center", "overlay.pos.center"],
];
const SIZES: readonly [OverlaySize, string][] = [
  ["s", "S"],
  ["m", "M"],
  ["l", "L"],
];
const STYLES: readonly [OverlayMessageStyle, MessageId][] = [
  ["info", "overlay.style.info"],
  ["hype", "overlay.style.hype"],
];

export type OverlayAction =
  | { action: "preview"; source: OverlaySourceRef }
  | { action: "take" }
  | { action: "layout"; position?: OverlayPosition; size?: OverlaySize; instant?: boolean; showResults?: boolean }
  | { action: "message"; text: string; style: OverlayMessageStyle };

function sameSource(a: OverlaySourceRef, b: OverlaySourceRef): boolean {
  return a.type === b.type && a.ref === b.ref;
}

/** The ref a source starts with when the owner picks it: the newest poll, topic or card. */
export function defaultRef(type: OverlaySource, data: OverlayData): string | null {
  if (type === "poll") return data.polls[0]?.id ?? null;
  if (type === "topic") return data.topics[0]?.id ?? null;
  if (type === "card") return data.cards[0]?.id ?? null;
  return null;
}

/**
 * What the control shows: the newer of what this tab saved and what the loader read, with a newer live `overlay`
 * message (another control tab, or the phone) on top. That message has no preview or message draft, so those
 * stay until the loader catches up.
 */
export function controlState(
  saved: OverlayState,
  loaded: OverlayState,
  live: OverlayPublic | null | undefined,
): OverlayState {
  const base: OverlayState = loaded.revision > saved.revision ? loaded : saved;
  if (!live || live.revision <= base.revision) return base;
  return {
    ...base,
    air: live.air,
    position: live.position,
    size: live.size,
    showResults: live.showResults,
    message: live.air.type === "message" ? live.message : base.message,
    messageStyle: live.messageStyle,
    revision: live.revision,
  };
}

type MonitorKind = "prev" | "air";

/**
 * Opens "Position and size" on wide screens. Phones start with it closed, under the sources. The <details>
 * element keeps its own open state, so this runs once when it mounts and never fights the person's toggle.
 */
function openOnWideScreens(element: HTMLDetailsElement | null): void {
  if (element && globalThis.matchMedia?.("(min-width: 43.75em)").matches) element.open = true;
}

/**
 * A 1920 by 1080 stage scaled to the width of its frame. The scale is a CSS variable, not React state. The stage
 * stays hidden until it is scaled, so it never shows at a wrong size and spills out of the frame.
 * On narrow screens the enlarge button gives the monitor the full width.
 */
function Monitor({
  kind,
  source,
  scene,
  enlarged,
  onEnlarge,
}: Readonly<{
  kind: MonitorKind;
  source: OverlaySourceRef;
  scene: OverlayScene;
  enlarged: boolean;
  onEnlarge: () => void;
}>): ReactNode {
  const frame = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element: HTMLDivElement | null = frame.current;
    if (!element) return;
    const scale = (): void => {
      element.style.setProperty("--ov-scale", String(element.clientWidth / 1920));
      element.dataset.scaled = "true";
    };
    scale();
    const observer = new ResizeObserver(scale);
    observer.observe(element);
    return (): void => observer.disconnect();
  }, []);
  const label: string = t(SOURCES.find((item) => item.type === source.type)?.label ?? "overlay.src.auto");
  return (
    <figure className={`ov-monitor ${kind}`} data-ov-monitor={kind}>
      <figcaption>
        {kind === "air" ? (
          <span className="onair-badge">{t("overlay.onAir")}</span>
        ) : (
          <span className="preview-badge">{t("overlay.preview")}</span>
        )}
        {t(kind === "air" ? "overlay.onAirIs" : "overlay.previewIs", { source: label })}
      </figcaption>
      <div className="ov-frame" ref={frame}>
        <div className="ov-scaler">
          <OverlayStage scene={scene} source={source} />
        </div>
        <IconButton
          className="ov-enlarge-btn"
          label={t(kind === "air" ? "overlay.enlargeAir" : "overlay.enlargePreview")}
          icon={enlarged ? "zoom-out" : "zoom-in"}
          iconSize={16}
          aria-pressed={enlarged}
          onClick={onEnlarge}
          data-ov-enlarge={kind}
        />
      </div>
    </figure>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  disabled: boolean;
  onChange: (value: T) => void;
}>): ReactNode {
  return (
    <fieldset className="field ov-seg-field">
      <legend className="field-label">{label}</legend>
      <div className="seg">
        {options.map(([option, text]) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            disabled={disabled}
            onClick={() => onChange(option)}
          >
            {text}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function MessageEditor({
  state,
  busy,
  run,
}: Readonly<{ state: OverlayState; busy: boolean; run: (action: OverlayAction) => void }>): ReactNode {
  const [text, setText] = useState<string>(state.message);
  const inputId: string = useId();
  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    run({ action: "message", text, style: state.messageStyle });
  }
  return (
    <form className="ov-sub" onSubmit={save}>
      <label htmlFor={inputId}>
        <span>{t("overlay.messageLabel", { n: OVERLAY_MESSAGE_MAX })}</span>
      </label>
      <input
        id={inputId}
        maxLength={OVERLAY_MESSAGE_MAX}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        data-ov-message
      />
      <div className="ov-message-row">
        <Segmented
          label={t("overlay.messageStyle")}
          value={state.messageStyle}
          options={STYLES.map(([style, id]) => [style, t(id)] as const)}
          disabled={busy}
          onChange={(style: OverlayMessageStyle) => run({ action: "message", text, style })}
        />
        <button type="submit" className="small-button" disabled={busy || text === state.message}>
          <Icon name="save" size={16} />
          {t("overlay.saveMessage")}
        </button>
      </div>
    </form>
  );
}

function SourcePicker({
  type,
  state,
  data,
  busy,
  run,
}: Readonly<{
  type: OverlaySource;
  state: OverlayState;
  data: OverlayData;
  busy: boolean;
  run: (action: OverlayAction) => void;
}>): ReactNode {
  const labelId: string = useId();
  const pick = (ref: string): void => run({ action: "preview", source: { type, ref } });
  if (type === "poll")
    return (
      <div className="ov-sub">
        <span className="sr-only" id={labelId}>
          {t("overlay.pickPoll")}
        </span>
        {data.polls.length > 0 ? (
          <Select
            labelledBy={labelId}
            options={data.polls.map((poll) => ({
              value: poll.id,
              label: poll.mash ? `${MASH_NAME}: ${poll.title}` : poll.title,
              icon: poll.mash ? "zap" : "polls",
            }))}
            value={state.preview.ref ?? undefined}
            onValueChange={pick}
            disabled={busy}
          />
        ) : (
          <p className="muted">{t("overlay.noPolls")}</p>
        )}
        <label className="choice ov-toggle">
          <input
            type="checkbox"
            checked={state.showResults}
            disabled={busy}
            onChange={(event) => run({ action: "layout", showResults: event.currentTarget.checked })}
          />
          <span>{t("overlay.showResults")}</span>
        </label>
      </div>
    );
  if (type === "topic")
    return (
      <div className="ov-sub">
        <span className="sr-only" id={labelId}>
          {t("overlay.pickTopic")}
        </span>
        {data.topics.length > 0 ? (
          <Select
            labelledBy={labelId}
            options={data.topics.map((topic) => ({ value: topic.id, label: topic.title, icon: "topics" }))}
            value={state.preview.ref ?? undefined}
            onValueChange={pick}
            disabled={busy}
          />
        ) : (
          <p className="muted">{t("overlay.noTopics")}</p>
        )}
      </div>
    );
  if (type === "card")
    return (
      <div className="ov-sub">
        <span className="sr-only" id={labelId}>
          {t("overlay.pickCard")}
        </span>
        {data.cards.length > 0 ? (
          <Select
            labelledBy={labelId}
            options={data.cards.map((card) => ({ value: card.id, label: card.title }))}
            value={state.preview.ref ?? undefined}
            onValueChange={pick}
            disabled={busy}
          />
        ) : (
          <p className="muted">{t("overlay.noCards")}</p>
        )}
      </div>
    );
  if (type === "message") return <MessageEditor key={state.message} state={state} busy={busy} run={run} />;
  return null;
}

/**
 * Overlay control (item 33): Preview and On air monitors, Take, instant switch, layout presets and the
 * sources. Every change goes to `POST /api/overlay`, and the live room tells the OBS page at once.
 */
export function OverlayControl({
  initial,
  live,
  scene,
  overlayUrl,
  connected = true,
}: Readonly<{
  initial: OverlayState;
  /** The overlay as the live room last sent it, so a change from another tab shows here too. */
  live?: OverlayPublic | null;
  scene: Omit<OverlayScene, "overlay">;
  overlayUrl: string;
  /** False while the live connection is down: changes still save, but the OBS page hears of them later. */
  connected?: boolean;
}>): ReactNode {
  const toast = useToast();
  const [saved, setSaved] = useState<OverlayState>(initial);
  const state: OverlayState = controlState(saved, initial, live);
  const [busy, setBusy] = useState<boolean>(false);
  const [enlarged, setEnlarged] = useState<MonitorKind | null>(null);
  const enlarge = (kind: MonitorKind): void => setEnlarged((value) => (value === kind ? null : kind));
  useEffect(() => {
    if (!connected) announce(t("overlay.disconnected"));
  }, [connected]);
  const titleId: string = useId();
  const same: boolean = sameSource(state.preview, state.air);
  const view: OverlayScene = { ...scene, overlay: state };

  async function send(action: OverlayAction): Promise<void> {
    setBusy(true);
    try {
      const result = await postJson<{ overlay: OverlayState }>("/api/overlay", action);
      setSaved(result.overlay);
    } catch (error: unknown) {
      toast(errorMessage(error), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  const run = (action: OverlayAction): void => {
    void send(action);
  };
  const choose = (type: OverlaySource): void => {
    if (state.preview.type === type) return;
    run({ action: "preview", source: { type, ref: defaultRef(type, scene.data) } });
  };

  // Shortcuts: 1–8 pick a source, T takes the preview live. Typing in a field never triggers them.
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (busy || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable], [role=dialog], [role=listbox]")) return;
      const index: number = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < SOURCES.length) {
        event.preventDefault();
        choose(SOURCES[index].type);
      } else if ((event.key === "t" || event.key === "T") && !same && !state.instant) {
        event.preventDefault();
        run({ action: "take" });
      }
    };
    document.addEventListener("keydown", listener);
    return (): void => document.removeEventListener("keydown", listener);
  });

  async function copyUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(overlayUrl);
      toast(t("overlay.copied"));
    } catch {
      toast(t("contact.copyFallback"));
    }
  }

  const sourceLabel = (source: OverlaySourceRef): string =>
    t(SOURCES.find((item) => item.type === source.type)?.label ?? "overlay.src.auto");
  const take: ReactNode = (
    <div className="ov-take">
      <p className="ov-take-label">
        <span className="preview-badge">{t("overlay.preview")}</span>
        <strong>{sourceLabel(state.preview)}</strong>
      </p>
      <p className="ov-take-onair">
        <span className="onair-dot" aria-hidden="true" />
        <span>{t("overlay.onAirIs", { source: sourceLabel(state.air) })}</span>
      </p>
      <button
        type="button"
        className="gold ov-take-btn"
        disabled={busy || same || state.instant}
        onClick={() => run({ action: "take" })}
        data-ov-take
      >
        <Icon name="live" size={20} />
        {t("overlay.take")} <kbd aria-hidden="true">T</kbd>
      </button>
      <label className="choice">
        <input
          type="checkbox"
          checked={state.instant}
          disabled={busy}
          onChange={(event) => run({ action: "layout", instant: event.currentTarget.checked })}
        />
        <span>{t("overlay.instant")}</span>
      </label>
    </div>
  );

  return (
    <>
      <div className="ov-head">
        <div>
          <span className="eyebrow">{t("overlay.eyebrow")}</span>
          <h1>{t("overlay.controlTitle")}</h1>
        </div>
        <p className="muted ov-keys">
          <Icon name="about" size={16} />
          {t("overlay.shortcutsLead")} <kbd>1</kbd>–<kbd>8</kbd> {t("overlay.shortcutsPick")} <kbd>T</kbd>{" "}
          {t("overlay.shortcutsTake")}
        </p>
      </div>
      {!connected && (
        <p className="ov-conn">
          <Icon name="wifi-off" size={18} />
          <span>
            <strong>{t("overlay.disconnected")}</strong> {t("overlay.disconnectedBody")}
          </span>
        </p>
      )}
      <div className={`ov-grid${state.instant ? " is-instant" : ""}${enlarged ? ` enlarge-${enlarged}` : ""}`}>
        {!state.instant && (
          <Monitor
            kind="prev"
            source={state.preview}
            scene={view}
            enlarged={enlarged === "prev"}
            onEnlarge={() => enlarge("prev")}
          />
        )}
        {take}
        <Monitor
          kind="air"
          source={state.air}
          scene={view}
          enlarged={enlarged === "air"}
          onEnlarge={() => enlarge("air")}
        />
        <section className="ov-sources" aria-labelledby={titleId}>
          <h2 id={titleId}>{t("overlay.sources")}</h2>
          <ul>
            {SOURCES.map((source, index: number) => {
              const selected: boolean = state.preview.type === source.type;
              const onAir: boolean = state.air.type === source.type;
              const classes: string = `ov-source${selected ? " is-selected" : ""}${onAir ? " is-air" : ""}`;
              return (
                <li key={source.type} className={classes}>
                  <label className="ov-source-main">
                    <input
                      type="radio"
                      name="ov-source"
                      value={source.type}
                      checked={selected}
                      disabled={busy}
                      onChange={() => choose(source.type)}
                    />
                    <span className="ov-key" aria-hidden="true">
                      {index + 1}
                    </span>
                    <Icon name={source.icon} size={20} />
                    <span className="ov-source-text">
                      <strong>{t(source.label)}</strong>
                      <small>{t(source.hint)}</small>
                    </span>
                    {onAir && <span className="onair-badge">{t("overlay.onAir")}</span>}
                  </label>
                  {selected && (
                    <SourcePicker type={source.type} state={state} data={scene.data} busy={busy} run={run} />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        <div className="ov-extra">
          <details className="ov-layout-wrap" ref={openOnWideScreens}>
            <summary>
              <Icon name="overlay" size={16} />
              {t("overlay.positionAndSize")}
            </summary>
            <div className="ov-layout">
              <Segmented
                label={t("overlay.position")}
                value={state.position}
                options={POSITIONS.map(([position, id]) => [position, t(id)] as const)}
                disabled={busy}
                onChange={(position: OverlayPosition) => run({ action: "layout", position })}
              />
              <Segmented
                label={t("overlay.size")}
                value={state.size}
                options={SIZES}
                disabled={busy}
                onChange={(size: OverlaySize) => run({ action: "layout", size })}
              />
            </div>
          </details>
          <details className="ov-setup">
            <summary>
              <Icon name="link" size={16} />
              {t("overlay.setup")}
            </summary>
            <div className="ov-url">
              <p>
                <strong>{t("overlay.url")}</strong>
              </p>
              <div className="contact-address">
                <span className="contact-email" data-ov-url>
                  {overlayUrl.replace(/^https?:\/\//, "")}
                </span>
                <IconButton label={t("overlay.copyUrl")} icon="copy" iconSize={18} onClick={() => void copyUrl()} />
              </div>
              <p className="muted">{t("overlay.obsHelp")}</p>
            </div>
          </details>
        </div>
      </div>
      <div className="ov-take-dock">{take}</div>
    </>
  );
}
