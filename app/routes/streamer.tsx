import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Link, useLoaderData, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import { appContext } from '../env';
import { getViewer } from '../server/auth.server';
import { getEntry, getStreamer, listEntries } from '../server/data.server';
import { AccountControls, Avatar, EmptyState } from '../components/common';
import { configuredProviders } from '../server/auth.server';
import { errorMessage, postJson, requestJson } from '../components/api';
import { CreateEntry } from '../components/create-entry';
import { DeleteButton, Discussion } from '../components/discussion';
import { useLivePolls, useLiveRevalidation, useServerTime } from '../components/live';
import { PollCard } from '../components/poll';
import type { BoardSnapshot, Entry, SortOrder } from '../types';

type View = 'topics' | 'polls' | 'schedule' | 'about' | 'community';
const views: View[] = ['topics', 'polls', 'schedule', 'about', 'community'];

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const app = context.get(appContext);
  if (!params.handle?.startsWith('@')) throw new Response('Page not found.', { status: 404 });
  const streamer = await getStreamer(app.env, params.handle.slice(1));
  if (!streamer) throw new Response('Streamer not found.', { status: 404 });
  const viewer = await getViewer(request, app);
  const url: URL = new URL(request.url);
  const requestedView: string = url.searchParams.get('view') || 'topics';
  let view: View = views.includes(requestedView as View) ? requestedView as View : 'topics';
  const entryId: string | null = url.searchParams.get('entry');
  const selected: Entry | null = entryId ? await getEntry(app.env, entryId, viewer?.id || null) : null;
  if (entryId && (!selected || selected.streamerId !== streamer.id)) throw new Response('Conversation not found.', { status: 404 });
  if (selected) view = selected.kind === 'topic' ? 'topics' : 'polls';
  const sort: SortOrder = url.searchParams.get('sort') === 'newest' ? 'newest' : url.searchParams.get('sort') === 'top' ? 'top' : view === 'polls' ? 'newest' : 'top';
  const query: string = url.searchParams.get('query') || '';
  const board: BoardSnapshot = await listEntries(app.env, streamer, viewer?.id || null, { kind: view === 'polls' ? 'polls' : 'topics', sort, query, cursor: null });
  return { board, selected, viewer, providers: configuredProviders(app.env), view, sort, query };
}

function TopicIcon({ category }: { category: string }): ReactNode {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    {category === 'Gaming' ? <><path d="M7 7h10c3 0 5 10 3 11-2 1-4-3-5-3H9c-1 0-3 4-5 3C2 17 4 7 7 7Z" /><path d="M8 10v5M5.5 12.5h5M16 11h.1M18 14h.1" /></> : category === 'Creative' ? <><path d="M4 3h7l1 2 1-2h7v17h-7l-1 1-1-1H4Z" /><path d="M12 5v16" /></> : category === 'Just chatting' ? <path d="M3 4h18v13H9l-6 4Z" /> : <><rect x="2" y="3" width="20" height="14" rx="1" /><path d="M8 21h8M12 17v4" /></>}
  </svg>;
}

export default function StreamerPage(): ReactNode {
  const { board, selected: loadedSelected, viewer, providers, view, sort, query } = useLoaderData<typeof loader>();
  const { streamer } = board;
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const [dialog, setDialog] = useState<'topic' | 'poll' | null>(null);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [extra, setExtra] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(board.nextCursor);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [split, setSplit] = useState<number>(40);
  const generation = useRef<number>(0);
  const workspace = useRef<HTMLElement>(null);
  const pointerId = useRef<number | null>(null);
  const live = useLivePolls(streamer.handle, view === 'polls');
  useLiveRevalidation(live.status, live.snapshot?.revision, revalidator.revalidate, view === 'polls');
  const now: number = useServerTime(live.snapshot?.serverNow || board.serverNow);
  const owner: boolean = viewer?.id === streamer.ownerId;
  const boardIds: Set<string> = new Set(board.entries.map((entry: Entry) => entry.id));
  const entries: Entry[] = [...new Map([...board.entries, ...extra.filter((entry: Entry) => !boardIds.has(entry.id))].map((entry: Entry) => [entry.id, entry])).values()].map((cached: Entry) => {
    const entry: Entry = loadedSelected?.id === cached.id ? loadedSelected : cached;
    const update = live.snapshot && live.snapshot.revision >= board.revision ? live.snapshot.polls.find((poll) => poll.id === entry.id) : null;
    return update ? { ...entry, ...update } : entry;
  });
  const selectedBase: Entry | null = loadedSelected || entries[0] || null;
  const selectedUpdate = selectedBase && live.snapshot && live.snapshot.revision >= board.revision ? live.snapshot.polls.find((poll) => poll.id === selectedBase.id) : null;
  const selected: Entry | null = selectedBase && selectedUpdate ? { ...selectedBase, ...selectedUpdate } : selectedBase;

  useEffect(() => {
    generation.current += 1;
    setExtra([]);
    setCursor(board.nextCursor);
    setLoadingMore(false);
    setError('');
  }, [streamer.id, view, sort, query, board.nextCursor, board.revision]);

  function navigate(next: View, entryId?: string): void {
    const params = new URLSearchParams();
    params.set('view', next);
    if (entryId) params.set('entry', entryId);
    if (next === view) {
      params.set('sort', sort);
      if (query) params.set('query', query);
    }
    setSearchParams(params);
  }

  async function mutate(body: unknown): Promise<{ id: string }> {
    setPending(true);
    setError('');
    try {
      const result = await postJson<{ id: string }>(`/api/streamers/${encodeURIComponent(streamer.handle)}`, body);
      await revalidator.revalidate();
      return result;
    } finally { setPending(false); }
  }

  function act(body: unknown): void {
    void mutate(body).catch((cause: unknown) => setError(errorMessage(cause)));
  }

  async function loadMore(): Promise<void> {
    if (!cursor || loadingMore) return;
    const revision: number = generation.current;
    setLoadingMore(true);
    setError('');
    const params = new URLSearchParams({ kind: view === 'polls' ? 'polls' : 'topics', sort, query, cursor });
    try {
      const result = await requestJson<BoardSnapshot>(`/api/streamers/${encodeURIComponent(streamer.handle)}?${params}`);
      if (revision !== generation.current) return;
      setExtra((previous: Entry[]) => [...previous, ...result.entries]);
      setCursor(result.nextCursor);
    } catch (cause: unknown) { if (revision === generation.current) setError(errorMessage(cause)); }
    finally { if (revision === generation.current) setLoadingMore(false); }
  }

  function setSort(next: SortOrder): void {
    const params = new URLSearchParams(searchParams);
    params.set('sort', next);
    params.delete('entry');
    setSearchParams(params);
  }

  function search(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const params = new URLSearchParams(searchParams);
    params.set('query', String(form.get('query') || '').trim());
    params.delete('entry');
    setSearchParams(params);
  }

  function changed(): void {
    void revalidator.revalidate();
  }

  async function removeSelected(): Promise<void> {
    if (!selected) return;
    await postJson<unknown>(`/api/streamers/${encodeURIComponent(streamer.handle)}`, { action: 'delete', id: selected.id });
    generation.current += 1;
    setExtra([]);
    navigate(view);
  }

  return <div className="streamer-shell" style={streamer.background ? { backgroundImage: `linear-gradient(#0a2025e8,#0a2025e8),url("${streamer.background}")` } : undefined}>
    <header className="site-header">
      <Link className="brand" to="/" aria-label="StreamBullets home"><Avatar className="brand-avatar" name={streamer.name} url={streamer.avatar} /></Link>
      <nav aria-label="Main navigation">{views.map((tab: View) => <button type="button" key={tab} aria-current={view === tab ? 'page' : undefined} onClick={() => navigate(tab)}><span className="nav-label">{tab}</span><span className="compact-nav-label">{tab === 'topics' ? 'Topics' : tab === 'polls' ? 'Polls' : tab === 'schedule' ? 'Plan' : tab === 'about' ? 'About' : 'People'}</span></button>)}</nav>
      <div className="header-end">
        {viewer && <button className="gold" id="suggest" type="button" aria-label="Suggest a topic" onClick={() => setDialog('topic')}><span className="suggest-plus" aria-hidden="true">+</span><span className="suggest-label">Suggest a topic</span></button>}
        <AccountControls viewer={viewer} providers={providers} />
      </div>
    </header>
    {error && <p className="page-error form-error" role="alert">{error}</p>}
    {view === 'topics' ? <main ref={workspace} id="main-content" className={`topic-workspace ${searchParams.has('entry') ? 'has-selection' : ''}`} style={{ '--split': `${split}%` } as CSSProperties}>
      <section className="browse" aria-label="Browse topics">
        <div className="intro"><h1>Pick the next conversation</h1><p>{streamer.name} · Suggest topics. Vote. Chat.</p></div>
        <form className="search" onSubmit={search}><label className="sr-only" htmlFor="topic-search">Search topics</label><input key={query} id="topic-search" name="query" type="search" maxLength={100} defaultValue={query} placeholder="Search topics…" /><button type="submit" className="search-button" aria-label="Search topics">Search</button></form>
        <div className="list-toolbar"><div className="tabs" aria-label="Topic sorting"><button type="button" className={sort === 'top' ? 'active' : ''} aria-pressed={sort === 'top'} onClick={() => setSort('top')}>Top</button><button type="button" className={sort === 'newest' ? 'active' : ''} aria-pressed={sort === 'newest'} onClick={() => setSort('newest')}>New</button></div><span className="list-count">{entries.length} topics{cursor ? '+' : ''}</span></div>
        <div id="topics" tabIndex={0} aria-label="Scrollable topic list">
          {entries.map((entry: Entry) => <button type="button" key={entry.id} className={`topic ${selected?.id === entry.id ? 'selected' : ''}`} aria-pressed={selected?.id === entry.id} onClick={() => navigate('topics', entry.id)}>
            <span className="topic-icon"><TopicIcon category={entry.category} /></span><span className="topic-main"><span className="topic-title">{entry.title}</span><span className="topic-meta"><span title="Likes">+ {entry.likes}</span><span title="Dislikes">− {entry.dislikes}</span><span title="Comments">▤ {entry.comments}</span></span></span><span aria-hidden="true">›</span>
          </button>)}
          {entries.length === 0 && <p className="empty">{query ? 'No topics match your search.' : 'No topics yet. Bring the first idea.'}</p>}
          {cursor && <button className="load-more" type="button" disabled={loadingMore} onClick={() => { void loadMore(); }}>{loadingMore ? 'Loading…' : 'Load more topics'}</button>}
        </div>
      </section>
      <div id="splitter" role="separator" tabIndex={0} aria-label="Resize topic panels" aria-orientation="vertical" aria-controls="topics detail" aria-valuemin={25} aria-valuemax={65} aria-valuenow={Math.round(split)}
        onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setSplit((value: number) => Math.max(25, Math.min(65, value + (event.key === 'ArrowRight' ? 2 : -2)))); } }}
        onPointerDown={(event) => { pointerId.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => { if (pointerId.current !== event.pointerId || !workspace.current) return; const bounds: DOMRect = workspace.current.getBoundingClientRect(); setSplit(Math.max(25, Math.min(65, (event.clientX - bounds.left) / bounds.width * 100))); }}
        onPointerUp={() => { pointerId.current = null; }} onPointerCancel={() => { pointerId.current = null; }} onDoubleClick={() => setSplit(40)}><span /></div>
      <section className="detail" id="detail" tabIndex={0} aria-label="Selected topic">
        {selected ? <>
          <div className="topic-content"><button type="button" className="back" onClick={() => navigate('topics')}>‹ All topics</button><div className="detail-top"><span className="category"><TopicIcon category={selected.category} />{selected.category}</span><Link className="text-link" to={`?view=topics&entry=${selected.id}`}>Topic link</Link></div>
            <h2>{selected.title}</h2><div className="author"><Avatar name={selected.author} url={selected.avatar} />Posted by <strong>{selected.author}</strong></div><p className="description">{selected.body}</p>
            <div className="votes"><button type="button" disabled={!viewer || pending} aria-pressed={selected.reaction === 1} onClick={() => act({ action: 'react', id: selected.id, value: selected.reaction === 1 ? 0 : 1 })}>Like <b>{selected.likes}</b></button><button type="button" disabled={!viewer || pending} aria-pressed={selected.reaction === -1} onClick={() => act({ action: 'react', id: selected.id, value: selected.reaction === -1 ? 0 : -1 })}>Dislike <b>{selected.dislikes}</b></button></div>
            {!viewer && <p className="muted">Sign in to vote or suggest a topic.</p>}
            {viewer && (owner || selected.authorId === viewer.id) && <div className="content-actions"><DeleteButton label="Delete topic" onDelete={removeSelected} disabled={pending} /></div>}
          </div>
          <Discussion key={selected.id} entryId={selected.id} handle={streamer.handle} viewer={viewer} ownerId={streamer.ownerId} refreshKey={board.revision} onChanged={changed} />
        </> : <EmptyState title="Start a conversation.">Suggest a topic for {streamer.name}&apos;s next stream.</EmptyState>}
      </section>
    </main> : <main className="page-panel" id="main-content">
      {view === 'polls' ? <>
        <div className="page-title"><div><span className="eyebrow">YOUR VOICE, ON AIR</span><h1>Live polls</h1><p>One question. Everyone has a say.</p></div>{owner && <button className="gold" type="button" onClick={() => setDialog('poll')}>+ Create poll</button>}</div>
        <div className="connection-status"><span role="status">{live.status === 'live' ? 'Live updates connected' : live.status === 'connecting' ? 'Connecting to live updates…' : live.status === 'reconnecting' ? 'Connection lost. Reconnecting…' : 'Live updates are offline.'}</span>{live.status === 'offline' && <button type="button" onClick={live.reconnect}>Reconnect</button>}<button type="button" disabled={revalidator.state !== 'idle'} onClick={() => { void revalidator.revalidate(); }}>Refresh polls</button></div>
        <div className="poll-toolbar"><div className="tabs" aria-label="Poll sorting"><button type="button" aria-pressed={sort === 'newest'} className={sort === 'newest' ? 'active' : ''} onClick={() => setSort('newest')}>Newest</button><button type="button" aria-pressed={sort === 'top'} className={sort === 'top' ? 'active' : ''} onClick={() => setSort('top')}>Top</button></div>{loadedSelected && <button type="button" onClick={() => navigate('polls')}>‹ All polls</button>}{owner && <Link className="text-link" to={`/@${streamer.handle}/overlay${loadedSelected ? `?poll=${loadedSelected.id}` : ''}`}>OBS overlay</Link>}</div>
        {live.snapshot?.polls.some((poll) => !entries.some((entry: Entry) => entry.id === poll.id)) && <p role="status">More polls are available. <button type="button" onClick={() => { void revalidator.revalidate(); }}>Load latest polls</button></p>}
        {(loadedSelected && selected ? [selected] : entries).map((entry: Entry) => <PollCard key={entry.id} entry={entry} now={now} signedIn={Boolean(viewer)} owner={owner} pending={pending} onAction={act} onDiscuss={() => navigate('polls', entry.id)} />)}
        {entries.length === 0 && !loadedSelected && <EmptyState title="The mic is yours.">No polls yet. The next question starts here.</EmptyState>}
        {cursor && !loadedSelected && <button type="button" className="load-more" disabled={loadingMore} onClick={() => { void loadMore(); }}>{loadingMore ? 'Loading…' : 'Load more polls'}</button>}
        {loadedSelected && selected && <div className="poll-card poll-discussion"><h2>{selected.title}</h2>{owner && <DeleteButton label="Delete poll" onDelete={removeSelected} disabled={pending} />}<Discussion key={selected.id} entryId={selected.id} handle={streamer.handle} viewer={viewer} ownerId={streamer.ownerId} refreshKey={board.revision} onChanged={changed} /></div>}
      </> : view === 'about' ? <><span className="eyebrow">BEHIND THE MIC</span><h1>{streamer.name}</h1><section className="info-card"><Avatar name={streamer.name} url={streamer.avatar} /><p className="description">{streamer.about || 'This streamer has not added an introduction yet.'}</p></section></> : view === 'schedule' ? <><span className="eyebrow">WHAT&apos;S NEXT</span><h1>Stream schedule</h1><EmptyState title="Next stream to be announced.">In the meantime, help choose what we talk about.</EmptyState><button className="gold" type="button" onClick={() => navigate('topics')}>Explore topics</button></> : <><span className="eyebrow">PART OF THE CONVERSATION</span><h1>{streamer.name}&apos;s community</h1><div className="community-grid"><section className="info-card"><h2>Bring an idea</h2><p>Suggest a topic, vote on your favorites, and discuss it with everyone.</p><button className="gold" type="button" onClick={() => navigate('topics')}>Browse topics</button></section><section className="info-card"><h2>Have your say live</h2><p>Vote in live polls. Keep the conversation respectful and on topic.</p><button className="gold" type="button" onClick={() => navigate('polls')}>Open polls</button></section></div></>}
    </main>}
    <CreateEntry key={dialog || 'closed'} mode={dialog || 'topic'} open={dialog !== null} onOpenChange={(open: boolean) => { if (!open) setDialog(null); }} onCreate={async (body: unknown) => { const result = await mutate(body); navigate(dialog === 'poll' ? 'polls' : 'topics', result.id); }} />
  </div>;
}
