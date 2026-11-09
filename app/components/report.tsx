import { useId, useState, type FormEvent, type ReactNode } from "react";
import { t, type MessageId } from "../i18n";
import type { ReportReason, ReportTargetKind } from "../types";
import { Modal } from "./common";
import { Icon } from "./ui/icon";
import { errorMessage, postJson } from "./api";

export const reportReasons: readonly { value: ReportReason; label: MessageId; hint: MessageId }[] = [
  { value: "illegal", label: "report.illegal", hint: "report.illegalHint" },
  { value: "harassment", label: "report.harassment", hint: "report.harassmentHint" },
  { value: "spam", label: "report.spam", hint: "report.spamHint" },
  { value: "privacy", label: "report.privacy", hint: "report.privacyHint" },
  { value: "other", label: "report.other", hint: "report.otherHint" },
];

const needsDetails = new Set<ReportReason>(["illegal", "other"]);

/** Lets a signed-in viewer report a topic, poll, or comment for administrator review. */
export function ReportButton({
  targetKind,
  targetId,
  label,
  description,
  onReported,
}: Readonly<{
  targetKind: ReportTargetKind;
  targetId: string;
  /** Accessible name of the trigger, for example "Report comment by Alex". */
  label: string;
  /** What is being reported, shown in the dialog. */
  description: string;
  /** Runs once the report is saved, so the page can show "Reported" instead of the button. */
  onReported?: () => void;
}>): ReactNode {
  const id = useId();
  const [open, setOpen] = useState<boolean>(false);
  const [reason, setReason] = useState<ReportReason>("spam");
  const [details, setDetails] = useState<string>("");
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [sent, setSent] = useState<boolean>(false);
  const required = needsDetails.has(reason);

  function show(): void {
    setReason("spam");
    setDetails("");
    setError("");
    setSent(false);
    setOpen(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await postJson<unknown>("/api/reports", { targetKind, targetId, reason, details: details.trim() });
      setSent(true);
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" aria-label={label} onClick={show}>
        <Icon name="flag" size={16} />
        {t("report.button")}
      </button>
      <Modal
        open={open}
        onOpenChange={(next: boolean) => {
          if (!pending) setOpen(next);
          if (!next && sent) onReported?.();
        }}
        title={sent ? t("report.sent") : t("report.title")}
        description={sent ? t("report.thanks") : description}
      >
        {sent ? (
          <>
            <output className="report-confirmation">{t("report.received")}</output>
            <div className="modal-actions">
              <button
                className="gold"
                type="button"
                onClick={() => {
                  setOpen(false);
                  onReported?.();
                }}
              >
                {t("dialog.closeTitle")}
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              void submit(event);
            }}
          >
            <fieldset className="report-reasons">
              <legend>{t("report.why")}</legend>
              {reportReasons.map((item) => (
                <label key={item.value}>
                  <input
                    type="radio"
                    name={`${id}-reason`}
                    value={item.value}
                    checked={reason === item.value}
                    onChange={() => setReason(item.value)}
                    aria-describedby={`${id}-${item.value}`}
                  />
                  <span>
                    {t(item.label)}
                    <small id={`${id}-${item.value}`}>{t(item.hint)}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <label>
              <span>{required ? t("report.details") : t("report.detailsOptional")}</span>
              <textarea
                value={details}
                onChange={(event) => setDetails(event.currentTarget.value)}
                required={required}
                maxLength={1000}
                rows={3}
                aria-describedby={`${id}-details`}
              />
              <small id={`${id}-details`}>
                {required ? t("report.detailsRequiredHelp") : t("report.detailsHelp")} {t("report.limit")}
              </small>
            </label>
            <p className="muted">{t("report.goodFaith")}</p>
            <p role="alert" className="form-error">
              {error}
            </p>
            <div className="modal-actions">
              <button type="button" disabled={pending} onClick={() => setOpen(false)}>
                {t("dialog.cancel")}
              </button>
              <button className="gold" type="submit" disabled={pending || (required && !details.trim())}>
                {pending ? t("report.sending") : t("report.send")}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
