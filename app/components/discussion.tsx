import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Comment, DiscussionSnapshot, SortOrder, Viewer } from "../types";
import { Avatar, Modal } from "./common";
import { errorMessage, postJson, requestJson } from "./api";

type CommentChange = { action: "like"; id: string; liked: boolean } | { action: "delete"; id: string };

function refreshedReply(
  selected: Comment | null,
  current: Comment[],
  nextCursor: string | null,
  compare: (a: Comment, b: Comment) => number,
): Comment | null {
  if (!selected) return null;
  const updated: Comment | undefined = current.find((comment: Comment) => comment.id === selected.id);
  if (updated) return updated;
  const tail: Comment | undefined = current.at(-1);
  // A sort change can leave a valid reply target beyond the refreshed range.
  return !nextCursor || (tail && compare(selected, tail) <= 0) ? null : selected;
}

export function DeleteButton({
  label,
  onDelete,
  disabled = false,
}: Readonly<{
  label: string;
  onDelete: () => Promise<void>;
  disabled?: boolean;
}>): ReactNode {
  const [open, setOpen] = useState<boolean>(false);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  async function remove(): Promise<void> {
    setPending(true);
    setError("");
    try {
      await onDelete();
      setOpen(false);
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </button>
      <Modal
        open={open}
        onOpenChange={(next: boolean) => {
          if (!pending) setOpen(next);
        }}
        title={`${label}?`}
        description="This removes the content from the community. This action cannot be undone."
      >
        <p role="alert" className="form-error">
          {error}
        </p>
        <div className="modal-actions">
          <button type="button" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            className="gold"
            type="button"
            disabled={pending}
            onClick={() => {
              void remove();
            }}
          >
            {pending ? "Deleting…" : label}
          </button>
        </div>
      </Modal>
    </>
  );
}

export function Discussion({
  entryId,
  handle,
  viewer,
  ownerId,
  refreshKey,
  onChanged,
}: Readonly<{
  entryId: string;
  handle: string;
  viewer: Viewer | null;
  ownerId: string;
  refreshKey: number;
  onChanged: () => void;
}>): ReactNode {
  const [comments, setComments] = useState<Comment[]>([]);
  const [sort, setSort] = useState<SortOrder>("newest");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [text, setText] = useState<string>("");
  const [reply, setReply] = useState<Comment | null>(null);
  const [revision, setRevision] = useState<number>(0);
  const loadGeneration = useRef<number>(0);
  const loadedPages = useRef<number>(1);
  const historyBoundary = useRef<Comment | null>(null);
  const threadKey = useRef<string>("");
  const textarea = useRef<HTMLTextAreaElement>(null);

  const requestKey: string = JSON.stringify([entryId, sort, refreshKey, revision]);
  const [previousRequest, setPreviousRequest] = useState<string>(requestKey);
  const [previousThread, setPreviousThread] = useState<string>(`${entryId}:${sort}`);
  if (previousRequest !== requestKey) {
    setPreviousRequest(requestKey);
    setLoading(true);
    setLoadingMore(false);
    setError("");
    if (previousThread !== `${entryId}:${sort}`) {
      setPreviousThread(`${entryId}:${sort}`);
      setComments([]);
      setCursor(null);
    }
  }

  useEffect(() => {
    const controller: AbortController = new AbortController();
    const key: string = `${entryId}:${sort}`;
    if (threadKey.current !== key) {
      threadKey.current = key;
      loadedPages.current = 1;
      historyBoundary.current = null;
    }
    loadGeneration.current += 1;
    const generation: number = loadGeneration.current;
    async function refresh(): Promise<void> {
      const targetPages: number = loadedPages.current;
      const boundary: Comment | null = historyBoundary.current;
      const refreshed: Comment[] = [];
      const compare = (a: Comment, b: Comment): number =>
        (sort === "top" ? b.likes - a.likes : 0) || b.createdAt - a.createdAt || b.id.localeCompare(a.id);
      let pages: number = 0;
      let nextCursor: string | null = null;
      do {
        const cursorQuery: string = nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : "";
        const query: string = `sort=${sort}${cursorQuery}`;
        const snapshot: DiscussionSnapshot = await requestJson<DiscussionSnapshot>(
          `/api/entries/${encodeURIComponent(entryId)}/comments?${query}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted || generation !== loadGeneration.current) return;
        refreshed.push(...snapshot.comments);
        pages += 1;
        nextCursor = snapshot.nextCursor;
        const tail: Comment | undefined = snapshot.comments.at(-1);
        // Re-read every loaded page; continue through its old boundary if new comments shifted it.
        if (pages >= targetPages && (!boundary || !tail || compare(tail, boundary) >= 0)) break;
      } while (nextCursor);
      const current: Comment[] = [...new Map(refreshed.map((comment: Comment) => [comment.id, comment])).values()].sort(
        compare,
      );
      loadedPages.current = pages;
      historyBoundary.current = pages > 1 ? (current.at(-1) ?? null) : null;
      setComments(current);
      setCursor(nextCursor);
      setReply((selected: Comment | null) => refreshedReply(selected, current, nextCursor, compare));
    }
    void refresh()
      .catch((error_: unknown) => {
        if (!controller.signal.aborted && generation === loadGeneration.current) setError(errorMessage(error_));
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === loadGeneration.current) setLoading(false);
      });
    return (): void => controller.abort();
  }, [entryId, sort, refreshKey, revision]);

  async function loadMore(): Promise<void> {
    if (!cursor || loadingMore) return;
    const generation: number = loadGeneration.current;
    setLoadingMore(true);
    setError("");
    try {
      const snapshot: DiscussionSnapshot = await requestJson<DiscussionSnapshot>(
        `/api/entries/${encodeURIComponent(entryId)}/comments?sort=${sort}&cursor=${encodeURIComponent(cursor)}`,
      );
      if (generation !== loadGeneration.current) return;
      loadedPages.current += 1;
      historyBoundary.current = snapshot.comments.at(-1) ?? historyBoundary.current;
      setComments((previous: Comment[]) => [
        ...new Map([...previous, ...snapshot.comments].map((comment: Comment) => [comment.id, comment])).values(),
      ]);
      setCursor(snapshot.nextCursor);
    } catch (error_: unknown) {
      if (generation === loadGeneration.current) setError(errorMessage(error_));
    } finally {
      if (generation === loadGeneration.current) setLoadingMore(false);
    }
  }

  async function changeComment(body: CommentChange): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await postJson<unknown>("/api/comments", body);
      loadGeneration.current += 1;
      setComments((previous: Comment[]) => {
        const updated: Comment[] =
          body.action === "delete"
            ? previous
                .filter((comment: Comment) => comment.id !== body.id)
                .map((comment: Comment) => (comment.parentId === body.id ? { ...comment, parentId: null } : comment))
            : previous.map((comment: Comment) =>
                comment.id === body.id
                  ? { ...comment, liked: body.liked, likes: comment.likes + Number(body.liked) - Number(comment.liked) }
                  : comment,
              );
        return sort === "top"
          ? updated.sort(
              (a: Comment, b: Comment) => b.likes - a.likes || b.createdAt - a.createdAt || b.id.localeCompare(a.id),
            )
          : updated;
      });
      if (body.action === "delete") setReply((current: Comment | null) => (current?.id === body.id ? null : current));
      setRevision((value: number) => value + 1);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !text.trim()) return;
    const submitted: string = text;
    const parentId: string | null = reply?.id || null;
    setBusy(true);
    setError("");
    try {
      await postJson<unknown>(`/api/streamers/${encodeURIComponent(handle)}`, {
        action: "comment",
        id: entryId,
        text: submitted.trim(),
        parentId,
      });
      setText((current: string) => (current === submitted ? "" : current));
      setReply((current: Comment | null) => (current?.id === parentId ? null : current));
      setRevision((value: number) => value + 1);
      onChanged();
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="discussion" aria-labelledby={`discussion-${entryId}`}>
      <div className="discussion-head">
        <h3 id={`discussion-${entryId}`}>Discussion</h3>
        <label className="comment-sort">
          <span className="sr-only">Sort comments</span>
          <select value={sort} onChange={(event) => setSort(event.currentTarget.value as SortOrder)}>
            <option value="newest">Newest</option>
            <option value="top">Top</option>
          </select>
        </label>
        <button
          type="button"
          className="small-button"
          disabled={loading}
          onClick={() => setRevision((value: number) => value + 1)}
        >
          Refresh
        </button>
      </div>
      {loading && <output className="muted">Loading comments…</output>}
      {!loading && comments.length === 0 && <p className="empty">Start the conversation. What do you think?</p>}
      {comments.map((comment: Comment) => (
        <article className="comment" key={comment.id}>
          <Avatar name={comment.author} url={comment.avatar} />
          <div className="comment-body">
            <div className="comment-meta">
              <strong>{comment.author}</strong>
              <time dateTime={new Date(comment.createdAt).toISOString()}>
                {new Date(comment.createdAt).toLocaleDateString("en-US", { timeZone: "UTC" })}
              </time>
            </div>
            {comment.parentId && (
              <small className="replying">
                Reply to{" "}
                {comments.find((parent: Comment) => parent.id === comment.parentId)?.author || "an earlier comment"}
              </small>
            )}
            <p className="comment-text">{comment.text}</p>
            <div className="comment-actions">
              <button
                type="button"
                disabled={!viewer || busy}
                aria-pressed={comment.liked}
                aria-label={`Like comment by ${comment.author}`}
                onClick={() => {
                  void changeComment({ action: "like", id: comment.id, liked: !comment.liked }).catch(
                    (error_: unknown) => setError(errorMessage(error_)),
                  );
                }}
              >
                Like {comment.likes}
              </button>
              <button
                type="button"
                disabled={!viewer || busy}
                onClick={() => {
                  setReply(comment);
                  textarea.current?.focus();
                }}
              >
                Reply
              </button>
              {viewer && (comment.authorId === viewer.id || ownerId === viewer.id) && (
                <DeleteButton
                  label="Delete comment"
                  disabled={busy}
                  onDelete={() => changeComment({ action: "delete", id: comment.id })}
                />
              )}
            </div>
          </div>
        </article>
      ))}
      {cursor && (
        <button
          type="button"
          className="load-more"
          disabled={loadingMore || loading}
          onClick={() => {
            void loadMore();
          }}
        >
          {loadingMore ? "Loading…" : "Load more comments"}
        </button>
      )}
      {viewer ? (
        <>
          {reply && (
            <div className="replying">
              Replying to {reply.author}{" "}
              <button type="button" className="small-button" onClick={() => setReply(null)}>
                Cancel reply
              </button>
            </div>
          )}
          <form
            className="composer"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              void submit(event);
            }}
          >
            <Avatar name={viewer.name} url={viewer.avatar} />
            <textarea
              ref={textarea}
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
              required
              maxLength={2000}
              rows={2}
              aria-label="Write a comment"
              placeholder="Write a comment…"
            />
            <button className="gold" type="submit" disabled={busy || !text.trim()}>
              {busy ? "Posting…" : "Post"}
            </button>
          </form>
        </>
      ) : (
        <p className="muted">Sign in to join the discussion.</p>
      )}
      <p className="form-error" role="alert">
        {error}
      </p>
    </section>
  );
}
