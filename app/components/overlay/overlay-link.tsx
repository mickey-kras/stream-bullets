import { useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { errorMessage, postJson } from "../api";
import { Dialog, DialogActions } from "../ui/dialog";
import { IconButton } from "../ui/icon-button";
import { useToast } from "../ui/toast";

/**
 * The private OBS URL. The server keeps only a hash of its key, so the full URL shows once, right after it is made.
 * A new link revokes the old one, so the owner confirms first.
 */
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

  async function copyUrl(): Promise<void> {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast(t("overlay.copied"));
    } catch {
      toast(t("contact.copyFallback"));
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
        <div className="contact-address">
          <input
            className="contact-email ov-url-field"
            type="text"
            readOnly
            value={url}
            aria-label={t("overlay.url")}
            spellCheck={false}
            autoComplete="off"
            data-ov-url
          />
          <IconButton label={t("overlay.copyUrl")} icon="copy" iconSize={18} onClick={() => void copyUrl()} />
        </div>
      )}
      <p className="muted">{hint}</p>
      <p className="muted">{t("overlay.obsHelp")}</p>
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
