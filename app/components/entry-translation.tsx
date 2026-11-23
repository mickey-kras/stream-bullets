import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { getLocale, t } from "../i18n";
import type { Entry, EntryText } from "../types";
import { requestTranslation, translationOff, TranslationStopped } from "./translation-queue";
import { TranslatedFrom } from "./translated-from";
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
// The entries of the page now. A request for an entry that left the page is not sent.
let wanted: ReadonlySet<string> = new Set();
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
  requestTranslation<{ translation: EntryText | null }>(
    `/api/entries/${entry.id}/translation`,
    { locale: getLocale(), title: entry.title, body: entry.body, options: entry.options },
    (): boolean => !wanted.has(entry.id),
  )
    .then((result) => {
      const loaded = new Map(state.loaded);
      loaded.set(entry.id, { signature: signature(entry), translation: result.translation });
      change({ ...state, loaded });
    })
    // Without a translation, the entry stays in its original text.
    .catch((error: unknown) => {
      if (error instanceof TranslationStopped) asked.delete(key);
    });
}

/**
 * Gives a function that puts the language of the reader on a topic, poll or idea. The server gives a stored
 * translation with the entry. When it has none, the page of a signed-in reader asks for it one time.
 */
export function useEntryTranslations(
  entries: readonly Entry[],
  selected: Entry | null,
  canAsk: boolean,
): <T extends Entry | null>(entry: T) => T {
  const current: State = useSyncExternalStore(
    subscribe,
    (): State => state,
    (): State => EMPTY,
  );
  // Each render examines the entries. `ask` starts one request for each entry text and language.
  useEffect(() => {
    const all: Entry[] = selected ? [...entries, selected] : [...entries];
    wanted = new Set(all.map((entry: Entry): string => entry.id));
    if (canAsk) for (const entry of all) if (known(entry, current) === undefined) ask(entry);
  });
  useEffect(
    () => (): void => {
      wanted = new Set();
    },
    [],
  );
  return <T extends Entry | null>(entry: T): T => (entry ? (shownEntry(entry, current) as T) : entry);
}

function shownEntry(entry: Entry, current: State): Entry {
  if (entry.translated) return entry;
  const translation = known(entry, current);
  if (!translation) return entry;
  if (current.originals.has(entry.id)) return { ...entry, translated: "original" };
  return { ...entry, ...translation, translated: "shown" };
}

/** The control on one translated entry: it shows the original text of this entry, and then the translation again. */
export function EntryTranslationControl({ entry }: Readonly<{ entry: Entry }>): ReactNode {
  if (!entry.translated) return null;
  const original: boolean = entry.translated === "original";
  return (
    <p className="comment-translation">
      {!original && <TranslatedFrom from={known(entry, state)?.from} />}
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
