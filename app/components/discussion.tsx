import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Comment, DiscussionSnapshot, SortOrder, Viewer } from '../types';
import { Avatar, Modal } from './common';
import { errorMessage, postJson, requestJson } from './api';

type CommentChange = { action: 'like'; id: string; liked: boolean } | { action: 'delete'; id: string };

export function DeleteButton({ label, onDelete, disabled = false }: { label: string; onDelete: () => Promise<void>; disabled?: boolean }): ReactNode {
  const [open, setOpen] = useState<boolean>(false);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  async function remove(): Promise<void> {
    setPending(true);
    setError('');
    try { await onDelete(); setOpen(false); }
    catch (cause: unknown) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  return <>
    <button type="button" disabled={disabled} onClick={() => setOpen(true)}>{label}</button>
    <Modal open={open} onOpenChange={(next: boolean) => { if (!pending) setOpen(next); }} title={`${label}?`} description="This removes the content from the community. This action cannot be undone.">
      <p role="alert" className="form-error">{error}</p>
      <div className="modal-actions"><button type="button" disabled={pending} onClick={() => setOpen(false)}>Cancel</button><button className="gold" type="button" disabled={pending} onClick={() => { void remove(); }}>{pending ? 'Deleting…' : label}</button></div>
    </Modal>
  </>;
}

export function Discussion({ entryId, handle, viewer, ownerId, refreshKey, onChanged }: {
  entryId: string;
  handle: string;
  viewer: Viewer | null;
  ownerId: string;
  refreshKey: number;
  onChanged: () => void;
}): ReactNode {
  const [comments, setComments] = useState<Comment[]>([]);
  const [sort, setSort] = useState<SortOrder>('newest');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [text, setText] = useState<string>('');
  const [reply, setReply] = useState<Comment | null>(null);
  const [revision, setRevision] = useState<number>(0);
  const loadGeneration = useRef<number>(0);
  const loadedHistory = useRef<boolean>(false);
  const threadKey = useRef<string>('');
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const controller: AbortController = new AbortController();
    const key: string = `${entryId}:${sort}`;
    if (threadKey.current !== key) {
      threadKey.current = key;
      loadedHistory.current = false;
      setComments([]);
      setCursor(null);
    }
    loadGeneration.current += 1;
    const generation: number = loadGeneration.current;
    setLoading(true);
    setLoadingMore(false);
    setError('');
    void requestJson<DiscussionSnapshot>(`/api/entries/${encodeURIComponent(entryId)}/comments?sort=${sort}`, { signal: controller.signal })
      .then((snapshot: DiscussionSnapshot) => {
        if (controller.signal.aborted || generation !== loadGeneration.current) return;
        if (!loadedHistory.current || !snapshot.nextCursor) {
          setComments(snapshot.comments);
          setCursor(snapshot.nextCursor);
          return;
        }
        setComments((previous: Comment[]) => {
          if (!snapshot.comments.some((incoming: Comment) => previous.some((old: Comment) => old.id === incoming.id))) setCursor(snapshot.nextCursor);
          const tail: Comment | undefined = snapshot.comments.at(-1);
          const compare = (a: Comment, b: Comment): number => (sort === 'top' ? b.likes - a.likes : 0) || b.createdAt - a.createdAt || b.id.localeCompare(a.id);
          const older: Comment[] = tail ? previous.filter((comment: Comment) => compare(comment, tail) > 0) : [];
          return [...new Map([...older, ...snapshot.comments].map((comment: Comment) => [comment.id, comment])).values()].sort(compare);
        });
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted && generation === loadGeneration.current) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted && generation === loadGeneration.current) setLoading(false); });
    return (): void => controller.abort();
  }, [entryId, sort, refreshKey, revision]);

  async function loadMore(): Promise<void> {
    if (!cursor || loadingMore) return;
    const generation: number = loadGeneration.current;
    setLoadingMore(true);
    setError('');
    try {
      const snapshot: DiscussionSnapshot = await requestJson<DiscussionSnapshot>(`/api/entries/${encodeURIComponent(entryId)}/comments?sort=${sort}&cursor=${encodeURIComponent(cursor)}`);
      if (generation !== loadGeneration.current) return;
      loadedHistory.current = true;
      setComments((previous: Comment[]) => [...new Map([...previous, ...snapshot.comments].map((comment: Comment) => [comment.id, comment])).values()]);
      setCursor(snapshot.nextCursor);
    } catch (cause: unknown) { if (generation === loadGeneration.current) setError(errorMessage(cause)); }
    finally { if (generation === loadGeneration.current) setLoadingMore(false); }
  }

  async function changeComment(body: CommentChange): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await postJson<unknown>('/api/comments', body);
      loadGeneration.current += 1;
      setComments((previous: Comment[]) => {
        const updated: Comment[] = body.action === 'delete'
          ? previous.filter((comment: Comment) => comment.id !== body.id).map((comment: Comment) => comment.parentId === body.id ? { ...comment, parentId: null } : comment)
          : previous.map((comment: Comment) => comment.id === body.id ? { ...comment, liked: body.liked, likes: comment.likes + Number(body.liked) - Number(comment.liked) } : comment);
        return sort === 'top' ? updated.sort((a: Comment, b: Comment) => b.likes - a.likes || b.createdAt - a.createdAt || b.id.localeCompare(a.id)) : updated;
      });
      if (body.action === 'delete') setReply((current: Comment | null) => current?.id === body.id ? null : current);
      setRevision((value: number) => value + 1);
      onChanged();
    } finally { setBusy(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !text.trim()) return;
    const submitted: string = text;
    const parentId: string | null = reply?.id || null;
    setBusy(true);
    setError('');
    try {
      await postJson<unknown>(`/api/streamers/${encodeURIComponent(handle)}`, { action: 'comment', id: entryId, text: submitted.trim(), parentId });
      setText((current: string) => current === submitted ? '' : current);
      setReply((current: Comment | null) => current?.id === parentId ? null : current);
      setRevision((value: number) => value + 1);
      onChanged();
    } catch (cause: unknown) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <section className="discussion" aria-labelledby={`discussion-${entryId}`}>
    <div className="discussion-head"><h3 id={`discussion-${entryId}`}>Discussion</h3>
      <label className="comment-sort"><span className="sr-only">Sort comments</span><select value={sort} onChange={(event) => setSort(event.currentTarget.value as SortOrder)}><option value="newest">Newest</option><option value="top">Top</option></select></label>
      <button type="button" className="small-button" disabled={loading} onClick={() => setRevision((value: number) => value + 1)}>Refresh</button>
    </div>
    {loading && <p role="status" className="muted">Loading comments…</p>}
    {!loading && comments.length === 0 && <p className="empty">Start the conversation. What do you think?</p>}
    {comments.map((comment: Comment) => <article className="comment" key={comment.id}>
      <Avatar name={comment.author} url={comment.avatar} />
      <div className="comment-body">
        <div className="comment-meta"><strong>{comment.author}</strong><time dateTime={new Date(comment.createdAt).toISOString()}>{new Date(comment.createdAt).toLocaleDateString('en-US', { timeZone: 'UTC' })}</time></div>
        {comment.parentId && <small className="replying">Reply to {comments.find((parent: Comment) => parent.id === comment.parentId)?.author || 'an earlier comment'}</small>}
        <p className="comment-text">{comment.text}</p>
        <div className="comment-actions">
          <button type="button" disabled={!viewer || busy} aria-pressed={comment.liked} aria-label={`Like comment by ${comment.author}`} onClick={() => { void changeComment({ action: 'like', id: comment.id, liked: !comment.liked }).catch((cause: unknown) => setError(errorMessage(cause))); }}>Like {comment.likes}</button>
          <button type="button" disabled={!viewer || busy} onClick={() => { setReply(comment); textarea.current?.focus(); }}>Reply</button>
          {viewer && (comment.authorId === viewer.id || ownerId === viewer.id) && <DeleteButton label="Delete comment" disabled={busy} onDelete={() => changeComment({ action: 'delete', id: comment.id })} />}
        </div>
      </div>
    </article>)}
    {cursor && <button type="button" className="load-more" disabled={loadingMore || loading} onClick={() => { void loadMore(); }}>{loadingMore ? 'Loading…' : 'Load more comments'}</button>}
    {viewer ? <>
      {reply && <div className="replying">Replying to {reply.author} <button type="button" className="small-button" onClick={() => setReply(null)}>Cancel reply</button></div>}
      <form className="composer" onSubmit={(event: FormEvent<HTMLFormElement>) => { void submit(event); }}>
        <Avatar name={viewer.name} url={viewer.avatar} />
        <textarea ref={textarea} value={text} onChange={(event) => setText(event.currentTarget.value)} required maxLength={2000} rows={2} aria-label="Write a comment" placeholder="Write a comment…" />
        <button className="gold" type="submit" disabled={busy || !text.trim()}>{busy ? 'Posting…' : 'Post'}</button>
      </form>
    </> : <p className="muted">Sign in to join the discussion.</p>}
    <p className="form-error" role="alert">{error}</p>
  </section>;
}
