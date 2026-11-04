import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { ReportReason, ReportTargetKind } from "../types";
import { Modal } from "./common";
import { errorMessage, postJson } from "./api";

export const reportReasons: { value: ReportReason; label: string; hint: string }[] = [
  { value: "illegal", label: "Illegal content", hint: "For example threats, incitement, or copyright infringement." },
  { value: "harassment", label: "Harassment or hate", hint: "Attacks on a person or group." },
  { value: "spam", label: "Spam or scam", hint: "Advertising, repeated posts, or misleading links." },
  { value: "privacy", label: "Private information", hint: "Someone's personal details shared without consent." },
  { value: "other", label: "Something else", hint: "Another breach of the community rules." },
];

const needsDetails = new Set<ReportReason>(["illegal", "other"]);

/** Lets a signed-in viewer report a topic, poll, or comment for administrator review. */
export function ReportButton({
  targetKind,
  targetId,
  label,
  description,
}: Readonly<{
  targetKind: ReportTargetKind;
  targetId: string;
  /** Accessible name of the trigger, for example "Report comment by Alex". */
  label: string;
  /** What is being reported, shown in the dialog. */
  description: string;
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
        Report
      </button>
      <Modal
        open={open}
        onOpenChange={(next: boolean) => {
          if (!pending) setOpen(next);
        }}
        title={sent ? "Report sent" : "Report content"}
        description={sent ? "Thank you. An administrator will review it." : description}
      >
        {sent ? (
          <>
            <output className="report-confirmation">
              We received your report. If the content breaks the law or the community rules, we will remove it.
            </output>
            <div className="modal-actions">
              <button className="gold" type="button" onClick={() => setOpen(false)}>
                Close
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
              <legend>Why are you reporting this?</legend>
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
                    {item.label}
                    <small id={`${id}-${item.value}`}>{item.hint}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <label>
              <span>Details{required ? "" : " (optional)"}</span>
              <textarea
                value={details}
                onChange={(event) => setDetails(event.currentTarget.value)}
                required={required}
                maxLength={1000}
                rows={3}
                aria-describedby={`${id}-details`}
              />
              <small id={`${id}-details`}>
                {required
                  ? "Explain why this content breaks the law or the community rules."
                  : "Add anything that helps us review it."}{" "}
                Up to 1000 characters.
              </small>
            </label>
            <p className="muted">
              By sending this report you confirm that it is accurate and made in good faith. Administrators see your
              name with the report. The author does not.
            </p>
            <p role="alert" className="form-error">
              {error}
            </p>
            <div className="modal-actions">
              <button type="button" disabled={pending} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="gold" type="submit" disabled={pending || (required && !details.trim())}>
                {pending ? "Sending…" : "Send report"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
