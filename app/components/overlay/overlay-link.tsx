import { useId, useState, type ReactNode } from "react";
import { intlLocale, t, tn, type MessageId } from "../../i18n";
import { relativeAge } from "../../lib/channel-health";
import { copyText } from "../../lib/clipboard";
import {
  forOutput,
  frameSize,
  layerPixels,
  layerUrl,
  ORIENTATIONS,
  type Orientation,
  type OverlayLayer,
  type OverlayLayers,
} from "../../lib/overlay-layers";
import { errorMessage, postJson } from "../api";
import { outputSources, type OverlaySources, type SourceState } from "../live";
import { Dialog, DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { useToast } from "../ui/toast";
import { CHARACTERS_READY } from "./overlay-composition";

// Per-layer OBS sources. Characters arrive with the playground (#664): until then the row only says so.
const LAYER_LINKS: readonly (readonly [OverlayLayer, MessageId])[] = [
  ["chat", "overlay.layer.chat"],
  ["content", "overlay.layer.content"],
  ["characters", "overlay.layer.characters"],
];

function CopyField({
  value,
  label,
  copyLabel,
  layer,
  describedBy,
}: Readonly<{
  value: string;
  label: string;
  copyLabel: string;
  layer: OverlayLayer | null;
  /** The id of a text that describes the field, like the source size of a layer URL. */
  describedBy?: string;
}>): ReactNode {
  const toast = useToast();
  async function copy(): Promise<void> {
    toast((await copyText(value)) ? t("overlay.copied") : t("contact.copyFallback"));
  }
  return (
    <div className="contact-address">
      <input
        className="contact-email ov-url-field"
        type="text"
        readOnly
        value={value}
        aria-label={label}
        aria-describedby={describedBy}
        spellCheck={false}
        autoComplete="off"
        data-ov-url={layer === null ? "" : undefined}
        data-ov-layer-url={layer ?? undefined}
      />
      <IconButton label={copyLabel} icon="copy" iconSize={18} onClick={() => void copy()} />
    </div>
  );
}

const OUTPUT_NAMES: Readonly<Record<Orientation, MessageId>> = {
  horizontal: "overlay.output.horizontal",
  vertical: "overlay.output.vertical",
};

/** The sentence about the OBS sources of the page or of one output at the time `now`. */
export function sourcesText(sources: SourceState, now: number): string {
  if (sources.count > 0) return tn("overlay.sources.connected", sources.count);
  if (sources.seenAt === null) return t("overlay.sources.never");
  const age: string | null = relativeAge(sources.seenAt, now, intlLocale());
  return age === null ? t("overlay.sources.goneNow") : t("overlay.sources.gone", { age });
}

/**
 * The private links for OBS: one for the horizontal output and one for the vertical output. The two outputs are on
 * stream at the same time, and a streamer can use one link or the two.
 */
export function OverlayLink({
  hasKey,
  layers,
  sources,
  now,
  busy,
  onTwitchOnly,
}: Readonly<{
  /** Which outputs have a link. */
  hasKey: Readonly<Record<Orientation, boolean>>;
  /** The newest saved or live layers, for the source sizes and the Twitch switches. */
  layers: OverlayLayers;
  /** The connected OBS sources. Null while the live room did not tell. */
  sources: OverlaySources | null;
  /** The server time, for the age of the last connection. */
  now: number;
  /** True while a change saves. */
  busy: boolean;
  /** Saves whether one output shows chat and characters from Twitch only. */
  onTwitchOnly: (output: Orientation, on: boolean) => void;
}>): ReactNode {
  return (
    <div className="ov-url">
      <p>
        <strong>{t("overlay.url")}</strong>
      </p>
      <p className="muted">{t("overlay.keyNone")}</p>
      {ORIENTATIONS.map((output: Orientation) => (
        <OutputLink
          key={output}
          output={output}
          hasKey={hasKey[output]}
          layers={forOutput(layers, output)}
          sources={sources && outputSources(sources, output)}
          now={now}
        />
      ))}
      <TwitchOnly layers={layers} busy={busy} onChange={onTwitchOnly} />
    </div>
  );
}

const TWITCH_ONLY: Readonly<Record<Orientation, MessageId>> = {
  horizontal: "overlay.twitch.horizontal",
  vertical: "overlay.twitch.vertical",
};

/**
 * The closed section for a streamer who sends the stream to Twitch and to other platforms: one switch for each
 * output. With the switch on, the output shows chat and characters from Twitch only. The default is the merged chat.
 */
function TwitchOnly({
  layers,
  busy,
  onChange,
}: Readonly<{
  layers: OverlayLayers;
  busy: boolean;
  onChange: (output: Orientation, on: boolean) => void;
}>): ReactNode {
  return (
    <details className="ch-details ov-url-twitch" data-ov-twitch>
      <summary>{t("overlay.twitch.title")}</summary>
      <p className="muted">{t("overlay.twitch.body")}</p>
      {ORIENTATIONS.map((output: Orientation) => (
        <label className="choice" key={output}>
          <input
            type="checkbox"
            checked={layers.twitchOnly[output]}
            disabled={busy}
            onChange={(event) => onChange(output, event.currentTarget.checked)}
            data-ov-twitch-only={output}
          />
          <span>{t(TWITCH_ONLY[output])}</span>
        </label>
      ))}
    </details>
  );
}

// The private URL of one output shows after its owner makes it or asks to see it again. Confirm regeneration
// because it revokes the old link of that output. The link of the other output stays.
function OutputLink({
  output,
  hasKey,
  layers,
  sources,
  now,
}: Readonly<{
  output: Orientation;
  hasKey: boolean;
  /** The layers as this output shows them. */
  layers: OverlayLayers;
  sources: SourceState | null;
  now: number;
}>): ReactNode {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [made, setMade] = useState<boolean>(hasKey);
  const [confirming, setConfirming] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  // False after the server said that it has no copy of the key.
  const [kept, setKept] = useState<boolean>(true);
  const sizeId: string = useId();

  async function regenerate(): Promise<void> {
    setBusy(true);
    try {
      const result = await postJson<{ url: string }>("/api/overlay/key", { output });
      setUrl(result.url);
      setMade(true);
      setKept(true);
      setConfirming(false);
      toast(t("overlay.keyMade"));
    } catch (error: unknown) {
      toast(errorMessage(error), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function show(): Promise<void> {
    setBusy(true);
    try {
      const result = await postJson<{ url: string | null }>("/api/overlay/key/show", { output });
      if (result.url === null) setKept(false);
      else setUrl(result.url);
    } catch (error: unknown) {
      toast(errorMessage(error), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  let hint: string | null = null;
  if (url) hint = t("overlay.keyOnce");
  else if (made) hint = t(kept ? "overlay.keyHidden" : "overlay.keyNotKept");
  const name: string = t(OUTPUT_NAMES[output]);
  const size = frameSize(output);
  return (
    <section className="ov-url-output" aria-labelledby={`${sizeId}-name`} data-ov-output={output}>
      <p id={`${sizeId}-name`}>
        <strong>{name}</strong>
      </p>
      {url && (
        <>
          <p className="muted ov-url-caption">{t("overlay.layer.composition")}</p>
          <CopyField
            value={url}
            label={`${t("overlay.url")}: ${name}`}
            copyLabel={`${t("overlay.copyUrl")}: ${name}`}
            layer={null}
          />
        </>
      )}
      {made && sources && (
        <p className="ov-obs-status" data-ov-sources={sources.count}>
          <Icon name={sources.count > 0 ? "wifi" : "wifi-off"} size={18} />
          <span>{sourcesText(sources, now)}</span>
        </p>
      )}
      {hint && <p className="muted">{hint}</p>}
      <p className="muted">{t("overlay.obsHelp", size)}</p>
      {url ? (
        <div className="ov-url-layers" data-ov-layer-urls>
          <p>
            <strong>{t("overlay.layerUrls")}</strong>
          </p>
          <p className="muted">{t("overlay.layerUrlsHelp")}</p>
          {LAYER_LINKS.map(([layer, label]) => {
            if (layer === "characters" && !CHARACTERS_READY) return null;
            // The size in this output: the frame for the content layers, else the cell of the layer.
            const layerSize: { w: number; h: number } | null = layer === "content" ? size : layerPixels(layers, layer);
            const sizeLine: string | undefined = layerSize ? `${sizeId}-${layer}` : undefined;
            return (
              <div key={layer} className="ov-url-layer" data-ov-layer-row={layer}>
                <p className="muted ov-url-caption">{t(label)}</p>
                {layerSize && (
                  <p className="muted ov-url-size" id={sizeLine} data-ov-layer-size={layer}>
                    {t("overlay.layer.size", { w: layerSize.w, h: layerSize.h })}
                  </p>
                )}
                <CopyField
                  value={layerUrl(url, layer)}
                  label={`${t(label)}: ${name}`}
                  copyLabel={`${t("overlay.copyLayerUrl", { layer: t(label) })}: ${name}`}
                  layer={layer}
                  describedBy={sizeLine}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted">{t("overlay.layerHelp")}</p>
      )}
      <p className="ov-url-actions">
        {made && !url && kept && (
          <button type="button" className="gold" disabled={busy} onClick={() => void show()}>
            {t("overlay.keyShow")}
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => (made ? setConfirming(true) : void regenerate())}>
          {t(made ? "overlay.keyRegenerate" : "overlay.keyCreate")}
        </button>
      </p>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("overlay.keyConfirmTitle")}
        description={`${t("overlay.keyConfirmBody")} ${t("overlay.keyConfirmOther")}`}
        actions={
          <DialogActions>
            <button type="button" className="danger" disabled={busy} onClick={() => void regenerate()}>
              {t("overlay.keyRegenerate")}
            </button>
          </DialogActions>
        }
      />
    </section>
  );
}
