import { useState, type ReactNode } from "react";
import { getLocale, t } from "../i18n";
import type { Comment, CommentMention } from "../types";
import { errorMessage, postJson } from "./api";

interface Translation {
  text: string;
  mentions: CommentMention[];
}

// `forText` is the comment text of the request. An edit of the comment makes the result stale.
interface Loaded {
  forText: string;
  translation: Translation | null;
}

/**
 * The text of a comment to show, and the control that changes between the comment and its translation.
 * The request for a translation starts only when the reader selects the control.
 */
export function useCommentTranslation(
  comment: Comment,
  enabled: boolean,
): { text: string; mentions: CommentMention[] | undefined; control: ReactNode } {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [shown, setShown] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const current: Loaded | null = loaded?.forText === comment.text ? loaded : null;
  const translation: Translation | null = shown && current ? current.translation : null;

  function translate(): void {
    setShown(true);
    if (current) return;
    setBusy(true);
    setError("");
    postJson<{ translation: Translation | null }>(`/api/comments/${comment.id}/translation`, {
      locale: getLocale(),
      text: comment.text,
    })
      .then((result) => setLoaded({ forText: comment.text, translation: result.translation }))
      .catch((error_: unknown) => setError(errorMessage(error_)))
      .finally(() => setBusy(false));
  }

  let control: ReactNode = null;
  if (enabled) {
    const missing: boolean = shown && current !== null && current.translation === null;
    control = (
      <p className="comment-translation">
        {translation && <span>{t("discussion.translated")}</span>}
        {translation ? (
          <button type="button" onClick={() => setShown(false)}>
            {t("discussion.showOriginal")}
          </button>
        ) : (
          !missing && (
            <button type="button" disabled={busy} onClick={translate}>
              {t("discussion.translate")}
            </button>
          )
        )}
        <output>{missing ? t("discussion.noTranslation") : error}</output>
      </p>
    );
  }
  return {
    text: translation ? translation.text : comment.text,
    mentions: translation ? translation.mentions : comment.mentions,
    control,
  };
}
