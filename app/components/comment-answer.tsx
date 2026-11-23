import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { intlLocale, t } from "../i18n";
import type { CommentAnswer } from "../types";
import { errorMessage, requestJson, sendJson } from "./api";
import { Icon } from "./ui/icon";

export interface AnswerLead {
  value: string;
  setValue: (value: string) => void;
  changed: boolean;
  save: () => Promise<void>;
}

/** The lead of the time code of the owner's page, in minutes, for the page dialog. Null until it is read. */
export function useAnswerLead(): AnswerLead | null {
  const [saved, setSaved] = useState<string | null>(null);
  const [value, setValue] = useState<string>("");
  useEffect(() => {
    let current = true;
    requestJson<{ leadMinutes: number }>("/api/streamer/answer-lead")
      .then((result) => {
        if (!current) return;
        setSaved(String(result.leadMinutes));
        setValue(String(result.leadMinutes));
      })
      // Without the value the dialog shows no field; the page keeps its lead.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  if (saved === null) return null;
  return {
    value,
    setValue,
    changed: value !== saved,
    save: async (): Promise<void> => {
      await sendJson("PUT", "/api/streamer/answer-lead", { leadMinutes: Number(value) });
      setSaved(value);
    },
  };
}

/** The field of the lead in the page dialog. */
export function AnswerLeadField({ lead }: Readonly<{ lead: AnswerLead }>): ReactNode {
  return (
    <label>
      <span>{t("page.answerLead")}</span>
      <input
        name="answer-lead"
        type="number"
        min={0}
        max={60}
        step={1}
        required
        value={lead.value}
        onChange={(event) => lead.setValue(event.currentTarget.value)}
      />
    </label>
  );
}

/**
 * The "Answered" mark of a comment (#984). Every reader sees the mark, and the stream with its time code when the
 * page was live. The page owner (`owner`) sets and removes it, and can change the time code.
 */
export function CommentAnswerLine({
  commentId,
  initial,
  owner,
}: Readonly<{ commentId: string; initial: CommentAnswer | undefined; owner: boolean }>): ReactNode {
  const [answer, setAnswer] = useState<CommentAnswer | null>(initial ?? null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [offset, setOffset] = useState<string>(String(initial?.stream?.offsetSeconds ?? 0));
  async function send(body: unknown): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const result = await sendJson<{ answer: CommentAnswer | null }>(
        "POST",
        `/api/comments/${commentId}/answer`,
        body,
      );
      setAnswer(result.answer);
      setOffset(String(result.answer?.stream?.offsetSeconds ?? 0));
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setBusy(false);
    }
  }
  const stream = answer?.stream ?? null;
  return (
    <div className="comment-answer">
      {answer && (
        <p className="comment-answer-line">
          <Icon name="check" size={14} />
          {stream ? (
            <a href={stream.link} target="_blank" rel="noopener noreferrer">
              {t("discussion.answeredOnStream", {
                title: stream.titleTranslation ?? stream.title,
                date: new Date(stream.startedAt).toLocaleDateString(intlLocale()),
              })}
            </a>
          ) : (
            t("discussion.answered")
          )}
        </p>
      )}
      {owner && (
        <div className="comment-answer-controls">
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void send({ action: answer ? "unmark" : "mark" })}
          >
            {t(answer ? "discussion.unmarkAnswered" : "discussion.markAnswered")}
          </button>
          {stream && (
            <form
              className="comment-answer-time"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                void send({ action: "offset", offsetSeconds: Number(offset) });
              }}
            >
              <label>
                {t("discussion.answerTime")}
                <input
                  type="number"
                  min={0}
                  max={172_800}
                  step={1}
                  required
                  value={offset}
                  onChange={(event) => setOffset(event.target.value)}
                />
              </label>
              <button type="submit" disabled={busy}>
                {t("common.save")}
              </button>
            </form>
          )}
          <p className="form-error" role="alert">
            {error}
          </p>
        </div>
      )}
    </div>
  );
}
