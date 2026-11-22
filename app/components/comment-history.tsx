import { useState, type ReactNode } from "react";
import { intlLocale, t } from "../i18n";
import type { CommentRevision } from "../types";
import { KeyConfirm } from "./admin/key-confirm";
import { errorMessage, needsStepUp, requestJson } from "./api";
import { CommentMarkdown } from "./comment-markdown";
import { Modal } from "./common";

// The "Edited" label of a comment for the page owner and admins. It opens the texts before each edit.
export function CommentHistory({ commentId }: Readonly<{ commentId: string }>): ReactNode {
  const [open, setOpen] = useState<boolean>(false);
  const [revisions, setRevisions] = useState<CommentRevision[] | null>(null);
  const [error, setError] = useState<string>("");
  // An admin who is not the page owner can need a fresh security key confirmation.
  const [stepUp, setStepUp] = useState<boolean>(false);
  async function load(): Promise<void> {
    setError("");
    try {
      const result = await requestJson<{ revisions: CommentRevision[] }>(`/api/comments/${commentId}/history`);
      setStepUp(false);
      setRevisions(result.revisions);
    } catch (error_: unknown) {
      if (needsStepUp(error_)) setStepUp(true);
      else setError(errorMessage(error_));
    }
  }
  return (
    <>
      <button
        type="button"
        className="text-button comment-history-button"
        aria-label={t("discussion.historyOpen")}
        onClick={() => {
          setOpen(true);
          setRevisions(null);
          void load();
        }}
      >
        {t("discussion.edited")}
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t("discussion.historyTitle")}
        description={t("discussion.historyDescription")}
      >
        <p role="alert" className="form-error">
          {error}
        </p>
        {stepUp && <KeyConfirm inDialog onConfirmed={load} />}
        {!stepUp && !error && revisions === null && <p className="muted">{t("discussion.historyLoading")}</p>}
        {revisions?.length === 0 && <p className="muted">{t("discussion.historyEmpty")}</p>}
        {revisions && revisions.length > 0 && (
          <ol className="comment-history">
            {[...revisions].reverse().map((revision: CommentRevision) => (
              <li key={revision.editedAt}>
                <time className="muted" dateTime={new Date(revision.writtenAt).toISOString()}>
                  {t("discussion.historyWritten", {
                    time: new Date(revision.writtenAt).toLocaleString(intlLocale()),
                  })}
                </time>
                <div className="comment-text">
                  <CommentMarkdown text={revision.text} mentions={revision.mentions} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </Modal>
    </>
  );
}
