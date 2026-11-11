export { RouteErrorBoundary as ErrorBoundary } from "../components/route-error";
import { withRouteErrors } from "../server/route-errors.server";
import { useCallback, useEffect, useRef, useState, type ReactNode, type ComponentProps } from "react";
import {
  Link,
  useLoaderData,
  useLocation,
  useRevalidator,
  useSearchParams,
  type LoaderFunctionArgs,
} from "react-router";
import { ENTRY_STATUSES } from "../../db/enums";
import { appContext, type AppEnv } from "../env";
import { configuredProviders } from "../server/auth.server";
import { requestViewer } from "../lib/shell.server";
import { getEntry, getVisibleStreamer, listEntries } from "../server/data.server";
import { isAdmin } from "../server/access.server";
import { listCards } from "../server/community.server";
import { defaultRange, getEvent, listEvents, listTopicChoices } from "../server/schedule.server";
import { getSupport } from "../server/support.server";
import { EmptyState } from "../components/common";
import { contactEmails } from "../legal";
import { SignInDialog } from "../components/shell/sign-in-dialog";
import { StreamerLogo } from "../components/ui/avatar";
import { readIntent } from "../lib/directory";
import { shellFromMatches, useShell } from "../lib/shell";
import { eventsJsonLd, personJsonLd, postingJsonLd, type JsonLd } from "../lib/structured-data";
import { CommunityView } from "../components/community/community-view";
import { IdeaDialog } from "../components/ideas/idea-dialog";
import { ScheduleView, scheduleModes, type ScheduleMode } from "../components/schedule/schedule-view";
import { useRememberContentRoute } from "../components/shell/back-link";
import { StreamerHeader, streamerViews, type StreamerView } from "../components/shell/streamer-header";
import { EntryDetail } from "../components/streamer/entry-detail";
import { PageBanner } from "../components/streamer/page-banner";
import { useBoardRefresh } from "../components/streamer/use-board-refresh";
import { TopicBoard } from "../components/streamer/topic-board";
import { SupportSection } from "../components/support/support";
import { dialogHref, type DialogState } from "../components/account/dialog-route";
import { Icon } from "../components/ui/icon";
import { useToast } from "../components/ui/toast";
import { t } from "../i18n";
import { ApiError, errorMessage, postJson, requestJson } from "../components/api";
import { CreateEntry } from "../components/create-entry";
import { Discussion } from "../components/discussion";
import { useLivePolls, useLiveRevalidation } from "../components/live";
import { battleMarks, useBattleClock } from "../components/mash/use-mash";
import { useScheduleClock } from "../components/use-clock";
import { liveEventAt } from "../lib/schedule";
import { copyText } from "../lib/clipboard";
import { PollsView, usePollsMainClass } from "../components/streamer/polls-view";
import type {
  BoardSnapshot,
  Entry,
  EntryStatus,
  LiveSnapshot,
  SortOrder,
  StreamEvent,
  Streamer,
  Viewer,
} from "../types";
import type { Route } from "./+types/streamer";

type View = StreamerView;
type Dialog = "topic" | "poll" | "idea" | "event" | "card" | null;
/** The official StreamBullets page is the Ideas board: Ideas, About and Community. */
const officialViews: readonly View[] = ["topics", "about", "community"];

export function meta({ loaderData: data, matches }: Route.MetaArgs) {
  if (!data) return [{ title: "StreamBullets" }];
  const { streamer } = data.board;
  const origin: string = shellFromMatches(matches)?.origin ?? "";
  const structured: JsonLd[] = [
    personJsonLd(streamer, origin),
    ...eventsJsonLd(data.events, streamer, origin, data.serverNow),
  ];
  if (data.selected) structured.push(postingJsonLd(data.selected, streamer, origin));
  const title: string = data.selected ? `${data.selected.title} · ${streamer.name}` : streamer.name;
  return [
    { title: `${title} · StreamBullets` },
    {
      name: "description",
      content: streamer.about.slice(0, 160) || t("entry.tagline", { name: streamer.name }),
    },
    ...structured.map((item: JsonLd) => ({ "script:ld+json": item })),
  ];
}

function entryView(entry: Entry): View {
  return entry.kind === "topic" ? "topics" : "polls";
}

function boardFilters(
  params: URLSearchParams,
  view: View,
  official: boolean,
): {
  sort: SortOrder;
  query: string;
  status: EntryStatus | null;
} {
  const requestedSort: string | null = params.get("sort");
  let sort: SortOrder = view === "polls" ? "newest" : "top";
  if (requestedSort === "newest" || requestedSort === "top") sort = requestedSort;
  const requestedStatus: string | null = params.get("status");
  const status: EntryStatus | null =
    official && ENTRY_STATUSES.includes(requestedStatus as EntryStatus) ? (requestedStatus as EntryStatus) : null;
  return { sort, query: params.get("query") || "", status };
}

async function pageSchedule(
  env: AppEnv,
  streamer: Streamer,
  params: URLSearchParams,
  now: number,
): Promise<{
  events: StreamEvent[];
  linkedEvent: StreamEvent | null;
  mode: ScheduleMode;
  openEvent: string | null;
}> {
  const range = defaultRange(now);
  const requestedMode = params.get("mode") as ScheduleMode | null;
  const events: StreamEvent[] = streamer.isOfficial
    ? []
    : await listEvents(env, streamer.id, range.from, range.to, now);
  const openEvent: string | null = params.get("event");
  // Shared links can open a stream outside the loaded range, but only on its own page.
  const linkedEvent: StreamEvent | null =
    openEvent && !streamer.isOfficial && !events.some((event: StreamEvent): boolean => event.id === openEvent)
      ? await getEvent(env, openEvent, now, streamer.id)
      : null;
  return {
    events,
    linkedEvent,
    openEvent,
    mode: requestedMode && scheduleModes.includes(requestedMode) ? requestedMode : "feed",
  };
}

export const loader = withRouteErrors(async ({ request, context, params }: LoaderFunctionArgs) => {
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
  const owner = viewer?.id === streamer.ownerId;
  const now = Date.now();
  // Independent reads go out together, so the page waits for the slowest one, not their sum.
  const [selected, moderator, support, schedule] = await Promise.all([
    entryId ? getEntry(app.env, entryId, viewer?.id || null) : null,
    viewer ? isAdmin(app.env, viewer.id) : false,
    getSupport(app.env, streamer.id),
    pageSchedule(app.env, streamer, url.searchParams, now),
  ]);
  if (entryId && selected?.streamerId !== streamer.id) throw new Response("Conversation not found.", { status: 404 });
  if (selected) view = entryView(selected);
  const { sort, query, status } = boardFilters(url.searchParams, view, official);
  const [board, cards, topicChoices] = await Promise.all([
    listEntries(app.env, streamer, viewer?.id || null, {
      kind: view === "polls" ? "polls" : "topics",
      sort,
      query,
      cursor: null,
      status,
    }),
    view === "community" && !official ? listCards(app.env, streamer.id) : null,
    owner && view === "schedule" ? listTopicChoices(app.env, streamer.id) : [],
  ]);
  return {
    board,
    selected,
    viewer,
    moderator,
    providers: configuredProviders(app.env),
    view,
    sort,
    query,
    status,
    ...schedule,
    serverNow: now,
    cards,
    support,
    topicChoices,
    intent: readIntent(url.searchParams.get("intent")),
  };
});

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

function floatingAction(view: View, owner: boolean, official: boolean): ReturnType<typeof headerAction> {
  if (view === "topics" || (owner && (view === "polls" || view === "schedule")))
    return headerAction(view, owner, official);
  return null;
}

function useIntentDialog(intent: ReturnType<typeof readIntent>, viewer: Viewer | null, streamer: Streamer) {
  const intentDialog = (): Dialog => {
    if (intent !== "suggest" || !viewer || streamer.status !== "active") return null;
    return streamer.isOfficial ? "idea" : "topic";
  };
  const [dialog, setDialog] = useState<Dialog>(intentDialog);
  const [signIn, setSignIn] = useState<boolean>(intent === "suggest" && !viewer);
  // The intent can also arrive by in-app navigation to this same page, which keeps the component mounted.
  const [intentSeen, setIntentSeen] = useState<string | null>(intent);
  if (intentSeen !== intent) {
    setIntentSeen(intent);
    if (intent === "suggest") {
      setDialog(intentDialog());
      setSignIn(!viewer);
    }
  }
  return { dialog, setDialog, signIn, setSignIn };
}

function pageRole(owner: boolean, moderator: boolean): "owner" | "admin" | "viewer" {
  if (owner) return "owner";
  return moderator ? "admin" : "viewer";
}

function streamerHeaderAppearance(
  streamer: Streamer,
): Pick<ComponentProps<typeof StreamerHeader>, "className" | "views" | "labels" | "icons" | "brand"> {
  if (!streamer.isOfficial) return { className: "", views: streamerViews, labels: {}, icons: {} };
  return {
    className: "ideas-header",
    views: officialViews,
    labels: { topics: t("ideas.tab") },
    icons: { topics: "idea" },
    brand: (
      <>
        <span className="ideas-logo" aria-hidden="true">
          <img src="/assets/stream-bullets-icon.svg" alt="" width="128" height="136" />
        </span>
        <span className="streamer-name-wrap">
          <span className="streamer-name">{streamer.name}</span>
          <span className="ideas-sub">{t("ideas.subtitle")}</span>
        </span>
      </>
    ),
  };
}

export default function StreamerPage(): ReactNode {
  const data = useLoaderData<typeof loader>();
  const { viewer, moderator, view, sort, query, status, events, support } = data;
  const { board, selected: loadedSelected, refreshing, refresh: refreshData } = useBoardRefresh(data);
  const { streamer } = board;
  useRememberContentRoute(`/@${streamer.handle}`, streamer.name);
  const [searchParams, setSearchParams] = useSearchParams();
  const here = useLocation();
  const revalidator = useRevalidator();
  const refresh = useCallback(async (): Promise<void> => {
    try {
      await refreshData();
    } catch (error_: unknown) {
      if (error_ instanceof ApiError && error_.status === 404) await revalidator.revalidate();
      else throw error_;
    }
  }, [refreshData, revalidator]);
  const toast = useToast();
  const { dialog, setDialog, signIn, setSignIn } = useIntentDialog(data.intent, viewer, streamer);
  const { providers } = useShell();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>("");
  const [extra, setExtra] = useState<Entry[]>([]);
  /** Spins the polls refresh icon once per click (item 20). */
  const [refreshes, setRefreshes] = useState<number>(0);
  const [cursor, setCursor] = useState<string | null>(board.nextCursor);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const generation = useRef<number>(0);
  const official = streamer.isOfficial;
  const live = useLivePolls(streamer.handle, view === "polls");
  const refreshBoard = useCallback(async (): Promise<void> => {
    try {
      await refresh();
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    }
  }, [refresh]);
  useLiveRevalidation(live.status, live.snapshot?.revision, refreshBoard, view === "polls");
  const owner: boolean = viewer?.id === streamer.ownerId;
  const writable: boolean = streamer.status === "active";
  const scheduleNow: number = useScheduleClock(data.serverNow, events);
  const liveEvent: StreamEvent | null = streamer.status === "suspended" ? null : liveEventAt(events, scheduleNow);
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
  // Wakes exactly at a running battle's start and end, so every viewer sees them on time.
  const now: number = useBattleClock(live.snapshot?.serverNow || board.serverNow, battleMarks([...entries, selected]));
  const pollsClass: string = usePollsMainClass(view === "polls" && loadedSelected ? selected : null, now);

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

  // A create navigates to the new entry, then its dialog closes. That close must not rewrite the URL from the
  // pre-navigation search params, or the entry would drop out of it.
  const created = useRef<boolean>(false);
  function closeIntentDialog(): void {
    setDialog(null);
    if (created.current) created.current = false;
    else if (searchParams.has("intent")) setParam("intent", null);
  }

  function setParam(name: string, value: string | null): void {
    const params = new URLSearchParams(searchParams);
    if (value === null) params.delete(name);
    else params.set(name, value);
    setSearchParams(params, { replace: name === "event" });
  }

  async function mutate(body: unknown, key: string = "create"): Promise<{ id: string }> {
    setPending((current) => new Set([...current, key]));
    setError("");
    try {
      const result = await postJson<{ id: string }>(`/api/streamers/${encodeURIComponent(streamer.handle)}`, body);
      if (key !== "create") await refresh();
      return result;
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  function act(body: unknown, id: string): void {
    mutate(body, id).catch((error_: unknown) => setError(errorMessage(error_)));
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

  async function deleteEntry(id: string): Promise<void> {
    await postJson<unknown>(`/api/streamers/${encodeURIComponent(streamer.handle)}`, {
      action: "delete",
      id,
    });
    generation.current += 1;
    setExtra([]);
  }

  async function removeSelected(): Promise<void> {
    if (!selected) return;
    await deleteEntry(selected.id);
    navigate(view);
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
        status={streamer.status}
        refreshKey={board.revision}
        onChanged={() => void refreshBoard()}
      />
    );
  }

  function copyPageLink(): void {
    const url = `${location.origin}/@${streamer.handle}`;
    void copyText(url).then((copied: boolean) => toast(copied ? t("entry.linkCopied") : url));
  }

  /** The empty Topics state: the owner shares the page; viewers suggest the first topic. */
  function renderEmptyTopics(): ReactNode {
    if (official)
      return (
        <EmptyState
          title={t("ideas.emptyTitle")}
          icon="idea"
          action={
            !viewer && providers.length === 0 ? (
              <a className="button-link" href={`mailto:${contactEmails.support}`}>
                <Icon name="mail" size={18} />
                {t("contact.openEmail")}
              </a>
            ) : (
              writable && (
                <button type="button" className="gold" onClick={() => viewer ? setDialog("idea") : setSignIn(true)}>
                  <Icon name="plus" size={18} />
                  {t("ideas.suggest")}
                </button>
              )
            )
          }
        >
          {t(!viewer && providers.length === 0 ? "signIn.off" : "ideas.emptyBody")}
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
                pending={pending.has(selected.id)}
                onBack={() => navigate("topics")}
                onReact={(value) => act({ action: "react", id: selected.id, value }, selected.id)}
                onDelete={removeSelected}
                onStatusSaved={async () => {
                  await refresh();
                  toast(t("ideas.admin.saved"));
                }}
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
      <PollsView
        name={streamer.name}
        viewer={viewer}
        owner={owner}
        moderator={moderator}
        writable={writable}
        entries={entries}
        selected={loadedSelected ? selected : null}
        now={now}
        sort={sort}
        liveEvent={liveEvent}
        live={live}
        pending={pending}
        more={Boolean(cursor)}
        loadingMore={loadingMore}
        refreshing={refreshing}
        refreshes={refreshes}
        onCreate={() => setDialog("poll")}
        onOpen={(id: string | null) => navigate("polls", id ?? undefined)}
        onSort={(next: SortOrder) => changeBoard("sort", next)}
        onRefresh={() => {
          setRefreshes((value: number) => value + 1);
          void refreshBoard();
        }}
        onLoadMore={() => void loadMore()}
        onAction={act}
        onDelete={async (id: string) => {
          if (loadedSelected?.id === id) return removeSelected();
          await deleteEntry(id);
          await refresh();
        }}
        onDeleteSelected={removeSelected}
        discussion={renderDiscussion}
      />
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
          linked={data.linkedEvent}
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
      <main className={view === "polls" ? `page-panel ${pollsClass}` : "page-panel"} id="main-content">
        <div className={`page-column${view === "schedule" ? " page-column-wide" : ""}`}>{content}</div>
      </main>
    );
  }

  const action = viewer ? headerAction(view, owner, official) : null;
  const showFab: boolean = Boolean(viewer && writable && !pollsClass.includes("mash-page"));
  const fab = showFab ? floatingAction(view, owner, official) : null;
  const role = pageRole(owner, moderator);
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
        {...streamerHeaderAppearance(streamer)}
        badge={
          liveEvent && (
            <Link className="live-pill" to="?view=schedule">
              <span className="live-dot" aria-hidden="true" />
              {t("live.badge")}
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
      <PageBanner
        status={streamer.status}
        reason={streamer.statusReason}
        changedAt={streamer.statusChangedAt}
        role={role}
        page={streamer}
      />
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
          if (!open) closeIntentDialog();
        }}
        onCreate={async (body: unknown) => {
          const result = await mutate(body);
          created.current = true;
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
            if (!open) closeIntentDialog();
          }}
          onCreate={async (body) => {
            const result = await mutate({ action: "create", kind: "topic", ...body });
            created.current = true;
            toast(t("ideas.thanks"));
            setSearchParams(new URLSearchParams({ view: "topics", entry: result.id }));
          }}
        />
      )}
    </div>
  );
}
