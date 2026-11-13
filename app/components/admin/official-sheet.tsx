import { useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { StreamerLogo } from "../ui/avatar";
import { DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Sheet } from "../ui/sheet";
import { KeyConfirm } from "./key-confirm";
import type { ModeratedPage } from "./moderate-sheet";
import { adminRequest, errorText, needsStepUp } from "./webauthn";

// Set/clear official-page status. Retry the request after fresh security-key verification when required.
export function OfficialSheet({
  page,
  official,
  onClose,
  onDone,
}: Readonly<{
  page: ModeratedPage;

  official: boolean;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}>): ReactNode {
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [stepUp, setStepUp] = useState<boolean>(false);
  const verb: string = t(official ? "admin.pages.markOfficial" : "admin.pages.clearOfficial");

  async function send(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await adminRequest(`/api/admin/streamers/${page.id}/official`, "POST", { official });
      await onDone(t(official ? "admin.pages.officialDone" : "admin.pages.officialCleared", { handle: page.handle }));
    } catch (error_: unknown) {
      if (needsStepUp(error_)) setStepUp(true);
      else setError(errorText(error_));
      setBusy(false);
    }
  }

  const title: string = t(official ? "admin.pages.officialTitle" : "admin.pages.clearOfficialTitle", {
    handle: page.handle,
  });
  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={stepUp ? t("keys.confirmTitle") : title}
      name="official"
      actions={
        stepUp ? undefined : (
          <DialogActions>
            <button className="gold" type="button" disabled={busy} onClick={() => void send()}>
              <Icon name="shield-check" size={18} />
              {verb}
            </button>
          </DialogActions>
        )
      }
    >
      {stepUp ? (
        <>
          <p>{t("moderation.sensitive", { action: verb, handle: page.handle })}</p>
          <KeyConfirm inDialog onConfirmed={send} />
        </>
      ) : (
        <>
          <div className="person">
            <StreamerLogo streamer={page} className="avatar-48" />
            <div>
              <strong>{page.name}</strong>
              <p className="muted">@{page.handle}</p>
            </div>
          </div>
          <p>{t(official ? "admin.pages.officialBody" : "admin.pages.clearOfficialBody")}</p>
          <p className="form-error" role="alert">
            {error}
          </p>
        </>
      )}
    </Sheet>
  );
}
