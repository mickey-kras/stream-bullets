import { useSyncExternalStore, type ReactNode } from "react";
import { t } from "../i18n";
import type { CommunityCard, StreamEvent } from "../types";
import { Icon } from "./ui/icon";

// The items that the reader set to the original text. A stream shows in more than one place of a page, so the
// state is for the page and not for one component.
const EMPTY: ReadonlySet<string> = new Set();
let originals: ReadonlySet<string> = EMPTY;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function toggle(id: string): void {
  const next = new Set(originals);
  if (!next.delete(id)) next.add(id);
  originals = next;
  for (const listener of listeners) listener();
}

/** The IDs of the items that show their original text. */
export function useOriginals(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    (): ReadonlySet<string> => originals,
    (): ReadonlySet<string> => EMPTY,
  );
}

/** The stream with its text in the language of the reader, if the server gave a translation. */
export function shownEvent(event: StreamEvent, shown: ReadonlySet<string>): StreamEvent {
  return event.translation && !shown.has(event.id) ? { ...event, ...event.translation } : event;
}

/** The card with its text in the language of the reader, if the server gave a translation. */
export function shownCard(card: CommunityCard, shown: ReadonlySet<string>): CommunityCard {
  return card.translation && !shown.has(card.id) ? { ...card, ...card.translation } : card;
}

/** The control on one translated item: it shows the original text of this item, and then the translation again. */
export function TranslationControl({ id, translated }: Readonly<{ id: string; translated: boolean }>): ReactNode {
  const original: boolean = useOriginals().has(id);
  if (!translated) return null;
  return (
    <p className="comment-translation">
      <button type="button" aria-pressed={original} onClick={() => toggle(id)}>
        <Icon name="translate" size={16} />
        {original ? t("discussion.showTranslation") : t("discussion.showOriginal")}
      </button>
    </p>
  );
}
