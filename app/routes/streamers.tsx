import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLoaderData, useLocation, useNavigate, type LoaderFunctionArgs } from "react-router";
import { appContext } from "../env";
import { t, tn } from "../i18n";
import { directoryHref, readIntent, streamerTarget, type Intent } from "../lib/directory";
import { useShell } from "../lib/shell";
import { countStreamers, listStreamers } from "../server/data.server";
import { HttpError } from "../server/http.server";
import type { Streamer, StreamerDirectory } from "../types";
import { errorMessage, requestJson } from "../components/api";
import { dialogHref, type DialogState } from "../components/account/dialog-route";
import { EmptyState } from "../components/common";
import { useRememberContentRoute } from "../components/shell/back-link";
import { SiteHeader } from "../components/shell/site-header";
import { StreamerLogo } from "../components/ui/avatar";
import { Icon, type IconName } from "../components/ui/icon";

export function meta() {
  return [
    { title: "Streamers · StreamBullets" },
    { name: "description", content: "Find a streamer's community on StreamBullets. Suggest topics, vote and discuss the stream." },
  ];
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const app = context.get(appContext);
  const url = new URL(request.url);
  const query: string = (url.searchParams.get("query") ?? "").trim().slice(0, 60);
  try {
    const [page, total] = await Promise.all([listStreamers(app.env, null, query), countStreamers(app.env, query)]);
    return { ...page, total, query, intent: readIntent(url.searchParams.get("then")) };
  } catch (error: unknown) {
    if (error instanceof HttpError) throw new Response(error.message, { status: error.status });
    throw error;
  }
}

const intentIcon: Record<Intent, IconName> = { suggest: "plus", vote: "polls", discuss: "comment" };
const intentPrompt: Record<Intent, "streamers.intent.suggest" | "streamers.intent.vote" | "streamers.intent.discuss"> = {
  suggest: "streamers.intent.suggest",
  vote: "streamers.intent.vote",
  discuss: "streamers.intent.discuss",
};

function StreamerCard({ streamer, intent }: Readonly<{ streamer: Streamer; intent: Intent | null }>): ReactNode {
  if (streamer.isOfficial)
    return (
      <Link className="info-card streamer-card official-card" to={streamerTarget(streamer.handle, intent)}>
        {streamer.logo || streamer.avatar ? (
          <StreamerLogo streamer={streamer} />
        ) : (
          <span className="ideas-logo" aria-hidden="true">
            <img src="/assets/stream-bullets-icon.svg" alt="" width="128" height="136" />
          </span>
        )}
        <div>
          <h2>
            {streamer.name}{" "}
            <span className="official-badge">
              <Icon name="shield-check" size={16} />
              {t("streamers.official")}
            </span>
          </h2>
          <p className="muted">@{streamer.handle}</p>
          <p className="official-bio">{streamer.about || t("streamers.officialBio")}</p>
        </div>
      </Link>
    );
  return (
    <Link className="info-card streamer-card" to={streamerTarget(streamer.handle, intent)}>
      <StreamerLogo streamer={streamer} />
      <div>
        <h2>{streamer.name}</h2>
        <p className="muted">@{streamer.handle}</p>
        {streamer.status === "frozen" && (
          <p className="card-status">
            <span className="sched-badge st-frozen">
              <Icon name="lock" size={14} />
              {t("streamers.frozen")}
            </span>
          </p>
        )}
        <p className="streamer-bio">{streamer.about || t("streamers.noAbout")}</p>
      </div>
    </Link>
  );
}

/**
 * The Streamers directory (item 2): official pages first, then by handle, 20 at a time with "Load more", and a
 * search by name or @handle. From a landing sign (`?then=suggest|vote|discuss`, item 5) a dismissible prompt
 * says what to do and every card goes straight to that action.
 */
export default function Streamers(): ReactNode {
  const data = useLoaderData<typeof loader>();
  const shell = useShell();
  const location = useLocation();
  const navigate = useNavigate();
  const [extra, setExtra] = useState<{ streamers: Streamer[]; nextCursor: string | null; key: string } | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [text, setText] = useState<string>(data.query);
  const grid = useRef<HTMLDivElement | null>(null);
  const typing = useRef<number>(0);
  useRememberContentRoute("/streamers", t("nav.streamers"));

  // A new search (or a new intent) starts again from the first page.
  const key = `${data.query}\n${data.intent ?? ""}`;
  const more = extra?.key === key ? extra : null;
  const streamers: Streamer[] = [...data.streamers, ...(more?.streamers ?? [])];
  const nextCursor: string | null = more ? more.nextCursor : data.nextCursor;
  // Follow the URL (Back, Clear search), but never overwrite what someone is still typing.
  useEffect(() => {
    if (document.activeElement?.id !== "streamer-search") setText(data.query);
  }, [data.query]);
  useEffect(() => () => window.clearTimeout(typing.current), []);

  function search(value: string, replace: boolean): void {
    const params = new URLSearchParams(location.search);
    const trimmed: string = value.trim();
    if (trimmed) params.set("query", trimmed);
    else params.delete("query");
    const qs: string = params.toString();
    void navigate(`/streamers${qs ? `?${qs}` : ""}`, { replace, preventScrollReset: true });
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError("");
    const shown: number = streamers.length;
    try {
      const params = new URLSearchParams({ cursor: nextCursor });
      if (data.query) params.set("query", data.query);
      const page = await requestJson<StreamerDirectory>(`/api/streamers?${params.toString()}`);
      setExtra({ key, streamers: [...(more?.streamers ?? []), ...page.streamers], nextCursor: page.nextCursor });
      // Keyboard users continue from the first new card.
      requestAnimationFrame(() => grid.current?.querySelectorAll<HTMLElement>(".streamer-card")[shown]?.focus());
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setLoading(false);
    }
  }

  const official: Streamer | undefined = streamers.find((streamer: Streamer) => streamer.isOfficial);
  const signedInViewer: boolean = Boolean(shell.viewer && !shell.ownStreamer);
  const hostCta: ReactNode = signedInViewer ? (
    <p className="muted">
      {t("streamers.hostPrompt")}{" "}
      <Link
        className="text-link"
        to={dialogHref(location, "host")}
        state={{ dialogFrom: location.pathname } satisfies DialogState}
        preventScrollReset
      >
        {t("account.hostCommunity")}
      </Link>
    </p>
  ) : null;

  let count: string = "";
  if (streamers.length > 0)
    count =
      streamers.length < data.total
        ? t("streamers.showingOf", { shown: streamers.length, total: data.total })
        : tn("streamers.showing", streamers.length);

  return (
    <>
      <SiteHeader />
      <main className="page-panel streamers-page" id="main-content">
        <div className="page-title">
          <div>
            <span className="eyebrow">{t("streamers.eyebrow")}</span>
            <h1>{t("nav.streamers")}</h1>
            <p>
              {t("streamers.intro")}
              {official && (
                <>
                  {" "}
                  <Link className="text-link ideas-link" to={`/@${official.handle}`}>
                    <Icon name="idea" size={16} />
                    {t("streamers.ideas")}
                  </Link>
                </>
              )}
            </p>
          </div>
        </div>
        {data.intent && (
          <p className="intent-prompt" role="status">
            <span>
              <Icon name={intentIcon[data.intent]} size={18} />
              {t(intentPrompt[data.intent])}
            </span>
            <Link
              className="intent-clear"
              to={data.query ? `/streamers?query=${encodeURIComponent(data.query)}` : directoryHref(null)}
              aria-label={t("streamers.intent.clear")}
              preventScrollReset
            >
              <Icon name="close" size={16} />
            </Link>
          </p>
        )}
        {hostCta}
        {data.total === 0 && !data.query ? (
          <EmptyState title={t("streamers.emptyTitle")} icon="streamers">
            {t("streamers.emptyBody")}
          </EmptyState>
        ) : (
          <>
            <form
              className="search directory-search"
              role="search"
              action="/streamers"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                window.clearTimeout(typing.current);
                search(text, false);
              }}
            >
              <label className="sr-only" htmlFor="streamer-search">
                {t("streamers.searchLabel")}
              </label>
              <input
                id="streamer-search"
                name="query"
                type="search"
                maxLength={60}
                value={text}
                placeholder={t("streamers.searchPlaceholder")}
                onChange={(event) => {
                  const value: string = event.currentTarget.value;
                  setText(value);
                  window.clearTimeout(typing.current);
                  typing.current = window.setTimeout(() => search(value, true), 350);
                }}
              />
              {data.intent && <input type="hidden" name="then" value={data.intent} />}
              <span className="search-lead" aria-hidden="true">
                <Icon name="search" size={18} />
              </span>
              <button type="submit" className="search-button">
                <Icon name="search" size={18} />
                <span className="search-text">{t("streamers.search")}</span>
                <span className="sr-only"> {t("streamers.searchSuffix")}</span>
              </button>
            </form>
            <div className="list-toolbar">
              <span className="list-count" aria-live="polite">
                {count}
              </span>
              {streamers.length === 0 && (
                <button type="button" className="text-button" onClick={() => search("", false)}>
                  {t("streamers.clearSearch")}
                </button>
              )}
            </div>
            <div ref={grid}>
              {streamers.length > 0 ? (
                <div className="streamer-grid">
                  {streamers.map((streamer: Streamer) => (
                    <StreamerCard key={streamer.id} streamer={streamer} intent={data.intent} />
                  ))}
                </div>
              ) : (
                <p className="empty">
                  <Icon name="search-none" size={20} />
                  {t("streamers.noMatch", { query: data.query })}
                </p>
              )}
            </div>
            <p className="form-error" role="alert">
              {error}
            </p>
            {nextCursor && (
              <button type="button" className="load-more" disabled={loading} onClick={() => void loadMore()}>
                {loading ? t("streamers.loading") : t("streamers.loadMore")}
                <Icon name="chevron-down" size={18} />
              </button>
            )}
          </>
        )}
      </main>
    </>
  );
}
