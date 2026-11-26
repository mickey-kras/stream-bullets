import { useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { errorMessage, postJson } from "../api";
import { Dialog, DialogActions } from "../ui/dialog";
import { useToast } from "../ui/toast";
import { CopyField } from "./copy-field";

/**
 * The closed section for the private OBS dock: a small page with the live controls, for a custom browser dock in
 * OBS. The link grants control, so it shows one time, and the text tells the streamer to keep the dock off screen.
 * A new link stops the old one and closes each open dock.
 */
export function DockLink({ hasKey }: Readonly<{ hasKey: boolean }>): ReactNode {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [made, setMade] = useState<boolean>(hasKey);
  const [confirming, setConfirming] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  async function regenerate(): Promise<void> {
    setBusy(true);
    try {
      const result = await postJson<{ url: string }>("/api/dock/key", {});
      setUrl(result.url);
      setMade(true);
      setConfirming(false);
      toast(t("overlay.dock.ready"));
    } catch (error: unknown) {
      toast(errorMessage(error), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="ch-details ov-url-dock" data-ov-dock>
      <summary>{t("overlay.dock.title")}</summary>
      <p className="muted">{t("overlay.dock.body")}</p>
      <p data-ov-dock-private>
        <strong>{t("overlay.dock.private")}</strong>
      </p>
      {url && (
        <>
          <CopyField value={url} label={t("overlay.dock.url")} copyLabel={t("overlay.dock.copy")} layer={null} dock />
          <p className="muted">{t("overlay.dock.once")}</p>
        </>
      )}
      {made && !url && <p className="muted">{t("overlay.dock.made")}</p>}
      <p className="ov-url-actions">
        <button type="button" disabled={busy} onClick={() => (made ? setConfirming(true) : void regenerate())}>
          {t(made ? "overlay.dock.regenerate" : "overlay.dock.create")}
        </button>
      </p>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("overlay.dock.confirmTitle")}
        description={t("overlay.dock.confirmBody")}
        actions={
          <DialogActions>
            <button type="button" className="danger" disabled={busy} onClick={() => void regenerate()}>
              {t("overlay.dock.regenerate")}
            </button>
          </DialogActions>
        }
      />
    </details>
  );
}
