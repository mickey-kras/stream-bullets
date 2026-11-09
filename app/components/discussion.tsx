import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { intlLocale, t } from "../i18n";
import { useShell } from "../lib/shell";
import { orderThreads, replyParent, visibleReplies } from "../lib/threads";
import type { Comment, CommentThread, SortOrder, StreamerStatus, ThreadSnapshot, Viewer } from "../types";
import { KeyConfirm } from "./admin/key-confirm";
import { errorMessage, needsStepUp, postJson, requestJson } from "./api";
import { Avatar, Modal } from "./common";
import { ReportButton } from "./report";
import { SignInDialog } from "./shell/sign-in-dialog";
import { Icon } from "./ui/icon";
import { IconButton } from "./ui/icon-button";
import { Select } from "./ui/select";

export function DeleteButton({
  label,
  onDelete,
  disabled = false,
  text,
}: Readonly<{
  label: string;
  onDelete: () => Promise<void>;
  disabled?: boolean;
  /** Visible text when it differs from the accessible name (for example "Delete" in a comment menu). */
  text?: string;
}>): ReactNode {
  const [open, setOpen] = useState<boolean>(false);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  // An admin who removes someone else's content may need a fresh security-key check first, as in the Admin tab.
  const [stepUp, setStepUp] = useState<boolean>(false);
  async function remove(): Promise<void> {
    setPending(true);
    setError("");
    try {
      await onDelete();
      setStepUp(false);
      setOpen(false);
    } catch (error_: unknown) {
      if (needsStepUp(error_)) setStepUp(true);
      else setError(errorMessage(error_));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <button type="button" disabled={disabled} aria-label={text ? label : undefined} onClick={() => setOpen(true)}>
        <Icon name="trash" size={16} />
        {text ?? label}
      </button>
      <Modal
        open={open}
        onOpenChange={(next: boolean) => {
          if (!pending) setOpen(next);
        }}
        title={`${label}?`}
        description={t("discussion.deleteBody")}
      >
        <p role="alert" className="form-error">
          {error}
        </p>
        {stepUp && <KeyConfirm inDialog label={label} onConfirmed={remove} />}
        <div className="modal-actions">
          <button type="button" disabled={pending} onClick={() => setOpen(false)}>
            {t("dialog.cancel")}
          </button>
          {!stepUp && (
            <button className="gold" type="button" disabled={pending} onClick={() => void remove()}>
              {pending ? t("discussion.deleting") : label}
            </button>
          )}
        </div>
      </Modal>
    </>
  );
}

/** Grows a composer textarea with its text, up to the CSS max-height. */
function grow(element: HTMLTextAreaElement): void {
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight + 2}px`;
}

const timeUnits: [number, number, Intl.RelativeTimeFormatUnit][] = [
  [60, 1, "second"],
  [3600, 60, "minute"],
  [86_400, 3600, "hour"],
  [2_592_000, 86_400, "day"],
  [31_536_000, 2_592_000, "month"],
  [Number.POSITIVE_INFINITY, 31_536_000, "year"],
];

/** "3 hours ago" in the viewer's language. */
function relativeTime(time: number): string {
  const seconds = Math.round((time - Date.now()) / 1000);
  const [, size, unit] = timeUnits.find(([limit]) => Math.abs(seconds) < limit) ?? timeUnits[5];
  return new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" }).format(Math.round(seconds / size), unit);
}

function Composer({
  viewer,
  label,
  placeholder,
  disabled,
  value,
  busy,
  onChange,
  onSubmit,
}: Readonly<{
  viewer: Viewer;
  label: string;
  placeholder: string;
  disabled: boolean;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}>): ReactNode {
  return (
    <form
      className="composer"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Avatar name={viewer.name} url={viewer.avatar} preset={viewer.avatarPreset} />
      <textarea
        data-composer
        value={value}
        required
        disabled={disabled}
        maxLength={2000}
        rows={1}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.currentTarget.value);
          grow(event.currentTarget);
        }}
      />
      <button className="gold" type="submit" disabled={disabled || busy || !value.trim()}>
        <Icon name="send" size={18} />
        {t("discussion.post")}
      </button>
    </form>
  );
}

interface CommentRules {
  viewer: Viewer | null;
  ownerId: string;
  moderator: boolean;
  writable: boolean;
  busy: boolean;
  reported: Set<string>;
  onLike: (comment: Comment) => void;
  onReply: (comment: Comment) => void;
  onDelete: (comment: Comment) => Promise<void>;
  onReported: (id: string) => void;
}

function CommentActions({ comment, rules }: Readonly<{ comment: Comment; rules: CommentRules }>): ReactNode {
  const { viewer } = rules;
  const reported = comment.reported || rules.reported.has(comment.id);
  // On a frozen or suspended page only admins can still remove content (mockup m14, round 2).
  const canDelete = Boolean(
    viewer && (rules.moderator || (rules.writable && (comment.authorId === viewer.id || rules.ownerId === viewer.id))),
  );
  const canReport = Boolean(viewer && comment.authorId !== viewer.id && !reported);
  const report = canReport && (
    <ReportButton
      targetKind="comment"
      targetId={comment.id}
      label={t("discussion.reportBy", { name: comment.author })}
      description={t("discussion.reportBody", { name: comment.author })}
      onReported={() => rules.onReported(comment.id)}
    />
  );
  const remove = canDelete && (
    <DeleteButton
      label={t("discussion.deleteComment")}
      text={t("common.delete")}
      disabled={rules.busy}
      onDelete={() => rules.onDelete(comment)}
    />
  );
  return (
    <div className="comment-actions">
      <button
        type="button"
        disabled={!viewer || rules.busy || !rules.writable}
        aria-pressed={comment.liked}
        aria-label={t("discussion.likeBy", { name: comment.author })}
        onClick={() => rules.onLike(comment)}
      >
        <Icon name={comment.liked ? "thumbs-up-filled" : "thumbs-up"} size={16} />
        {t("discussion.like")} <span className="count">{comment.likes}</span>
      </button>
      <button type="button" disabled={!viewer || !rules.writable} onClick={() => rules.onReply(comment)}>
        <Icon name="reply" size={16} />
        {t("discussion.reply")}
      </button>
      {canDelete && canReport ? (
        <details className="more-actions">
          <summary aria-label={t("discussion.moreActions", { name: comment.author })}>
            <Icon name="more" size={18} />
          </summary>
          <div className="more-menu">
            {report}
            {remove}
          </div>
        </details>
      ) : (
        (remove || report) && (
          <span className="comment-direct">
            {report}
            {remove}
          </span>
        )
      )}
    </div>
  );
}

function CommentArticle({
  comment,
  parent,
  rules,
}: Readonly<{ comment: Comment; parent: Comment | null | undefined; rules: CommentRules }>): ReactNode {
  if (comment.removed)
    return (
      <article className="comment removed" id={`cm-${comment.id}`} aria-label={t("discussion.removed")}>
        <span className="removed-avatar" aria-hidden="true">
          <Icon name="eye-off" size={18} />
        </span>
        <div className="comment-body">
          <p className="removed-note">{t("discussion.removed")}</p>
        </div>
      </article>
    );
  let parentName: string | null = null;
  if (parent !== undefined) parentName = parent && !parent.removed ? parent.author : t("discussion.removedParent");
  const reported = comment.reported || rules.reported.has(comment.id);
  return (
    <article className="comment" id={`cm-${comment.id}`}>
      <Avatar name={comment.author} url={comment.avatar} preset={comment.avatarPreset} />
      <div className="comment-body">
        <div className="comment-meta">
          <strong>{comment.author}</strong>
          <time
            dateTime={new Date(comment.createdAt).toISOString()}
            title={new Date(comment.createdAt).toLocaleString(intlLocale())}
          >
            {relativeTime(comment.createdAt)}
          </time>
          {reported && (
            <span className="reported-note">
              <Icon name="flag" size={14} />
              {t("discussion.reported")}
            </span>
          )}
        </div>
        {parentName !== null && (
          <a className="replying reply-mention" href={`#cm-${comment.parentId}`}>
            <Icon name="reply" size={16} />
            {t("discussion.replyTo", { name: parentName })}
          </a>
        )}
        <p className="comment-text">{comment.text}</p>
        <CommentActions comment={comment} rules={rules} />
      </div>
    </article>
  );
}

function Thread({
  thread,
  rules,
  replyTo,
  replyBox,
}: Readonly<{ thread: CommentThread; rules: CommentRules; replyTo: Comment | null; replyBox: ReactNode }>): ReactNode {
  const [expanded, setExpanded] = useState<boolean>(false);
  const [hidden, setHidden] = useState<boolean>(false);
  const { shown, hidden: more } = visibleReplies(thread.replies, expanded);
  const replying =
    replyTo !== null && (replyTo.id === thread.id || thread.replies.some((reply: Comment) => reply.id === replyTo.id));
  // Reply opens its box inside the replies list, so a thread whose replies were hidden shows them again.
  const target: string | null = replying && replyTo ? replyTo.id : null;
  const [opened, setOpened] = useState<string | null>(target);
  if (opened !== target) {
    setOpened(target);
    if (target !== null) setHidden(false);
  }
  const count = thread.replies.length;
  const listId = `replies-${thread.id}`;
  const showRepliesLabel: string = t(count === 1 ? "discussion.showReply" : "discussion.showReplies", { count });
  return (
    <li className={`thread${count ? " has-replies" : ""}`}>
      <CommentArticle comment={thread} parent={undefined} rules={rules} />
      {count > 0 && (
        <button
          type="button"
          className="thread-toggle"
          aria-expanded={!hidden}
          aria-controls={listId}
          onClick={() => setHidden(!hidden)}
        >
          <Icon name={hidden ? "chevron-right" : "chevron-down"} size={16} />
          {hidden ? showRepliesLabel : t("discussion.hideReplies", { count })}
        </button>
      )}
      {(count > 0 || replying) && (
        <ul
          className="replies"
          id={listId}
          hidden={hidden}
          aria-label={t("discussion.repliesTo", {
            name: thread.removed ? t("discussion.removedParent") : thread.author,
          })}
        >
          {shown.map((reply: Comment) => (
            <li key={reply.id}>
              <CommentArticle comment={reply} parent={replyParent(thread, reply)} rules={rules} />
            </li>
          ))}
          {more > 0 && (
            <li className="thread-more">
              <button
                type="button"
                className="text-button"
                aria-expanded={false}
                aria-controls={listId}
                onClick={() => setExpanded(true)}
              >
                <Icon name="chevron-down" size={16} />
                {t(more === 1 ? "discussion.viewMoreOne" : "discussion.viewMore", { count: more })}
              </button>
            </li>
          )}
          {replying && !hidden && <li className="inline-reply">{replyBox}</li>}
        </ul>
      )}
    </li>
  );
}

async function fetchThreads(
  entryId: string,
  sort: SortOrder,
  pages: number,
  signal?: AbortSignal,
  from: string | null = null,
): Promise<{ threads: CommentThread[]; cursor: string | null; pages: number }> {
  const threads: CommentThread[] = [];
  let cursor: string | null = from;
  let loaded = 0;
  do {
    const cursorQuery: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const query: string = `sort=${sort}&view=thread${cursorQuery}`;
    const snapshot: ThreadSnapshot = await requestJson<ThreadSnapshot>(
      `/api/entries/${encodeURIComponent(entryId)}/comments?${query}`,
      {
        signal,
      },
    );
    threads.push(...snapshot.comments);
    cursor = snapshot.nextCursor;
    loaded += 1;
  } while (cursor && loaded < pages);
  return { threads: mergeThreads([], threads, sort), cursor, pages: loaded };
}

/** The loaded threads plus a new page, each thread once, in the list's order. */
function mergeThreads(current: CommentThread[], page: CommentThread[], sort: SortOrder): CommentThread[] {
  const unique = [...new Map([...current, ...page].map((thread: CommentThread) => [thread.id, thread])).values()];
  return orderThreads(unique, sort);
}

/** Find a comment anywhere in the loaded threads. */
function findComment(threads: CommentThread[], id: string): Comment | null {
  for (const thread of threads) {
    if (thread.id === id) return thread;
    const reply = thread.replies.find((comment: Comment) => comment.id === id);
    if (reply) return reply;
  }
  return null;
}

function updateComment(threads: CommentThread[], id: string, change: (comment: Comment) => Comment): CommentThread[] {
  return threads.map((thread: CommentThread) => ({
    ...(thread.id === id ? { ...thread, ...change(thread) } : thread),
    replies: thread.replies.map((reply: Comment) => (reply.id === id ? change(reply) : reply)),
  }));
}

/**
 * The discussion under a topic, poll or idea (item 40): one comment box on top, threads with replies under their
 * top-level comment (oldest first, collapsed after two), one inline reply box, and "Comment removed" placeholders
 * that keep a thread together. Frozen and suspended pages show it read-only.
 */
export function Discussion({
  entryId,
  viewer,
  ownerId,
  moderator = false,
  status = "active",
  refreshKey,
  onChanged,
  handle,
}: Readonly<{
  entryId: string;
  handle: string;
  viewer: Viewer | null;
  ownerId: string;
  /** The viewer is an administrator and may remove any comment. */
  moderator?: boolean;
  status?: StreamerStatus;
  refreshKey: number;
  onChanged: () => void;
}>): ReactNode {
  const { providers } = useShell();
  const writable = status === "active";
  const [sort, setSort] = useState<SortOrder>("newest");
  const [revision, setRevision] = useState<number>(0);
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [text, setText] = useState<string>("");
  const [replyText, setReplyText] = useState<string>("");
  const [replyId, setReplyId] = useState<string | null>(null);
  const [reported, setReported] = useState<Set<string>>(new Set());
  const [signIn, setSignIn] = useState<boolean>(false);
  const pages = useRef<number>(1);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const requestKey = `${entryId}:${sort}:${refreshKey}:${revision}`;
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    const controller = new AbortController();
    fetchThreads(entryId, sort, pages.current, controller.signal)
      .then((result) => {
        pages.current = result.pages;
        setThreads(result.threads);
        setCursor(result.cursor);
        setError("");
        setLoadedKey(requestKey);
      })
      .catch((error_: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(error_));
        setLoadedKey(requestKey);
      });
    return () => controller.abort();
  }, [entryId, sort, requestKey]);

  const replyTo = replyId ? findComment(threads, replyId) : null;

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await action();
      setRevision((value: number) => value + 1);
      onChanged();
    } catch (error_: unknown) {
      // The delete dialog asks for the security key itself, so the step-up request is not a page error.
      if (!needsStepUp(error_)) setError(errorMessage(error_));
      throw error_;
    } finally {
      setBusy(false);
    }
  }

  function post(value: string, parentId: string | null): void {
    void run(() =>
      postJson(`/api/streamers/${encodeURIComponent(handle)}`, {
        action: "comment",
        id: entryId,
        text: value.trim(),
        parentId,
      }),
    )
      .then(() => {
        if (parentId) {
          setReplyText("");
          setReplyId(null);
        } else setText((current: string) => (current === value ? "" : current));
      })
      .catch(() => undefined);
  }

  const rules: CommentRules = {
    viewer,
    ownerId,
    moderator,
    writable,
    busy,
    reported,
    onLike: (comment: Comment) => {
      const liked = !comment.liked;
      setThreads((current) =>
        updateComment(current, comment.id, (value: Comment) => ({
          ...value,
          liked,
          likes: value.likes + (liked ? 1 : -1),
        })),
      );
      postJson("/api/comments", { action: "like", id: comment.id, liked })
        .then(onChanged)
        .catch((error_: unknown) => {
          setError(errorMessage(error_));
          setRevision((value: number) => value + 1);
        });
    },
    onReply: (comment: Comment) => setReplyId(comment.id),
    onDelete: (comment: Comment) => run(() => postJson("/api/comments", { action: "delete", id: comment.id })),
    onReported: (id: string) => setReported((current) => new Set(current).add(id)),
  };

  const replyBox = viewer && replyTo && (
    <>
      <div className="replying">
        {t("discussion.replyingTo", { name: replyTo.removed ? t("discussion.removedParent") : replyTo.author })}{" "}
        <button
          type="button"
          className="small-button"
          aria-label={t("discussion.cancelReply")}
          onClick={() => setReplyId(null)}
        >
          <Icon name="close" size={16} />
          {t("dialog.cancel")}
        </button>
      </div>
      <Composer
        viewer={viewer}
        label={t("discussion.writeReply", { name: replyTo.removed ? t("discussion.removedParent") : replyTo.author })}
        placeholder={t("discussion.replyPlaceholder")}
        disabled={!writable}
        value={replyText}
        busy={busy}
        onChange={setReplyText}
        onSubmit={() => post(replyText, replyTo.id)}
      />
    </>
  );

  const unavailablePlaceholder: string = t(status === "frozen" ? "discussion.frozen" : "discussion.suspended");
  return (
    <section className="discussion" aria-labelledby={`discussion-${entryId}`}>
      <div className="discussion-head">
        <h3 id={`discussion-${entryId}`}>{t("discussion.title")}</h3>
        <Select
          className="comment-sort"
          label={t("discussion.sort")}
          value={sort}
          onValueChange={(value: string) => {
            pages.current = 1;
            setSort(value as SortOrder);
          }}
          options={[
            { value: "newest", label: t("discussion.newest") },
            { value: "top", label: t("discussion.top") },
          ]}
        />
        <IconButton
          label={t("discussion.refresh")}
          icon="refresh"
          spin={revision}
          disabled={loading}
          onClick={() => setRevision((value: number) => value + 1)}
        />
      </div>
      {viewer ? (
        <Composer
          viewer={viewer}
          label={t("discussion.write")}
          placeholder={writable ? t("discussion.placeholder") : unavailablePlaceholder}
          disabled={!writable}
          value={text}
          busy={busy}
          onChange={setText}
          onSubmit={() => post(text, null)}
        />
      ) : (
        <p className="join-discussion">
          <button type="button" className="gold" onClick={() => setSignIn(true)}>
            <Icon name="comment" size={18} />
            {t("discussion.signIn")}
          </button>
          <SignInDialog open={signIn} onOpenChange={setSignIn} providers={providers} />
        </p>
      )}
      <p className="form-error" role="alert">
        {error}
      </p>
      {loading && threads.length === 0 && <output className="muted">{t("discussion.loading")}</output>}
      {!loading && threads.length === 0 && <p className="empty">{t("discussion.empty")}</p>}
      <ul className="thread-list" aria-label={t("discussion.comments")}>
        {threads.map((thread: CommentThread) => (
          <Thread key={thread.id} thread={thread} rules={rules} replyTo={replyTo} replyBox={replyBox} />
        ))}
      </ul>
      {cursor && (
        <button
          type="button"
          className="load-more"
          disabled={loading || loadingMore}
          onClick={() => {
            // Only the next page is fetched; the pages already shown stay as they are.
            setLoadingMore(true);
            fetchThreads(entryId, sort, 1, undefined, cursor)
              .then((result) => {
                pages.current += 1;
                setThreads((current: CommentThread[]) => mergeThreads(current, result.threads, sort));
                setCursor(result.cursor);
              })
              .catch((error_: unknown) => setError(errorMessage(error_)))
              .finally(() => setLoadingMore(false));
          }}
        >
          {t("discussion.loadMore")}
        </button>
      )}
    </section>
  );
}
