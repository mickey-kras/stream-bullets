import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { ScrollArea } from "radix-ui";
import { Link, useLoaderData, useRevalidator, useSearchParams, type LoaderFunctionArgs } from "react-router";
import { appContext } from "../env";
import { configuredProviders } from "../server/auth.server";
import { requestViewer } from "../lib/shell.server";
import { getEntry, getStreamer, listEntries } from "../server/data.server";
import { isAdmin } from "../server/access.server";
import { Avatar, EmptyState } from "../components/common";
import { useRememberContentRoute } from "../components/shell/back-link";
import { StreamerHeader, streamerViews, type StreamerView } from "../components/shell/streamer-header";
import { Icon, type IconName } from "../components/ui/icon";
import { t } from "../i18n";
import { errorMessage, postJson, requestJson } from "../components/api";
import { CreateEntry } from "../components/create-entry";
import { DeleteButton, Discussion } from "../components/discussion";
import { useLivePolls, useLiveRevalidation, useServerTime } from "../components/live";
import { PollCard } from "../components/poll";
import { ReportButton } from "../components/report";
import type { BoardSnapshot, Entry, LiveSnapshot, SortOrder } from "../types";

type View = StreamerView;
const liveLabels: Record<string, string> = {
  live: "Live updates connected",
  connecting: "Connecting to live updates…",
  reconnecting: "Connection lost. Reconnecting…",
  offline: "Live updates are offline.",
};
const views: readonly View[] = streamerViews;

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const app = context.get(appContext);
  if (!params.handle?.startsWith("@")) throw new Response("Page not found.", { status: 404 });
  const streamer = await getStreamer(app.env, params.handle.slice(1));
  if (!streamer) throw new Response("Streamer not found.", { status: 404 });
  const viewer = await requestViewer(request, app);
  const url: URL = new URL(request.url);
  const requestedView: string = url.searchParams.get("view") || "topics";
  let view: View = views.includes(requestedView as View) ? (requestedView as View) : "topics";
  const entryId: string | null = url.searchParams.get("entry");
  const selected: Entry | null = entryId ? await getEntry(app.env, entryId, viewer?.id || null) : null;
  if (entryId && selected?.streamerId !== streamer.id) throw new Response("Conversation not found.", { status: 404 });
  if (selected) view = selected.kind === "topic" ? "topics" : "polls";
  const requestedSort: string | null = url.searchParams.get("sort");
  let sort: SortOrder = view === "polls" ? "newest" : "top";
  if (requestedSort === "newest" || requestedSort === "top") sort = requestedSort;
  const query: string = url.searchParams.get("query") || "";
  const board: BoardSnapshot = await listEntries(app.env, streamer, viewer?.id || null, {
    kind: view === "polls" ? "polls" : "topics",
    sort,
    query,
    cursor: null,
  });
  return {
    board,
    selected,
    viewer,
    moderator: viewer ? await isAdmin(app.env, viewer.id) : false,
    providers: configuredProviders(app.env),
    view,
    sort,
    query,
  };
}

const categoryIcon: Record<string, IconName> = {
  "Tech & setups": "cat-tech",
  Gaming: "cat-gaming",
  Creative: "cat-creative",
  "Just chatting": "cat-chatting",
};

function TopicIcon({ category }: Readonly<{ category: string }>): ReactNode {
  return <Icon name={categoryIcon[category] ?? "cat-tech"} size={24} />;
}

function mergeLiveEntry(entry: Entry | null, snapshot: LiveSnapshot | null, revision: number): Entry | null {
  if (!entry || !snapshot || snapshot.revision < revision) return entry;
  const update = snapshot.polls.find((poll) => poll.id === entry.id);
  return update ? { ...entry, ...update } : entry;
}

export default function StreamerPage(): ReactNode {
  const { board, selected: loadedSelected, viewer, moderator, view, sort, query } = useLoaderData<typeof loader>();
  const { streamer } = board;
  useRememberContentRoute(`/@${streamer.handle}`, streamer.name);
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const [dialog, setDialog] = useState<"topic" | "poll" | null>(null);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [extra, setExtra] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(board.nextCursor);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [split, setSplit] = useState<number>(40);
  const generation = useRef<number>(0);
  const workspace = useRef<HTMLElement>(null);
  const pointerId = useRef<number | null>(null);
  const live = useLivePolls(streamer.handle, view === "polls");
  useLiveRevalidation(live.status, live.snapshot?.revision, revalidator.revalidate, view === "polls");
  const now: number = useServerTime(live.snapshot?.serverNow || board.serverNow);
  const owner: boolean = viewer?.id === streamer.ownerId;
  const boardIds: Set<string> = new Set(board.entries.map((entry: Entry) => entry.id));
  const entries: Entry[] = [
    ...new Map(
      [...board.entries, ...extra.filter((entry: Entry) => !boardIds.has(entry.id))].map((entry: Entry) => [
        entry.id,
        entry,
      ]),
    ).values(),
  ].map((cached: Entry) => {
    const entry: Entry = loadedSelected?.id === cached.id ? loadedSelected : cached;
    return mergeLiveEntry(entry, live.snapshot, board.revision) as Entry;
  });
  const selectedBase: Entry | null = loadedSelected || entries[0] || null;
  const selected: Entry | null = mergeLiveEntry(selectedBase, live.snapshot, board.revision);

  const boardKey: string = JSON.stringify([streamer.id, view, sort, query, board.nextCursor, board.revision]);
  const [previousBoard, setPreviousBoard] = useState<string>(boardKey);
  if (previousBoard !== boardKey) {
    setPreviousBoard(boardKey);
    setExtra([]);
    setCursor(board.nextCursor);
    setLoadingMore(false);
    setError("");
  }
  useEffect(() => {
    generation.current += 1;
  }, [boardKey]);

  function navigate(next: View, entryId?: string): void {
    const params = new URLSearchParams();
    params.set("view", next);
    if (entryId) params.set("entry", entryId);
    if (next === view) {
      params.set("sort", sort);
      if (query) params.set("query", query);
    }
    setSearchParams(params);
  }

  async function mutate(body: unknown): Promise<{ id: string }> {
    setPending(true);
    setError("");
    try {
      const result = await postJson<{ id: string }>(`/api/streamers/${encodeURIComponent(streamer.handle)}`, body);
      await revalidator.revalidate();
      return result;
    } finally {
      setPending(false);
    }
  }

  function act(body: unknown): void {
    mutate(body).catch((error_: unknown) => setError(errorMessage(error_)));
  }

  async function loadMore(): Promise<void> {
    if (!cursor || loadingMore) return;
    const revision: number = generation.current;
    setLoadingMore(true);
    setError("");
    const params = new URLSearchParams({
      kind: view === "polls" ? "polls" : "topics",
      sort,
      query,
      cursor,
    });
    try {
      const result = await requestJson<BoardSnapshot>(
        `/api/streamers/${encodeURIComponent(streamer.handle)}?${params}`,
      );
      if (revision !== generation.current) return;
      setExtra((previous: Entry[]) => [...previous, ...result.entries]);
      setCursor(result.nextCursor);
    } catch (error_: unknown) {
      if (revision === generation.current) setError(errorMessage(error_));
    } finally {
      if (revision === generation.current) setLoadingMore(false);
    }
  }

  function setSort(next: SortOrder): void {
    const params = new URLSearchParams(searchParams);
    params.set("sort", next);
    params.delete("entry");
    setSearchParams(params);
  }

  function search(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const params = new URLSearchParams(searchParams);
    const value: FormDataEntryValue | null = form.get("query");
    params.set("query", typeof value === "string" ? value.trim() : "");
    params.delete("entry");
    setSearchParams(params);
  }

  function changed(): Promise<void> {
    return revalidator.revalidate();
  }

  async function removeSelected(): Promise<void> {
    if (!selected) return;
    await postJson<unknown>(`/api/streamers/${encodeURIComponent(streamer.handle)}`, {
      action: "delete",
      id: selected.id,
    });
    generation.current += 1;
    setExtra([]);
    navigate(view);
  }

  const overlayQuery: string = loadedSelected ? `?poll=${loadedSelected.id}` : "";
  const overlayUrl: string = `/@${streamer.handle}/overlay${overlayQuery}`;

  function renderTopics(): ReactNode {
    return (
      <main
        ref={workspace}
        id="main-content"
        className={`topic-workspace ${searchParams.has("entry") ? "has-selection" : ""}`}
        style={{ "--split": `${split}%` } as CSSProperties}
      >
        <section className="browse" aria-label="Browse topics">
          <div className="intro">
            <h1>Pick the next conversation</h1>
            <p>{streamer.name} · Suggest topics. Vote. Chat.</p>
          </div>
          <form className="search" onSubmit={search}>
            <label className="sr-only" htmlFor="topic-search">
              Search topics
            </label>
            <input
              key={query}
              id="topic-search"
              name="query"
              type="search"
              maxLength={100}
              defaultValue={query}
              placeholder="Search topics…"
            />
            <button type="submit" className="search-button" aria-label="Search topics">
              <Icon name="search" size={18} />
              <span className="search-text">Search</span>
            </button>
          </form>
          <div className="list-toolbar">
            <div className="tabs" aria-label="Topic sorting">
              <button
                type="button"
                className={sort === "top" ? "active" : ""}
                aria-pressed={sort === "top"}
                onClick={() => setSort("top")}
              >
                Top
              </button>
              <button
                type="button"
                className={sort === "newest" ? "active" : ""}
                aria-pressed={sort === "newest"}
                onClick={() => setSort("newest")}
              >
                New
              </button>
            </div>
            <span className="list-count">
              {entries.length} topics{cursor ? "+" : ""}
            </span>
          </div>
          <ScrollArea.Root className="topic-scroll-root">
            <ScrollArea.Viewport asChild tabIndex={0} style={{ overflowY: "auto" }}>
              <section id="topics" aria-label="Scrollable topic list">
                {entries.map((entry: Entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    className={`topic ${selected?.id === entry.id ? "selected" : ""}`}
                    aria-pressed={selected?.id === entry.id}
                    onClick={() => navigate("topics", entry.id)}
                  >
                    <span className="topic-icon">
                      <TopicIcon category={entry.category} />
                    </span>
                    <span className="topic-main">
                      <span className="topic-title">{entry.title}</span>
                      <span className="topic-meta">
                        <span className="sr-only">
                          {`${entry.likes} ${entry.likes === 1 ? "like" : "likes"}, ${entry.dislikes} ${entry.dislikes === 1 ? "dislike" : "dislikes"}, ${entry.comments} ${entry.comments === 1 ? "comment" : "comments"}`}
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
                    </span>
                    <span className="topic-chevron" aria-hidden="true">
                      <Icon name="chevron-right" size={18} />
                    </span>
                  </button>
                ))}
                {entries.length === 0 && (
                  <p className="empty">
                    {query ? "No topics match your search." : "No topics yet. Bring the first idea."}
                  </p>
                )}
                {cursor && (
                  <button
                    className="load-more"
                    type="button"
                    disabled={loadingMore}
                    onClick={() => {
                      loadMore();
                    }}
                  >
                    {loadingMore ? "Loading…" : "Load more topics"}
                  </button>
                )}
              </section>
            </ScrollArea.Viewport>
          </ScrollArea.Root>
        </section>
        <input
          type="range"
          min={25}
          max={65}
          step="any"
          value={split}
          onChange={(event) => setSplit(Number(event.currentTarget.value))}
          id="splitter"
          aria-label="Resize topic panels"
          aria-controls="topics detail"
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              setSplit((value: number) => Math.max(25, Math.min(65, value + (event.key === "ArrowRight" ? 2 : -2))));
            }
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.focus();
            pointerId.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (pointerId.current !== event.pointerId || !workspace.current) return;
            const bounds: DOMRect = workspace.current.getBoundingClientRect();
            setSplit(Math.max(25, Math.min(65, ((event.clientX - bounds.left) / bounds.width) * 100)));
          }}
          onPointerUp={() => {
            pointerId.current = null;
          }}
          onPointerCancel={() => {
            pointerId.current = null;
          }}
          onDoubleClick={() => setSplit(40)}
        />
        <ScrollArea.Root className="detail-scroll-root">
          <ScrollArea.Viewport asChild tabIndex={0} style={{ overflowY: "auto" }}>
            <section className="detail" id="detail" aria-label="Selected topic">
              {renderTopicDetail()}
            </section>
          </ScrollArea.Viewport>
        </ScrollArea.Root>
      </main>
    );
  }

  /** Delete for the author, the streamer, and administrators; report for everyone else who is signed in. */
  function renderEntryActions(entry: Entry): ReactNode {
    if (!viewer) return null;
    const noun: string = entry.kind === "topic" ? "topic" : "poll";
    const author: boolean = entry.authorId === viewer.id;
    return (
      <div className="content-actions">
        {(owner || moderator || author) && (
          <DeleteButton label={`Delete ${noun}`} onDelete={removeSelected} disabled={pending} />
        )}
        {!author && (
          <ReportButton
            targetKind="entry"
            targetId={entry.id}
            label={`Report ${noun}`}
            description={`Tell us what is wrong with the ${noun} “${entry.title}”.`}
          />
        )}
      </div>
    );
  }

  function renderDiscussion(entry: Entry): ReactNode {
    return (
      <Discussion
        key={entry.id}
        entryId={entry.id}
        handle={streamer.handle}
        viewer={viewer}
        ownerId={streamer.ownerId}
        moderator={moderator}
        refreshKey={board.revision}
        onChanged={changed}
      />
    );
  }

  function renderTopicDetail(): ReactNode {
    return (
      <>
        {selected ? (
          <>
            <div className="topic-content">
              <button type="button" className="back" onClick={() => navigate("topics")}>
                <Icon name="chevron-left" size={16} />
                All topics
              </button>
              <div className="detail-top">
                <span className="category">
                  <TopicIcon category={selected.category} />
                  {selected.category}
                </span>
                <Link className="text-link" to={`?view=topics&entry=${selected.id}`}>
                  <Icon name="link" size={16} />
                  Topic link
                </Link>
              </div>
              <h2>{selected.title}</h2>
              <div className="author">
                <Avatar name={selected.author} url={selected.avatar} />
                Posted by <strong>{selected.author}</strong>
              </div>
              <p className="description">{selected.body}</p>
              <div className="votes">
                <button
                  type="button"
                  disabled={!viewer || pending}
                  aria-pressed={selected.reaction === 1}
                  onClick={() =>
                    act({
                      action: "react",
                      id: selected.id,
                      value: selected.reaction === 1 ? 0 : 1,
                    })
                  }
                >
                  <Icon name={selected.reaction === 1 ? "thumbs-up-filled" : "thumbs-up"} size={24} />
                  <span className="vote-word">Like</span> <b>{selected.likes}</b>
                </button>
                <button
                  type="button"
                  disabled={!viewer || pending}
                  aria-pressed={selected.reaction === -1}
                  onClick={() =>
                    act({
                      action: "react",
                      id: selected.id,
                      value: selected.reaction === -1 ? 0 : -1,
                    })
                  }
                >
                  <Icon name={selected.reaction === -1 ? "thumbs-down-filled" : "thumbs-down"} size={24} />
                  <span className="vote-word">Dislike</span> <b>{selected.dislikes}</b>
                </button>
              </div>
              {!viewer && <p className="muted">Sign in to vote or suggest a topic.</p>}
              {renderEntryActions(selected)}
            </div>
            {renderDiscussion(selected)}
          </>
        ) : (
          <EmptyState title="Start a conversation.">Suggest a topic for {streamer.name}&apos;s next stream.</EmptyState>
        )}
      </>
    );
  }

  function renderPolls(): ReactNode {
    return (
      <>
        <div className="page-title">
          <div>
            <span className="eyebrow">YOUR VOICE, ON AIR</span>
            <h1>Live polls</h1>
            <p>One question. Everyone has a say.</p>
          </div>
          {owner && (
            <button className="gold" type="button" onClick={() => setDialog("poll")}>
              <Icon name="plus" size={18} />
              Create poll
            </button>
          )}
        </div>
        <div className="connection-status">
          <output>{liveLabels[live.status]}</output>
          {live.status === "offline" && (
            <button type="button" onClick={live.reconnect}>
              Reconnect
            </button>
          )}
          <button
            type="button"
            disabled={revalidator.state !== "idle"}
            onClick={() => {
              revalidator.revalidate();
            }}
          >
            Refresh polls
          </button>
        </div>
        <div className="poll-toolbar">
          <div className="tabs" aria-label="Poll sorting">
            <button
              type="button"
              aria-pressed={sort === "newest"}
              className={sort === "newest" ? "active" : ""}
              onClick={() => setSort("newest")}
            >
              Newest
            </button>
            <button
              type="button"
              aria-pressed={sort === "top"}
              className={sort === "top" ? "active" : ""}
              onClick={() => setSort("top")}
            >
              Top
            </button>
          </div>
          {loadedSelected && (
            <button type="button" onClick={() => navigate("polls")}>
              <Icon name="chevron-left" size={16} />
              All polls
            </button>
          )}
          {owner && (
            <Link className="text-link" to={overlayUrl}>
              OBS overlay
            </Link>
          )}
        </div>
        {live.snapshot?.polls.some((poll) => !entries.some((entry: Entry) => entry.id === poll.id)) && (
          <output>
            More polls are available.{" "}
            <button
              type="button"
              onClick={() => {
                revalidator.revalidate();
              }}
            >
              Load latest polls
            </button>
          </output>
        )}
        {(loadedSelected && selected ? [selected] : entries).map((entry: Entry) => (
          <PollCard
            key={entry.id}
            entry={entry}
            now={now}
            signedIn={Boolean(viewer)}
            owner={owner}
            pending={pending}
            onAction={act}
            onDiscuss={() => navigate("polls", entry.id)}
          />
        ))}
        {entries.length === 0 && !loadedSelected && (
          <EmptyState title="The mic is yours.">No polls yet. The next question starts here.</EmptyState>
        )}
        {cursor && !loadedSelected && (
          <button
            type="button"
            className="load-more"
            disabled={loadingMore}
            onClick={() => {
              loadMore();
            }}
          >
            {loadingMore ? "Loading…" : "Load more polls"}
          </button>
        )}
        {renderPollDiscussion()}
      </>
    );
  }

  function renderPollDiscussion(): ReactNode {
    return (
      <>
        {loadedSelected && selected && (
          <div className="poll-card poll-discussion">
            <h2>{selected.title}</h2>
            {renderEntryActions(selected)}
            {renderDiscussion(selected)}
          </div>
        )}
      </>
    );
  }

  function renderAbout(): ReactNode {
    return (
      <>
        <span className="eyebrow">BEHIND THE MIC</span>
        <h1>{streamer.name}</h1>
        <section className="info-card">
          <Avatar name={streamer.name} url={streamer.avatar} />
          <p className="description">{streamer.about || "This streamer has not added an introduction yet."}</p>
        </section>
      </>
    );
  }

  function renderSchedule(): ReactNode {
    return (
      <>
        <span className="eyebrow">WHAT&apos;S NEXT</span>
        <h1>Stream schedule</h1>
        <EmptyState title="Next stream to be announced.">In the meantime, help choose what we talk about.</EmptyState>
        <button className="gold" type="button" onClick={() => navigate("topics")}>
          Explore topics
        </button>
      </>
    );
  }

  function renderCommunity(): ReactNode {
    return (
      <>
        <span className="eyebrow">PART OF THE CONVERSATION</span>
        <h1>{streamer.name}&apos;s community</h1>
        <div className="community-grid">
          <section className="info-card">
            <h2>Bring an idea</h2>
            <p>Suggest a topic, vote on your favorites, and discuss it with everyone.</p>
            <button className="gold" type="button" onClick={() => navigate("topics")}>
              Browse topics
            </button>
          </section>
          <section className="info-card">
            <h2>Have your say live</h2>
            <p>Vote in live polls. Keep the conversation respectful and on topic.</p>
            <button className="gold" type="button" onClick={() => navigate("polls")}>
              Open polls
            </button>
          </section>
        </div>
      </>
    );
  }

  function renderPage(): ReactNode {
    if (view === "topics") return renderTopics();
    let content: ReactNode = renderCommunity();
    if (view === "polls") content = renderPolls();
    if (view === "about") content = renderAbout();
    if (view === "schedule") content = renderSchedule();
    return (
      <main className="page-panel" id="main-content">
        <div className="page-column">{content}</div>
      </main>
    );
  }
  return (
    <div
      className="streamer-shell"
      style={
        streamer.background
          ? {
              backgroundImage: `linear-gradient(#0a2025e8,#0a2025e8),url("${streamer.background}")`,
            }
          : undefined
      }
    >
      <StreamerHeader
        streamer={streamer}
        current={view}
        action={
          viewer && (
            <button
              className="gold"
              id="suggest"
              type="button"
              aria-label={t("streamer.suggest")}
              onClick={() => setDialog("topic")}
            >
              <span className="suggest-plus" aria-hidden="true">
                <Icon name="plus" size={18} />
              </span>
              <span className="suggest-label">{t("streamer.suggest")}</span>
            </button>
          )
        }
      />
      {error && (
        <p className="page-error form-error" role="alert">
          {error}
        </p>
      )}
      {renderPage()}
      {viewer && view === "topics" && (
        <button type="button" className="fab gold" onClick={() => setDialog("topic")}>
          <Icon name="plus" size={20} />
          {t("streamer.suggest")}
        </button>
      )}
      <CreateEntry
        key={dialog || "closed"}
        mode={dialog || "topic"}
        open={dialog !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setDialog(null);
        }}
        onCreate={async (body: unknown) => {
          const result = await mutate(body);
          navigate(dialog === "poll" ? "polls" : "topics", result.id);
        }}
      />
    </div>
  );
}
