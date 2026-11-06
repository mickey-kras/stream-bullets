import { useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { ScrollArea } from "radix-ui";
import { t, tn } from "../../i18n";
import type { Entry, EntryStatus, SortOrder, StreamEvent } from "../../types";
import { IdeaFilters, IdeaStatus } from "../ideas/ideas";
import { platformIcon, platformLabel } from "../schedule/format";
import { TopicIcon } from "../topic-icon";
import { Icon } from "../ui/icon";

function EntryMeta({ entry }: Readonly<{ entry: Entry }>): ReactNode {
  return (
    <span className="topic-meta">
      <span className="sr-only">
        {`${tn("entry.likes", entry.likes)}, ${tn("entry.dislikes", entry.dislikes)}, ${tn("entry.comments", entry.comments)}`}
      </span>
      <span aria-hidden="true">
        <Icon name="thumbs-up" size={16} />
        {entry.likes}
      </span>
      <span aria-hidden="true">
        <Icon name="thumbs-down" size={16} />
        {entry.dislikes}
      </span>
      <span aria-hidden="true">
        <Icon name="comment" size={16} />
        {entry.comments}
      </span>
    </span>
  );
}

/** "Live now: {title} · Watch on Twitch" above the topic list while a stream is live. */
export function LiveStrip({ event }: Readonly<{ event: StreamEvent | null }>): ReactNode {
  if (!event) return null;
  return (
    <p className="live-strip">
      <span>
        <span className="live-lead">
          <span className="live-dot" aria-hidden="true" />
          {t("live.now")}
        </span>{" "}
        <strong>{event.title}</strong>
      </span>{" "}
      ·{" "}
      <a className="text-link" href={event.url} target="_blank" rel="noopener noreferrer">
        <Icon name={platformIcon[event.platform]} size={16} />
        {t("schedule.watchOn", { platform: platformLabel[event.platform] })}
        <Icon name="external" size={14} />
        <span className="sr-only"> {t("common.newTab")}</span>
      </a>
    </p>
  );
}

function Splitter({
  value,
  onChange,
  workspace,
}: Readonly<{ value: number; onChange: (value: number) => void; workspace: React.RefObject<HTMLElement | null> }>) {
  const pointer = useRef<number | null>(null);
  const clamp = (next: number): number => Math.max(25, Math.min(65, next));
  return (
    <input
      type="range"
      min={25}
      max={65}
      step="any"
      value={value}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
      id="splitter"
      aria-label={t("entry.resize")}
      aria-controls="topics detail"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onChange(clamp(value + (event.key === "ArrowRight" ? 2 : -2)));
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.focus();
        pointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (pointer.current !== event.pointerId || !workspace.current) return;
        const bounds: DOMRect = workspace.current.getBoundingClientRect();
        onChange(clamp(((event.clientX - bounds.left) / bounds.width) * 100));
      }}
      onPointerUp={() => {
        pointer.current = null;
      }}
      onPointerCancel={() => {
        pointer.current = null;
      }}
      onDoubleClick={() => onChange(40)}
    />
  );
}

/**
 * The Topics tab (and the Ideas board on the official page): the searchable, sortable list on the left, the
 * selected entry and its discussion on the right, with a resizable split.
 */
export function TopicBoard({
  name,
  entries,
  selected,
  hasSelection,
  official,
  status,
  sort,
  query,
  more,
  loadingMore,
  live,
  emptyList,
  detail,
  onSelect,
  onSort,
  onSearch,
  onLoadMore,
}: Readonly<{
  name: string;
  entries: Entry[];
  selected: Entry | null;
  hasSelection: boolean;
  official: boolean;
  status: EntryStatus | null;
  sort: SortOrder;
  query: string;
  more: boolean;
  loadingMore: boolean;
  live: StreamEvent | null;
  emptyList: ReactNode;
  detail: ReactNode;
  onSelect: (id: string) => void;
  onSort: (sort: SortOrder) => void;
  onSearch: (query: string) => void;
  onLoadMore: () => void;
}>): ReactNode {
  const [split, setSplit] = useState<number>(40);
  const workspace = useRef<HTMLElement>(null);
  const noun = official ? "ideas" : "topics";
  function search(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("query");
    onSearch(typeof value === "string" ? value.trim() : "");
  }
  return (
    <main
      ref={workspace}
      id="main-content"
      className={`topic-workspace${official ? " has-board ideas-board" : ""}${hasSelection ? " has-selection" : ""}`}
      style={{ "--split": `${split}%` } as CSSProperties}
    >
      <section className="browse" aria-label={t(`entry.browse.${noun}`)}>
        <LiveStrip event={live} />
        <div className="intro">
          <h1>
            <span className="sr-only">{name}: </span>
            {t(official ? "ideas.heading" : "entry.heading")}
          </h1>
          <p>{official ? t("ideas.tagline") : t("entry.tagline", { name })}</p>
        </div>
        {official ? (
          <IdeaFilters current={status} />
        ) : (
          <>
            <form className="search" onSubmit={search}>
              <label className="sr-only" htmlFor="topic-search">
                {t("entry.search")}
              </label>
              <input
                key={query}
                id="topic-search"
                name="query"
                type="search"
                maxLength={100}
                defaultValue={query}
                placeholder={t("entry.searchPlaceholder")}
              />
              <button type="submit" className="search-button" aria-label={t("entry.search")}>
                <Icon name="search" size={18} />
                <span className="search-text">{t("entry.searchButton")}</span>
              </button>
            </form>
            <div className="list-toolbar">
              <div className="tabs" aria-label={t("entry.sorting")}>
                {(["top", "newest"] as const).map((value: SortOrder) => (
                  <button
                    key={value}
                    type="button"
                    className={sort === value ? "active" : ""}
                    aria-pressed={sort === value}
                    onClick={() => onSort(value)}
                  >
                    {t(value === "top" ? "entry.sortTop" : "entry.sortNew")}
                  </button>
                ))}
              </div>
              <span className="list-count">
                {tn("entry.count", entries.length)}
                {more ? "+" : ""}
              </span>
            </div>
          </>
        )}
        <ScrollArea.Root className="topic-scroll-root">
          <ScrollArea.Viewport asChild tabIndex={0} style={{ overflowY: "auto" }}>
            <section id="topics" aria-label={t(`entry.list.${noun}`)}>
              {entries.map((entry: Entry) => (
                <button
                  type="button"
                  key={entry.id}
                  className={`topic${official ? " idea-row" : ""} ${selected?.id === entry.id ? "selected" : ""}`}
                  aria-pressed={selected?.id === entry.id}
                  onClick={() => onSelect(entry.id)}
                >
                  <span className="topic-icon">
                    <TopicIcon category={entry.category} />
                  </span>
                  <span className="topic-main">
                    <span className="topic-title">{entry.title}</span>
                    {official ? (
                      <span className="idea-row-meta">
                        <IdeaStatus status={entry.status} />
                        <EntryMeta entry={entry} />
                      </span>
                    ) : (
                      <EntryMeta entry={entry} />
                    )}
                  </span>
                  <span className="topic-chevron" aria-hidden="true">
                    <Icon name="chevron-right" size={18} />
                  </span>
                </button>
              ))}
              {entries.length === 0 && emptyList}
              {more && (
                <button className="load-more" type="button" disabled={loadingMore} onClick={onLoadMore}>
                  {loadingMore ? t("entry.loading") : t(`entry.loadMore.${noun}`)}
                </button>
              )}
            </section>
          </ScrollArea.Viewport>
        </ScrollArea.Root>
      </section>
      {official ? (
        <span className="ideas-gap" aria-hidden="true" />
      ) : (
        <Splitter value={split} onChange={setSplit} workspace={workspace} />
      )}
      <ScrollArea.Root className="detail-scroll-root">
        <ScrollArea.Viewport asChild tabIndex={0} style={{ overflowY: "auto" }}>
          <section className="detail" id="detail" aria-label={t(`entry.selected.${noun}`)}>
            {detail}
          </section>
        </ScrollArea.Viewport>
      </ScrollArea.Root>
    </main>
  );
}
