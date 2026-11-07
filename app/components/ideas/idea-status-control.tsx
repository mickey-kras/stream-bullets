import { useId, useState, type FormEvent, type ReactNode } from "react";
import { ENTRY_STATUSES } from "../../../db/enums";
import { t } from "../../i18n";
import type { Entry, EntryStatus } from "../../types";
import { KeyConfirm } from "../admin/key-confirm";
import { adminRequest, errorText, needsStepUp } from "../admin/webauthn";
import { Icon } from "../ui/icon";
import { Select, type SelectOption } from "../ui/select";
import { statusIcons, statusLabel } from "./ideas";

/** The longest "Why not planned" reason the server accepts. */
const MAX_REASON = 500;

const options: SelectOption[] = ENTRY_STATUSES.map((status: EntryStatus) => ({
  value: status,
  label: statusLabel(status),
  icon: statusIcons[status],
}));

/**
 * "Status (admins only)" under an idea on the official page (item 46). Not planned needs a reason that everyone
 * sees. Saving goes through `POST /api/admin/entries/:id/status`, so a stale security-key check asks for the key
 * first and then saves again.
 */
export function IdeaStatusControl({
  entry,
  onSaved,
}: Readonly<{ entry: Entry; onSaved: () => Promise<void> }>): ReactNode {
  const id = useId();
  const [status, setStatus] = useState<EntryStatus>(entry.status ?? "review");
  const [reason, setReason] = useState<string>(entry.statusReason ?? "");
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState<boolean>(false);
  const [stepUp, setStepUp] = useState<boolean>(false);
  const changed: boolean =
    status !== entry.status || (status === "declined" && reason.trim() !== (entry.statusReason ?? ""));

  async function save(): Promise<void> {
    setPending(true);
    setError("");
    try {
      await adminRequest(`/api/admin/entries/${encodeURIComponent(entry.id)}/status`, "POST", {
        status,
        reason: status === "declined" ? reason.trim() : "",
      });
      setStepUp(false);
      await onSaved();
    } catch (error_: unknown) {
      if (needsStepUp(error_)) setStepUp(true);
      else setError(errorText(error_));
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    void save();
  }

  return (
    <form className="field idea-admin" onSubmit={submit}>
      <span className="field-label" id={`${id}-label`}>
        {t("ideas.admin.status")}
      </span>
      <Select
        id={`${id}-status`}
        labelledBy={`${id}-label`}
        options={options}
        value={status}
        disabled={pending}
        onValueChange={(value: string) => setStatus(value as EntryStatus)}
      />
      {status === "declined" && (
        <label>
          <span>{t("ideas.admin.reason")}</span>
          <textarea
            rows={2}
            maxLength={MAX_REASON}
            required
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        </label>
      )}
      <p className="form-error" role="alert">
        {error}
      </p>
      {stepUp ? (
        <KeyConfirm inDialog label={t("ideas.admin.confirm")} onConfirmed={save} />
      ) : (
        <button type="submit" className="small-button" disabled={pending || !changed}>
          <Icon name="check" size={16} />
          {pending ? t("common.saving") : t("ideas.admin.save")}
        </button>
      )}
    </form>
  );
}
