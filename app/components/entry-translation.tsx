import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { getLocale, t } from "../i18n";
import type { Entry, EntryText } from "../types";
import { requestTranslation, translationOff } from "./translation-queue";
import { Icon } from "./ui/icon";

// The results that this page asked for, and the entries that the reader set to the original text. Topics and
// polls show in more than one place of a page, so the state is for the page and not for one component.
interface State {
  loaded: ReadonlyMap<string, { signature: string; translation: EntryText | null }>;
  originals: ReadonlySet<string>;
}

const EMPTY: State = { loaded: new Map(), originals: new Set() };
let state: State = EMPTY;
const asked = new Set<string>();
const listeners = new Set<() => void>();

function change(next: State): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function signature(entry: Entry): string {
  return JSON.stringify([entry.title, entry.body, entry.options]);
}

function known(entry: Entry, current: State): EntryText | null | undefined {
  if (entry.translation !== undefined) return entry.translation;
  const result = current.loaded.get(entry.id);
  return result?.signature === signature(entry) ? result.translation : undefined;
}

function ask(entry: Entry): void {
  const key: string = `${entry.id}:${getLocale()}:${signature(entry)}`;
  if (asked.has(key) || translationOff()) return;
  asked.add(key);
  requestTranslation<{ translation: EntryText | null }>(`/api/entries/${entry.id}/translation`, {
    locale: getLocale(),
    title: entry.title,
    body: entry.body,
    options: entry.options,
  })
    .then((result) => {
      const loaded = new Map(state.loaded);
      loaded.set(entry.id, { signature: signature(entry), translation: result.translation });
      change({ ...state, loaded });
    })
    // Without a translation, the entry stays in its original text.
    .catch(() => undefined);
}

/**
 * Gives a function that puts the language of the reader on a topic, poll or idea. The server gives a stored
 * translation with the entry. When it has none, the page of a signed-in reader asks for it one time.
 */
export function useEntryTranslations(entries: readonly Entry[], canAsk: boolean): (entry: Entry) => Entry {
  const current: State = useSyncExternalStore(
    subscribe,
    (): State => state,
    (): State => EMPTY,
  );
  // Each render examines the entries. `ask` starts one request for each entry text and language.
  useEffect(() => {
    if (!canAsk) return;
    for (const entry of entries) if (known(entry, current) === undefined) ask(entry);
  });
  return (entry: Entry): Entry => {
    if (entry.translated) return entry;
    const translation = known(entry, current);
    if (!translation) return entry;
    if (current.originals.has(entry.id)) return { ...entry, translated: "original" };
    return { ...entry, ...translation, translated: "shown" };
  };
}

/** The control on one translated entry: it shows the original text of this entry, and then the translation again. */
export function EntryTranslationControl({ entry }: Readonly<{ entry: Entry }>): ReactNode {
  if (!entry.translated) return null;
  const original: boolean = entry.translated === "original";
  return (
    <p className="comment-translation">
      <button
        type="button"
        aria-pressed={original}
        onClick={() => {
          const originals = new Set(state.originals);
          if (original) originals.delete(entry.id);
          else originals.add(entry.id);
          change({ ...state, originals });
        }}
      >
        <Icon name="translate" size={16} />
        {original ? t("discussion.showTranslation") : t("discussion.showOriginal")}
      </button>
    </p>
  );
}
