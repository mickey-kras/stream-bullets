import { useState, type ReactNode } from "react";
import { t, type MessageId } from "../../i18n";
import { copyText } from "../../lib/clipboard";
import { layerUrl, type OverlayLayer } from "../../lib/overlay-layers";
import { errorMessage, postJson } from "../api";
import { Dialog, DialogActions } from "../ui/dialog";
import { IconButton } from "../ui/icon-button";
import { useToast } from "../ui/toast";

// Per-layer OBS sources. Characters arrive with the playground (#664).
const LAYER_LINKS: readonly (readonly [OverlayLayer, MessageId, boolean])[] = [
  ["chat", "overlay.layer.chat", false],
  ["content", "overlay.layer.content", false],
  ["characters", "overlay.layer.characters", true],
];

function CopyField({
  value,
  label,
  copyLabel,
  layer,
}: Readonly<{ value: string; label: string; copyLabel: string; layer: OverlayLayer | null }>): ReactNode {
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
        spellCheck={false}
        autoComplete="off"
        data-ov-url={layer === null ? "" : undefined}
        data-ov-layer-url={layer ?? undefined}
      />
      <IconButton label={copyLabel} icon="copy" iconSize={18} onClick={() => void copy()} />
    </div>
  );
}

// Show private URL once; store only its key hash. Confirm regeneration because it revokes the old link.
export function OverlayLink({ hasKey }: Readonly<{ hasKey: boolean }>): ReactNode {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [made, setMade] = useState<boolean>(hasKey);
  const [confirming, setConfirming] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  async function regenerate(): Promise<void> {
    setBusy(true);
    try {
      const result = await postJson<{ url: string }>("/api/overlay/key", {});
      setUrl(result.url);
      setMade(true);
      setConfirming(false);
      toast(t("overlay.keyMade"));
    } catch (error: unknown) {
      toast(errorMessage(error), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  let hint: string = t("overlay.keyNone");
  if (url) hint = t("overlay.keyOnce");
  else if (made) hint = t("overlay.keyHidden");
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
      <p className="muted">{hint}</p>
      <p className="muted">{t("overlay.obsHelp")}</p>
      {url ? (
        <div className="ov-url-layers" data-ov-layer-urls>
          <p>
            <strong>{t("overlay.layerUrls")}</strong>
          </p>
          <p className="muted">{t("overlay.layerUrlsHelp")}</p>
          {LAYER_LINKS.map(([layer, label, soon]) => (
            <div key={layer} className="ov-url-layer">
              <p className="muted ov-url-caption">
                {t(label)}
                {soon && <span className="ov-comp-soon">{t("overlay.comp.soon")}</span>}
              </p>
              <CopyField
                value={layerUrl(url, layer)}
                label={t(label)}
                copyLabel={t("overlay.copyLayerUrl", { layer: t(label) })}
                layer={layer}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">{t("overlay.layerHelp")}</p>
      )}
      <p>
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
