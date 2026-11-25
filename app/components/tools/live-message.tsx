import { useId, useState, type FormEvent, type ReactNode } from "react";
import { t } from "../../i18n";
import { onStream, type OverlayLayers } from "../../lib/overlay-layers";
import type { OverlayMessageStyle, OverlayState } from "../../types";
import { MESSAGE_STYLES, OVERLAY_MESSAGE_MAX } from "../overlay/layer-properties";
import type { ControlAction } from "../overlay/use-overlay-state";
import { Icon } from "../ui/icon";
import { LivePart, NotOnGrid, placed } from "./live-part";

/**
 * The message banner: its text, its style, and its place on air. The button saves the text and puts the banner on
 * stream in one step. The text is a draft until then: viewers do not get it.
 */
export function LiveMessage({
  state,
  busy,
  send,
}: Readonly<{ state: OverlayState; busy: boolean; send: (action: ControlAction) => Promise<boolean> }>): ReactNode {
  const [text, setText] = useState<string>(state.message);
  const [style, setStyle] = useState<OverlayMessageStyle>(state.messageStyle);
  const inputId: string = useId();
  const layers: OverlayLayers = state.layers;
  const onAir: boolean = onStream(layers, "message");
  const changed: boolean = text !== state.message || style !== state.messageStyle;

  async function show(): Promise<void> {
    if (changed && !(await send({ action: "message", text, style }))) return;
    if (!onAir) await send({ action: "layers", items: { message: { enabled: true } } });
  }
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void show();
  }
  return (
    <LivePart name="message" title={t("tools.live.message")}>
      <form className="tl-form" onSubmit={submit}>
        <label className="field-label" htmlFor={inputId}>
          {t("overlay.messageLabel", { n: OVERLAY_MESSAGE_MAX })}
        </label>
        <input
          id={inputId}
          maxLength={OVERLAY_MESSAGE_MAX}
          value={text}
          // A save puts a new form here. No edit during the save, so the new form does not drop one.
          readOnly={busy}
          onChange={(event) => setText(event.currentTarget.value)}
          data-live-message
        />
        <fieldset className="field ov-seg-field">
          <legend className="field-label">{t("overlay.messageStyle")}</legend>
          <div className="seg">
            {MESSAGE_STYLES.map(([value, id]) => (
              <button
                key={value}
                type="button"
                aria-pressed={style === value}
                disabled={busy}
                onClick={() => setStyle(value)}
              >
                {t(id)}
              </button>
            ))}
          </div>
        </fieldset>
        {placed(layers, "message") ? (
          <div className="tl-actions">
            <span className="tl-state" data-on-air={onAir || undefined}>
              {t(onAir ? "tools.live.onAir" : "tools.live.offAir")}
            </span>
            <button
              type="submit"
              className="small-button"
              disabled={busy || text.trim() === "" || (onAir && !changed)}
              data-live-message-show
            >
              <Icon name="megaphone" size={16} />
              {t(onAir ? "tools.live.message.update" : "tools.live.message.put")}
            </button>
            {onAir && (
              <button
                type="button"
                className="small-button"
                disabled={busy}
                data-live-message-off
                onClick={() => void send({ action: "layers", items: { message: { enabled: false } } })}
              >
                <Icon name="stop" size={16} />
                {t("tools.live.takeOff")}
              </button>
            )}
          </div>
        ) : (
          <NotOnGrid layer="message" />
        )}
      </form>
    </LivePart>
  );
}
