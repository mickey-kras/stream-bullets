import { useEffect, useState, type ReactNode } from "react";
import { getLocale, t } from "../i18n";
import type { Comment, CommentMention } from "../types";
import { requestTranslation, translationOff } from "./translation-queue";
import { Icon } from "./ui/icon";

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
 * The text of a comment in the language of the reader, and the control that shows the original of this comment.
 * The server gives a stored translation with the comment. When it has none, the page of a signed-in reader asks
 * for it one time. The comment stays in its original text until the translation is ready.
 */
export function useCommentTranslation(
  comment: Comment,
  canAsk: boolean,
): { text: string; mentions: CommentMention[] | undefined; control: ReactNode } {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [original, setOriginal] = useState<boolean>(false);
  const { id, text, removed } = comment;
  const known: boolean = comment.translation !== undefined || loaded?.forText === text;

  useEffect(() => {
    if (!canAsk || known || removed || translationOff()) return;
    let stopped: boolean = false;
    requestTranslation<{ translation: Translation | null }>(
      `/api/comments/${id}/translation`,
      { locale: getLocale(), text },
      (): boolean => stopped,
    )
      .then((result) => {
        if (!stopped) setLoaded({ forText: text, translation: result.translation });
      })
      // Without a translation, the comment stays in its original text.
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [canAsk, known, removed, id, text]);

  let translation: Translation | null = comment.translation ?? null;
  if (loaded?.forText === text) translation = loaded.translation;
  if (!translation) return { text, mentions: comment.mentions, control: null };
  const label: string = original ? t("discussion.showTranslation") : t("discussion.showOriginal");
  return {
    text: original ? text : translation.text,
    mentions: original ? comment.mentions : translation.mentions,
    control: (
      <p className="comment-translation">
        <button type="button" aria-pressed={original} onClick={() => setOriginal(!original)}>
          <Icon name="translate" size={16} />
          {label}
        </button>
      </p>
    ),
  };
}
