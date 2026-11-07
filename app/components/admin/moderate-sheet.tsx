import { useState, type FormEvent, type ReactNode } from "react";
import { MODERATION_REASONS, type ModerationReason, type PageAction } from "../../admin-types";
import { t, type MessageId } from "../../i18n";
import { reasonLabels } from "../../lib/moderation";
import type { StreamerStatus } from "../../types";
import { StreamerLogo } from "../ui/avatar";
import { DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Select } from "../ui/select";
import { Sheet } from "../ui/sheet";
import { KeyConfirm } from "./key-confirm";
import { adminRequest, errorText, needsStepUp } from "./webauthn";

/** The page a moderation action is about, as the admin lists show it. */
export interface ModeratedPage {
  id: string;
  handle: string;
  name: string;
  logo: string | null;
  avatar: string | null;
  ownerAvatarPreset: number | null;
  status: StreamerStatus;
}

const actionCopy: Record<PageAction, { verb: MessageId; title: MessageId; body: MessageId; done: MessageId }> = {
  freeze: {
    verb: "moderation.freeze",
    title: "moderation.freezeTitle",
    body: "moderation.freezeBody",
    done: "moderation.frozenDone",
  },
  unfreeze: {
    verb: "moderation.unfreeze",
    title: "moderation.unfreezeTitle",
    body: "moderation.unfreezeBody",
    done: "moderation.unfrozenDone",
  },
  suspend: {
    verb: "moderation.suspend",
    title: "moderation.suspendTitle",
    body: "moderation.suspendBody",
    done: "moderation.suspendedDone",
  },
  unsuspend: {
    verb: "moderation.unsuspend",
    title: "moderation.unsuspendTitle",
    body: "moderation.unsuspendBody",
    done: "moderation.unsuspendedDone",
  },
};

/** The actions open to a page in its current status. */
export function pageActions(status: StreamerStatus): PageAction[] {
  if (status === "suspended") return ["unsuspend"];
  if (status === "frozen") return ["unfreeze", "suspend"];
  return ["freeze", "suspend"];
}

export function actionLabel(action: PageAction): string {
  return t(actionCopy[action].verb);
}

export function actionIcon(action: PageAction): "lock" | "reset" | "eye-off" | "eye" {
  if (action === "freeze") return "lock";
  if (action === "unfreeze") return "reset";
  if (action === "suspend") return "eye-off";
  return "eye";
}

interface ModerationInput {
  action: PageAction;
  reason: ModerationReason;
  note: string;
  notify: boolean;
}

/**
 * Freeze, unfreeze, suspend or unsuspend one page with a reason, an internal note and an optional owner notice.
 * Freezing and suspending need a step-up from the last 2 minutes: when the server asks, the sheet shows the key
 * check and then sends the same request again.
 */
export function ModerateSheet({
  page,
  action,
  onClose,
  onDone,
}: Readonly<{
  page: ModeratedPage;
  action: PageAction;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}>): ReactNode {
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState<ModerationInput | null>(null);
  const copy = actionCopy[action];
  const formId = `moderate-${page.id}`;
  const danger: boolean = action === "freeze" || action === "suspend";

  async function send(input: ModerationInput): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const result = await adminRequest<{ emailed?: boolean }>(`/api/admin/streamers/${page.id}`, "POST", input);
      const done: string = t(copy.done, { handle: page.handle });
      if (!input.notify) await onDone(done);
      else await onDone(`${done} ${t(result.emailed ? "moderation.emailed" : "moderation.inAppOnly")}`);
    } catch (error_: unknown) {
      if (needsStepUp(error_)) setPending(input);
      else setError(errorText(error_));
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const reason = String(data.get("reason") ?? "");
    if (!MODERATION_REASONS.includes(reason as ModerationReason)) {
      setError(t("moderation.chooseReason"));
      return;
    }
    void send({
      action,
      reason: reason as ModerationReason,
      note: String(data.get("note") ?? "").trim(),
      notify: data.get("notify") === "on",
    });
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={pending ? t("keys.confirmTitle") : t(copy.title, { handle: page.handle })}
      name="moderate"
      actions={
        pending ? undefined : (
          <DialogActions>
            <button className={danger ? "danger" : "gold"} type="submit" form={formId} disabled={busy}>
              <Icon name={actionIcon(action)} size={18} />
              {t(copy.verb)}
            </button>
          </DialogActions>
        )
      }
    >
      {pending ? (
        <>
          <p>{t("moderation.sensitive", { action: t(copy.verb), handle: page.handle })}</p>
          <KeyConfirm inDialog onConfirmed={() => send(pending)} />
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
          <p>{t(copy.body)}</p>
          <form id={formId} className="mod-form" onSubmit={submit}>
            <div className="field">
              <span className="field-label" id={`${formId}-reason-label`}>
                {t("moderation.reason")}
              </span>
              <Select
                id={`${formId}-reason`}
                name="reason"
                labelledBy={`${formId}-reason-label`}
                placeholder={t("moderation.chooseReason")}
                required
                options={MODERATION_REASONS.map((reason: ModerationReason) => ({
                  value: reason,
                  label: t(reasonLabels[reason]),
                }))}
              />
            </div>
            <label className="field">
              <span className="field-label">{t("moderation.note")}</span>
              <textarea name="note" rows={3} maxLength={1000} placeholder={t("moderation.notePlaceholder")} />
            </label>
            <label className="choice">
              <input type="checkbox" name="notify" defaultChecked={danger} />
              <span>{t("moderation.notify")}</span>
            </label>
            <p className="form-error" role="alert">
              {error}
            </p>
          </form>
        </>
      )}
    </Sheet>
  );
}
