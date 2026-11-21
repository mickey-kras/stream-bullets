import { useId, useState, type ReactNode } from "react";
import { intlLocale, t, tn, type MessageId } from "../../i18n";
import { relativeAge } from "../../lib/channel-health";
import { copyText } from "../../lib/clipboard";
import { frameSize, layerPixels, layerUrl, type OverlayLayer, type OverlayLayers } from "../../lib/overlay-layers";
import { errorMessage, postJson } from "../api";
import type { OverlaySources } from "../live";
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

/** The sentence about the OBS sources of the page at the time `now`. */
export function sourcesText(sources: OverlaySources, now: number): string {
  if (sources.count > 0) return tn("overlay.sources.connected", sources.count);
  if (sources.seenAt === null) return t("overlay.sources.never");
  const age: string | null = relativeAge(sources.seenAt, now, intlLocale());
  return age === null ? t("overlay.sources.goneNow") : t("overlay.sources.gone", { age });
}

// The private URL shows after its owner makes it or asks to see it again. Confirm regeneration because it
// revokes the old link.
export function OverlayLink({
  hasKey,
  layers,
  sources,
  now,
}: Readonly<{
  hasKey: boolean;
  /** The newest saved or live layers, for the source sizes. */
  layers: OverlayLayers;
  /** The connected OBS sources. Null while the live room did not tell. */
  sources: OverlaySources | null;
  /** The server time, for the age of the last connection. */
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
      const result = await postJson<{ url: string }>("/api/overlay/key", {});
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
      const result = await postJson<{ url: string | null }>("/api/overlay/key/show", {});
      if (result.url === null) setKept(false);
      else setUrl(result.url);
    } catch (error: unknown) {
      toast(errorMessage(error), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  let hint: string = t("overlay.keyNone");
  if (url) hint = t("overlay.keyOnce");
  else if (made) hint = t(kept ? "overlay.keyHidden" : "overlay.keyNotKept");
  return (
    <div className="ov-url">
      <p>
        <strong>{t("overlay.url")}</strong>
      </p>
      {url && (
        <>
          <p className="muted ov-url-caption">{t("overlay.layer.composition")}</p>
          <CopyField value={url} label={t("overlay.url")} copyLabel={t("overlay.copyUrl")} layer={null} />
        </>
      )}
      {made && sources && (
        <p className="ov-obs-status" data-ov-sources={sources.count}>
          <Icon name={sources.count > 0 ? "wifi" : "wifi-off"} size={18} />
          <span>{sourcesText(sources, now)}</span>
        </p>
      )}
      <p className="muted">{hint}</p>
      <p className="muted">{t("overlay.obsHelp")}</p>
      {url ? (
        <div className="ov-url-layers" data-ov-layer-urls>
          <p>
            <strong>{t("overlay.layerUrls")}</strong>
          </p>
          <p className="muted">{t("overlay.layerUrlsHelp")}</p>
          {LAYER_LINKS.map(([layer, label]) => {
            if (layer === "characters" && !CHARACTERS_READY) return null;
            // The size in the selected orientation: the frame for the content layers, else the cell of the layer.
            const size: { w: number; h: number } | null =
              layer === "content" ? frameSize(layers.orientation) : layerPixels(layers, layer);
            const sizeLine: string | undefined = size ? `${sizeId}-${layer}` : undefined;
            return (
              <div key={layer} className="ov-url-layer" data-ov-layer-row={layer}>
                <p className="muted ov-url-caption">{t(label)}</p>
                {size && (
                  <p className="muted ov-url-size" id={sizeLine} data-ov-layer-size={layer}>
                    {t("overlay.layer.size", { w: size.w, h: size.h })}
                  </p>
                )}
                <CopyField
                  value={layerUrl(url, layer)}
                  label={t(label)}
                  copyLabel={t("overlay.copyLayerUrl", { layer: t(label) })}
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
        description={t("overlay.keyConfirmBody")}
        actions={
          <DialogActions>
            <button type="button" className="danger" disabled={busy} onClick={() => void regenerate()}>
              {t("overlay.keyRegenerate")}
            </button>
          </DialogActions>
        }
      />
    </div>
  );
}
