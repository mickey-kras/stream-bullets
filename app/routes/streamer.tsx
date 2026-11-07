import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Link,
  useLoaderData,
  useLocation,
  useRevalidator,
  useSearchParams,
  type LoaderFunctionArgs,
} from "react-router";
import { ENTRY_STATUSES } from "../../db/enums";
import { appContext } from "../env";
import { configuredProviders } from "../server/auth.server";
import { requestViewer } from "../lib/shell.server";
import { getEntry, getVisibleStreamer, listEntries } from "../server/data.server";
import { isAdmin } from "../server/access.server";
import { listCards } from "../server/community.server";
import { defaultRange, listEvents, listTopicChoices } from "../server/schedule.server";
import { getSupport } from "../server/support.server";
import { EmptyState } from "../components/common";
import { SignInDialog } from "../components/shell/sign-in-dialog";
import { StreamerLogo } from "../components/ui/avatar";
import { readIntent } from "../lib/directory";
import { useShell } from "../lib/shell";
import { CommunityView } from "../components/community/community-view";
import { IdeaDialog } from "../components/ideas/idea-dialog";
import { ScheduleView, scheduleModes, type ScheduleMode } from "../components/schedule/schedule-view";
import { useRememberContentRoute } from "../components/shell/back-link";
import { StreamerHeader, streamerViews, type StreamerView } from "../components/shell/streamer-header";
import { EntryActions, EntryDetail } from "../components/streamer/entry-detail";
import { PageBanner } from "../components/streamer/page-banner";
import { TopicBoard } from "../components/streamer/topic-board";
import { SupportSection } from "../components/support/support";
import { dialogHref, type DialogState } from "../components/account/dialog-route";
import { Icon } from "../components/ui/icon";
import { useToast } from "../components/ui/toast";
import { t } from "../i18n";
import { errorMessage, postJson, requestJson } from "../components/api";
import { CreateEntry } from "../components/create-entry";
import { Discussion } from "../components/discussion";
import { useLivePolls, useLiveRevalidation, useServerTime } from "../components/live";
import { PollCard } from "../components/poll";
import type { BoardSnapshot, Entry, EntryStatus, LiveSnapshot, SortOrder, StreamEvent } from "../types";

type View = StreamerView;
type Dialog = "topic" | "poll" | "idea" | "event" | "card" | null;
const liveLabels: Record<string, string> = {
  live: "Live updates connected",
  connecting: "Connecting to live updates…",
  reconnecting: "Connection lost. Reconnecting…",
  offline: "Live updates are offline.",
};
/** The official StreamBullets page is the Ideas board: Ideas, About and Community. */
const officialViews: readonly View[] = ["topics", "about", "community"];

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const app = context.get(appContext);
  if (!params.handle?.startsWith("@")) throw new Response("Page not found.", { status: 404 });
  const viewer = await requestViewer(request, app);
  // Suspended pages are 404 for everyone but the owner and admins.
  const streamer = await getVisibleStreamer(app.env, params.handle.slice(1), viewer?.id ?? null);
  if (!streamer) throw new Response("Streamer not found.", { status: 404 });
  const official = streamer.isOfficial;
  const url: URL = new URL(request.url);
  const allowed = official ? officialViews : streamerViews;
  const requestedView: string = url.searchParams.get("view") || "topics";
  let view: View = allowed.includes(requestedView as View) ? (requestedView as View) : "topics";
  const entryId: string | null = url.searchParams.get("entry");
  const selected: Entry | null = entryId ? await getEntry(app.env, entryId, viewer?.id || null) : null;
  if (entryId && selected?.streamerId !== streamer.id) throw new Response("Conversation not found.", { status: 404 });
  if (selected) view = selected.kind === "topic" ? "topics" : "polls";
  const requestedSort: string | null = url.searchParams.get("sort");
  let sort: SortOrder = view === "polls" ? "newest" : "top";
  if (requestedSort === "newest" || requestedSort === "top") sort = requestedSort;
  const query: string = url.searchParams.get("query") || "";
  const requestedStatus = url.searchParams.get("status");
  const status: EntryStatus | null =
    official && ENTRY_STATUSES.includes(requestedStatus as EntryStatus) ? (requestedStatus as EntryStatus) : null;
  const board: BoardSnapshot = await listEntries(app.env, streamer, viewer?.id || null, {
    kind: view === "polls" ? "polls" : "topics",
    sort,
    query,
    cursor: null,
    status,
  });
  const owner = viewer?.id === streamer.ownerId;
  const now = Date.now();
  const range = defaultRange(now);
  const requestedMode = url.searchParams.get("mode") as ScheduleMode | null;
  return {
    board,
    selected,
    viewer,
    moderator: viewer ? await isAdmin(app.env, viewer.id) : false,
    providers: configuredProviders(app.env),
    view,
    sort,
    query,
    status,
    events: official ? [] : await listEvents(app.env, streamer.id, range.from, range.to, now),
    serverNow: now,
    mode: requestedMode && scheduleModes.includes(requestedMode) ? requestedMode : "feed",
    openEvent: url.searchParams.get("event"),
    cards: view === "community" && !official ? await listCards(app.env, streamer.id) : null,
    support: await getSupport(app.env, streamer.id),
    topicChoices: owner && view === "schedule" ? await listTopicChoices(app.env, streamer.id) : [],
    intent: readIntent(url.searchParams.get("intent")),
  };
}

function mergeLiveEntry(entry: Entry | null, snapshot: LiveSnapshot | null, revision: number): Entry | null {
  if (!entry || !snapshot || snapshot.revision < revision) return entry;
  const update = snapshot.polls.find((poll) => poll.id === entry.id);
  return update ? { ...entry, ...update } : entry;
}

/** One primary action per tab (round 16): Topics suggests; the owner's Polls, Schedule and Community add. */
function headerAction(view: View, owner: boolean, official: boolean): { dialog: Dialog; label: string } | null {
  if (official) return view === "topics" ? { dialog: "idea", label: t("ideas.suggest") } : null;
  if (view === "topics") return { dialog: "topic", label: t("streamer.suggest") };
  if (!owner) return null;
  if (view === "polls") return { dialog: "poll", label: t("streamer.newPoll") };
  if (view === "schedule") return { dialog: "event", label: t("schedule.create") };
  if (view === "community") return { dialog: "card", label: t("community.addCard") };
  return null;
}

export default function StreamerPage(): ReactNode {
  const data = useLoaderData<typeof loader>();
  const { board, selected: loadedSelected, viewer, moderator, view, sort, query, status, events, support } = data;
  const { streamer } = board;
  useRememberContentRoute(`/@${streamer.handle}`, streamer.name);
  const [searchParams, setSearchParams] = useSearchParams();
  const here = useLocation();
  const revalidator = useRevalidator();
  const toast = useToast();
  // A directory card, the footer or the account menu can ask for an action (`?intent=`): suggest opens Suggest a
  // topic (Suggest an improvement on the official page), or sign-in when signed out.
  const intentDialog = (): Dialog => {
    if (data.intent !== "suggest" || !viewer || streamer.status !== "active") return null;
    return streamer.isOfficial ? "idea" : "topic";
  };
  const [dialog, setDialog] = useState<Dialog>(intentDialog);
  const [signIn, setSignIn] = useState<boolean>(data.intent === "suggest" && !viewer);
  // The intent can also arrive by in-app navigation to this same page, which keeps the component mounted.
  const [intentSeen, setIntentSeen] = useState<string | null>(data.intent);
  if (intentSeen !== data.intent) {
    setIntentSeen(data.intent);
    if (data.intent === "suggest") {
      setDialog(intentDialog());
      setSignIn(!viewer);
    }
  }
  const { providers } = useShell();
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [extra, setExtra] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(board.nextCursor);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const generation = useRef<number>(0);
  const official = streamer.isOfficial;
  const live = useLivePolls(streamer.handle, view === "polls");
  useLiveRevalidation(live.status, live.snapshot?.revision, revalidator.revalidate, view === "polls");
  const now: number = useServerTime(live.snapshot?.serverNow || board.serverNow);
  const owner: boolean = viewer?.id === streamer.ownerId;
  const writable: boolean = streamer.status === "active";
  const liveEvent: StreamEvent | null =
    streamer.status === "suspended" ? null : (events.find((event: StreamEvent) => event.status === "live") ?? null);
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

  const boardKey: string = JSON.stringify([streamer.id, view, sort, query, status, board.nextCursor, board.revision]);
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
      if (status) params.set("status", status);
    }
    setSearchParams(params);
  }

  function setParam(name: string, value: string | null): void {
    const params = new URLSearchParams(searchParams);
    if (value === null) params.delete(name);
    else params.set(name, value);
    setSearchParams(params, { replace: name === "event" });
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
    const params = new URLSearchParams({ kind: view === "polls" ? "polls" : "topics", sort, query, cursor });
    if (status) params.set("status", status);
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

  function changeBoard(name: "sort" | "query", value: string): void {
    const params = new URLSearchParams(searchParams);
    params.set(name, value);
    params.delete("entry");
    setSearchParams(params);
  }

  async function changed(): Promise<void> {
    await revalidator.revalidate();
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

  function renderDiscussion(entry: Entry): ReactNode {
    return (
      <Discussion
        key={entry.id}
        entryId={entry.id}
        handle={streamer.handle}
        viewer={viewer}
        ownerId={streamer.ownerId}
        moderator={moderator}
        status={streamer.status}
        refreshKey={board.revision}
        onChanged={() => void changed()}
      />
    );
  }

  function copyPageLink(): void {
    const url = `${location.origin}/@${streamer.handle}`;
    void navigator.clipboard
      ?.writeText(url)
      .then(() => toast(t("entry.linkCopied")))
      .catch(() => toast(url));
  }

  /** The empty Topics state: the owner shares the page; viewers suggest the first topic. */
  function renderEmptyTopics(): ReactNode {
    if (official)
      return (
        <EmptyState title={t("ideas.emptyTitle")} icon="idea">
          {t("ideas.emptyBody")}
        </EmptyState>
      );
    if (owner)
      return (
        <EmptyState
          title={t("entry.ownerEmptyTitle")}
          icon="link"
          action={
            <button type="button" className="gold" onClick={copyPageLink}>
              <Icon name="copy" size={18} />
              {t("entry.copyPageLink")}
            </button>
          }
        >
          {t("entry.ownerEmptyBody")}
        </EmptyState>
      );
    return (
      <EmptyState
        title={t("entry.emptyTitle")}
        icon="idea"
        action={
          viewer &&
          writable && (
            <button type="button" className="gold" onClick={() => setDialog("topic")}>
              <Icon name="plus" size={18} />
              {t("entry.suggestFirst")}
            </button>
          )
        }
      >
        {t("entry.emptyBody", { name: streamer.name })}
      </EmptyState>
    );
  }

  function renderEmptyList(): ReactNode {
    if (query)
      return (
        <p className="empty">
          <Icon name="search-none" size={20} />
          {t("entry.noMatch")}
        </p>
      );
    return (
      <>
        <p className="empty desk-empty">{t(official ? "ideas.noneYet" : "entry.noneYet")}</p>
        <div className={`list-empty${owner ? " owner-empty" : ""}`}>{renderEmptyTopics()}</div>
      </>
    );
  }

  function renderTopics(): ReactNode {
    return (
      <TopicBoard
        name={streamer.name}
        entries={entries}
        selected={selected}
        hasSelection={searchParams.has("entry") || (data.intent === "discuss" && selected !== null)}
        official={official}
        status={status}
        sort={sort}
        query={query}
        more={Boolean(cursor)}
        loadingMore={loadingMore}
        live={liveEvent}
        emptyList={renderEmptyList()}
        detail={
          selected ? (
            <>
              <EntryDetail
                entry={selected}
                viewer={viewer}
                owner={owner}
                moderator={moderator}
                writable={writable}
                pending={pending}
                onBack={() => navigate("topics")}
                onReact={(value) => act({ action: "react", id: selected.id, value })}
                onDelete={removeSelected}
              />
              {renderDiscussion(selected)}
            </>
          ) : (
            renderEmptyTopics()
          )
        }
        onSelect={(id: string) => navigate("topics", id)}
        onSort={(next: SortOrder) => changeBoard("sort", next)}
        onSearch={(next: string) => changeBoard("query", next)}
        onLoadMore={() => void loadMore()}
      />
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
          {owner && writable && (
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
            {(["newest", "top"] as const).map((value: SortOrder) => (
              <button
                key={value}
                type="button"
                aria-pressed={sort === value}
                className={sort === value ? "active" : ""}
                onClick={() => changeBoard("sort", value)}
              >
                {value === "newest" ? "Newest" : "Top"}
              </button>
            ))}
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
            signedIn={Boolean(viewer) && writable}
            owner={owner && writable}
            pending={pending}
            onAction={act}
            onDiscuss={() => navigate("polls", entry.id)}
          />
        ))}
        {entries.length === 0 && !loadedSelected && (
          <EmptyState title="The mic is yours.">No polls yet. The next question starts here.</EmptyState>
        )}
        {cursor && !loadedSelected && (
          <button type="button" className="load-more" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading…" : "Load more polls"}
          </button>
        )}
        {loadedSelected && selected && (
          <div className="poll-card poll-discussion">
            <h2>{selected.title}</h2>
            <EntryActions
              entry={selected}
              viewer={viewer}
              owner={owner}
              moderator={moderator}
              pending={pending}
              onDelete={removeSelected}
            />
            {renderDiscussion(selected)}
          </div>
        )}
      </>
    );
  }

  function renderAbout(): ReactNode {
    if (official)
      return (
        <>
          <span className="eyebrow">{t("ideas.aboutEyebrow")}</span>
          <h1>{streamer.name}</h1>
          <section className="info-card">
            <p className="description">{streamer.about || t("ideas.aboutBody")}</p>
          </section>
        </>
      );
    return (
      <>
        <span className="eyebrow">{t("about.eyebrow")}</span>
        <h1>{streamer.name}</h1>
        <section className="info-card about-card">
          <div className="about-id">
            <StreamerLogo className="avatar-48" streamer={streamer} />
            <div>
              <strong>{streamer.name}</strong>
              <span className="muted">@{streamer.handle}</span>
            </div>
          </div>
          <p className="description">{streamer.about || t("about.empty")}</p>
        </section>
        <SupportSection name={streamer.name} support={support} />
        {owner && writable && (
          <p>
            <Link
              className="button-link small-button"
              to={dialogHref(here, "page")}
              aria-haspopup="dialog"
              state={{ dialogFrom: here.pathname } satisfies DialogState}
              preventScrollReset
            >
              <Icon name="heart" size={16} />
              {t("support.edit")}
            </Link>
          </p>
        )}
      </>
    );
  }

  function renderOfficialCommunity(): ReactNode {
    return (
      <>
        <span className="eyebrow">{t("ideas.howEyebrow")}</span>
        <h1>{t("ideas.howTitle")}</h1>
        <div className="community-grid">
          <section className="info-card community-card">
            <h2>
              <span className="card-icon">
                <Icon name="polls" size={18} />
              </span>
              {t("ideas.prioritizeTitle")}
            </h2>
            <p>{t("ideas.prioritizeBody")}</p>
          </section>
          <section className="info-card community-card">
            <h2>
              <span className="card-icon">
                <Icon name="warning" size={18} />
              </span>
              {t("ideas.bugsTitle")}
            </h2>
            <p>{t("ideas.bugsBody")}</p>
          </section>
        </div>
      </>
    );
  }

  function renderPage(): ReactNode {
    if (view === "topics") return renderTopics();
    let content: ReactNode = null;
    if (view === "polls") content = renderPolls();
    if (view === "about") content = renderAbout();
    if (view === "schedule")
      content = (
        <ScheduleView
          handle={streamer.handle}
          name={streamer.name}
          events={events}
          serverNow={data.serverNow}
          owner={owner && writable}
          topics={data.topicChoices}
          mode={data.mode}
          openEvent={data.openEvent}
          creating={dialog === "event"}
          onMode={(mode: ScheduleMode) => setParam("mode", mode === "feed" ? null : mode)}
          onOpenEvent={(id: string | null) => setParam("event", id)}
          onCreating={(open: boolean) => setDialog(open ? "event" : null)}
          onChanged={changed}
        />
      );
    if (view === "community")
      content = official ? (
        renderOfficialCommunity()
      ) : (
        <CommunityView
          name={streamer.name}
          cards={data.cards}
          support={support}
          owner={owner}
          writable={writable}
          adding={dialog === "card"}
          onAdding={(open: boolean) => setDialog(open ? "card" : null)}
          onChanged={changed}
        />
      );
    return (
      <main className="page-panel" id="main-content">
        <div className={`page-column${view === "schedule" ? " page-column-wide" : ""}`}>{content}</div>
      </main>
    );
  }

  const action = viewer ? headerAction(view, owner, official) : null;
  const fab =
    viewer && writable && (view === "topics" || (owner && (view === "polls" || view === "schedule")))
      ? headerAction(view, owner, official)
      : null;
  const role = owner ? "owner" : moderator ? "admin" : "viewer";
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
        className={official ? "ideas-header" : ""}
        views={official ? officialViews : streamerViews}
        labels={official ? { topics: t("ideas.tab") } : {}}
        icons={official ? { topics: "idea" } : {}}
        brand={
          official ? (
            <>
              <span className="ideas-logo" aria-hidden="true">
                <img src="/assets/stream-bullets-icon.svg" alt="" width="128" height="136" />
              </span>
              <span className="streamer-name-wrap">
                <span className="streamer-name">{streamer.name}</span>
                <span className="ideas-sub">{t("ideas.subtitle")}</span>
              </span>
            </>
          ) : undefined
        }
        badge={
          liveEvent && (
            <Link className="live-pill" to="?view=schedule">
              <span className="live-dot" aria-hidden="true" />
              LIVE
              <span className="sr-only">: {liveEvent.title}</span>
            </Link>
          )
        }
        action={
          action && (
            <button
              className={owner && !official ? "header-secondary header-action" : "gold"}
              id="suggest"
              type="button"
              aria-label={action.label}
              disabled={!writable}
              onClick={() => setDialog(action.dialog)}
            >
              <span className="suggest-plus" aria-hidden="true">
                <Icon name="plus" size={18} />
              </span>
              <span className="suggest-label">{action.label}</span>
            </button>
          )
        }
      />
      <PageBanner status={streamer.status} reason={streamer.statusReason} role={role} />
      {error && (
        <p className="page-error form-error" role="alert">
          {error}
        </p>
      )}
      {renderPage()}
      {fab && (
        <button type="button" className="fab gold" onClick={() => setDialog(fab.dialog)}>
          <Icon name="plus" size={20} />
          {fab.dialog === "idea" ? t("ideas.suggestShort") : fab.label}
        </button>
      )}
      <CreateEntry
        key={dialog === "topic" || dialog === "poll" ? dialog : "closed"}
        mode={dialog === "poll" ? "poll" : "topic"}
        open={dialog === "topic" || dialog === "poll"}
        onOpenChange={(open: boolean) => {
          if (open) return;
          setDialog(null);
          if (searchParams.has("intent")) setParam("intent", null);
        }}
        onCreate={async (body: unknown) => {
          const result = await mutate(body);
          navigate(dialog === "poll" ? "polls" : "topics", result.id);
        }}
      />
      <SignInDialog
        open={signIn}
        onOpenChange={(open: boolean) => {
          setSignIn(open);
          if (!open && searchParams.has("intent")) setParam("intent", null);
        }}
        providers={providers}
      />
      {official && (
        <IdeaDialog
          key={dialog === "idea" ? "open" : "closed"}
          open={dialog === "idea"}
          onOpenChange={(open: boolean) => {
            setDialog(open ? "idea" : null);
            if (!open && searchParams.has("intent")) setParam("intent", null);
          }}
          onCreate={async (body) => {
            const result = await mutate({ action: "create", kind: "topic", ...body });
            toast(t("ideas.thanks"));
            setSearchParams(new URLSearchParams({ view: "topics", entry: result.id }));
          }}
        />
      )}
    </div>
  );
}
