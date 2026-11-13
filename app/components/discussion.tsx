import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { readDraft, type DiscussionDraft } from "../lib/discussion-draft";
import { MentionInput, type MentionSelection } from "./mention-input";
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
  // Visible label when different from the accessible name.
  text?: string;
}>): ReactNode {
  const [open, setOpen] = useState<boolean>(false);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  // Admin removals can require fresh step-up.
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

const timeUnits: [number, number, Intl.RelativeTimeFormatUnit][] = [
  [60, 1, "second"],
  [3600, 60, "minute"],
  [86_400, 3600, "hour"],
  [2_592_000, 86_400, "day"],
  [31_536_000, 2_592_000, "month"],
  [Number.POSITIVE_INFINITY, 31_536_000, "year"],
];

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
  entryId,
  mentions,
  onMentionsChange,
}: Readonly<{
  viewer: Viewer;
  label: string;
  placeholder: string;
  disabled: boolean;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  entryId: string;
  mentions: MentionSelection[];
  onMentionsChange: (mentions: MentionSelection[]) => void;
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
      <MentionInput
        entryId={entryId}
        value={value}
        mentions={mentions}
        onChange={onChange}
        onMentionsChange={onMentionsChange}
        label={label}
        placeholder={placeholder}
        disabled={disabled || busy}
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
  entryId: string;
  onEdit: (comment: Comment, text: string, mentions: MentionSelection[]) => Promise<void>;
  onLike: (comment: Comment) => void;
  onReply: (comment: Comment) => void;
  onDelete: (comment: Comment) => Promise<void>;
  onReported: (id: string) => void;
}

function CommentActions({
  comment,
  rules,
  onEdit,
}: Readonly<{
  comment: Comment;
  rules: CommentRules;
  onEdit: () => void;
}>): ReactNode {
  const { viewer } = rules;
  const reported = comment.reported || rules.reported.has(comment.id);
  // Only admins can remove content from moderated pages.
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
      {viewer?.id === comment.authorId && rules.writable && (
        <button type="button" disabled={rules.busy} onClick={onEdit}>
          {t("common.edit")}
        </button>
      )}
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

function MentionText({ comment }: Readonly<{ comment: Comment }>): ReactNode {
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const mention of [...(comment.mentions ?? [])].sort(
    (a: MentionSelection, b: MentionSelection) => a.start - b.start,
  )) {
    parts.push(comment.text.slice(offset, mention.start));
    parts.push(
      <strong className="comment-mention" key={mention.userId} title={mention.userId}>
        {comment.text.slice(mention.start, mention.end)}
      </strong>,
    );
    offset = mention.end;
  }
  parts.push(comment.text.slice(offset));
  return parts;
}

function CommentArticle({
  comment,
  parent,
  rules,
}: Readonly<{
  comment: Comment;
  parent: Comment | null | undefined;
  rules: CommentRules;
}>): ReactNode {
  const [editing, setEditing] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>(comment.text);
  const [mentions, setMentions] = useState<MentionSelection[]>(comment.mentions ?? []);
  const [error, setError] = useState<string>("");
  const editButton = useRef<HTMLDivElement | null>(null);
  const focusActions = (): void => {
    requestAnimationFrame(() =>
      editButton.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }),
    );
  };
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
    <article className="comment" tabIndex={-1} id={`cm-${comment.id}`}>
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
        {editing ? (
          <form
            className="comment-editor"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setError("");
              void rules
                .onEdit(comment, draft, mentions)
                .then(() => {
                  setEditing(false);
                  focusActions();
                })
                .catch((cause: unknown) => setError(errorMessage(cause)));
            }}
          >
            <MentionInput
              entryId={rules.entryId}
              value={draft}
              mentions={mentions}
              onChange={setDraft}
              onMentionsChange={setMentions}
              label={t("discussion.editComment")}
              placeholder={t("discussion.placeholder")}
              disabled={rules.busy}
            />
            <p className="form-error" role="alert">
              {error}
            </p>
            <div className="comment-edit-actions">
              <button type="submit" className="gold" disabled={rules.busy || !draft.trim()}>
                {t("common.save")}
              </button>
              <button
                type="button"
                disabled={rules.busy}
                onClick={() => {
                  setEditing(false);
                  focusActions();
                }}
              >
                {t("dialog.cancel")}
              </button>
            </div>
          </form>
        ) : (
          <p className="comment-text">
            <MentionText comment={comment} />
          </p>
        )}
        {comment.editedAt && <span className="muted">{t("discussion.edited")}</span>}
        <div ref={editButton}>
          <CommentActions
            comment={comment}
            rules={rules}
            onEdit={() => {
              setDraft(comment.text);
              setMentions(comment.mentions ?? []);
              setEditing(true);
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLTextAreaElement>(`#cm-${comment.id} textarea`)
                  ?.focus({ preventScroll: true }),
              );
            }}
          />
        </div>
      </div>
    </article>
  );
}

function Thread({
  thread,
  rules,
  replyTo,
  replyBox,
  targetId,
}: Readonly<{
  thread: CommentThread;
  rules: CommentRules;
  replyTo: Comment | null;
  replyBox: ReactNode;
  targetId: string | null;
}>): ReactNode {
  const [expanded, setExpanded] = useState<boolean>(false);
  const [hidden, setHidden] = useState<boolean>(false);
  const { shown, hidden: more } = visibleReplies(
    thread.replies,
    expanded || Boolean(targetId && thread.replies.some((reply: Comment) => reply.id === targetId)),
  );
  const replying =
    replyTo !== null && (replyTo.id === thread.id || thread.replies.some((reply: Comment) => reply.id === replyTo.id));
  // Reveal hidden replies when opening an inline reply form.
  const target: string | null = targetId ?? (replying && replyTo ? replyTo.id : null);
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

// Append threads without duplicates; preserve list order.
function mergeThreads(current: CommentThread[], page: CommentThread[], sort: SortOrder): CommentThread[] {
  const unique = [...new Map([...current, ...page].map((thread: CommentThread) => [thread.id, thread])).values()];
  return orderThreads(unique, sort);
}

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

// Root comments with oldest-first replies; collapse after two. Keep deleted-parent placeholders. Moderated
// pages are read-only.
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
  // Admin may remove any comment.
  moderator?: boolean;
  status?: StreamerStatus;
  refreshKey: number;
  onChanged: () => void;
}>): ReactNode {
  const { providers } = useShell();
  const [search] = useSearchParams();
  const targetId = search.get("comment");
  const writable = status === "active";
  const [sort, setSort] = useState<SortOrder>("newest");
  const [revision, setRevision] = useState<number>(0);
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const draftKey = `discussion:${viewer?.id ?? "anonymous"}:${entryId}`;
  const [initial] = useState(() => readDraft(draftKey));
  const [error, setError] = useState<string>(initial.unavailable ? t("discussion.draftUnavailable") : "");
  const [draft, setDraft] = useState<DiscussionDraft>(initial.draft);
  const draftRef = useRef<DiscussionDraft>(initial.draft);
  const { text, mentions, replyText, replyMentions, replyId } = draft;
  function changeDraft(change: Partial<DiscussionDraft>): void {
    const next: DiscussionDraft = { ...draftRef.current, ...change };
    draftRef.current = next;
    setDraft(next);
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(next));
    } catch {
      setError(t("discussion.draftUnavailable"));
    }
  }
  const [reported, setReported] = useState<Set<string>>(new Set());
  const [signIn, setSignIn] = useState<boolean>(false);
  const pages = useRef<number>(1);
  const focusedTarget = useRef<string | null>(null);
  const restoredPosition = useRef<boolean>(false);
  const requestController = useRef<AbortController | null>(null);
  const [loadingMoreKey, setLoadingMoreKey] = useState<string>("");
  const requestKey = `${entryId}:${sort}:${refreshKey}:${revision}`;
  const loading = loadedKey !== requestKey;
  const loadingMore = loadingMoreKey === requestKey;

  useEffect(() => {
    const controller = new AbortController();
    requestController.current = controller;
    fetchThreads(entryId, sort, pages.current, controller.signal)
      .then(async (result) => {
        let values = result.threads;
        let targetError = "";
        if (targetId) {
          try {
            const exact = await requestJson<{
              thread: CommentThread;
              entryId: string;
            }>(`/api/comments/${encodeURIComponent(targetId)}`, {
              signal: controller.signal,
            });
            if (exact.entryId !== entryId) throw new Error(t("discussion.commentUnavailable"));
            values = mergeThreads(values, [exact.thread], sort);
          } catch (cause: unknown) {
            targetError = errorMessage(cause);
          }
        }
        if (controller.signal.aborted) return;
        pages.current = result.pages;
        setThreads(values);
        setCursor(result.cursor);
        setError(targetError);
        setLoadedKey(requestKey);
        setLoadingMoreKey("");
      })
      .catch((error_: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(error_));
        setLoadedKey(requestKey);
        setLoadingMoreKey("");
      });
    return () => controller.abort();
  }, [entryId, sort, requestKey, targetId]);

  useEffect(() => {
    if (!targetId) {
      focusedTarget.current = null;
      return;
    }
    if (focusedTarget.current === targetId || !findComment(threads, targetId)) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(`cm-${targetId}`);
      focusedTarget.current = targetId;
      element?.scrollIntoView({ block: "center" });
      element?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [targetId, threads]);

  useEffect(() => {
    const scroller = document.getElementById("detail");
    if (!scroller) return;
    const key = `${draftKey}:scroll`;
    const save = (): void => {
      try {
        sessionStorage.setItem(key, String(scroller.scrollTop));
      } catch {
        /* Draft storage reports unavailable storage. */
      }
    };
    if (!loading && !restoredPosition.current && !targetId) {
      try {
        const position = Number(sessionStorage.getItem(key));
        if (Number.isFinite(position) && position >= 0) scroller.scrollTop = position;
      } catch {
        /* Draft storage reports unavailable storage. */
      }
      restoredPosition.current = true;
    }
    scroller.addEventListener("scroll", save, { passive: true });
    return () => scroller.removeEventListener("scroll", save);
  }, [draftKey, loading, targetId]);

  const replyTo = replyId ? findComment(threads, replyId) : null;

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await action();
      setRevision((value: number) => value + 1);
      onChanged();
    } catch (error_: unknown) {
      // The delete dialog handles step-up locally, not as a page error.
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
        text: value,
        mentions: parentId ? replyMentions : mentions,
        parentId,
      }),
    )
      .then(() => {
        if (parentId) {
          changeDraft({ replyText: "", replyMentions: [], replyId: null });
        } else {
          if (draftRef.current.text === value) changeDraft({ text: "", mentions: [] });
        }
      })
      .catch(() => undefined);
  }

  const rules: CommentRules = {
    entryId,
    onEdit: (comment: Comment, value: string, selected: MentionSelection[]) =>
      run(() =>
        postJson("/api/comments", {
          action: "edit",
          id: comment.id,
          text: value,
          mentions: selected,
        }),
      ),
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
    onReply: (comment: Comment) => changeDraft({ replyId: comment.id }),
    onDelete: (comment: Comment) => run(() => postJson("/api/comments", { action: "delete", id: comment.id })),
    onReported: (id: string) => setReported((current) => new Set(current).add(id)),
  };

  const replyBox = viewer && replyTo && (
    <>
      <div className="replying">
        {t("discussion.replyingTo", {
          name: replyTo.removed ? t("discussion.removedParent") : replyTo.author,
        })}{" "}
        <button
          type="button"
          className="small-button"
          aria-label={t("discussion.cancelReply")}
          onClick={() => changeDraft({ replyId: null })}
        >
          <Icon name="close" size={16} />
          {t("dialog.cancel")}
        </button>
      </div>
      <Composer
        entryId={entryId}
        mentions={replyMentions}
        onMentionsChange={(selected: MentionSelection[]) => changeDraft({ replyMentions: selected })}
        viewer={viewer}
        label={t("discussion.writeReply", {
          name: replyTo.removed ? t("discussion.removedParent") : replyTo.author,
        })}
        placeholder={t("discussion.replyPlaceholder")}
        disabled={!writable}
        value={replyText}
        busy={busy}
        onChange={(value: string) => changeDraft({ replyText: value })}
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
          entryId={entryId}
          mentions={mentions}
          onMentionsChange={(selected: MentionSelection[]) => changeDraft({ mentions: selected })}
          viewer={viewer}
          label={t("discussion.write")}
          placeholder={writable ? t("discussion.placeholder") : unavailablePlaceholder}
          disabled={!writable}
          value={text}
          busy={busy}
          onChange={(value: string) => changeDraft({ text: value })}
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
          <Thread
            key={thread.id}
            thread={thread}
            rules={rules}
            replyTo={replyTo}
            replyBox={replyBox}
            targetId={targetId}
          />
        ))}
      </ul>
      {cursor && (
        <button
          type="button"
          className="load-more"
          disabled={loading || loadingMore}
          onClick={() => {
            // Bind pagination to the current request, including refreshes.
            const controller = requestController.current;
            if (!controller || controller.signal.aborted) return;
            setLoadingMoreKey(requestKey);
            fetchThreads(entryId, sort, 1, controller.signal, cursor)
              .then((result) => {
                if (controller.signal.aborted) return;
                pages.current += 1;
                setThreads((current: CommentThread[]) => mergeThreads(current, result.threads, sort));
                setCursor(result.cursor);
              })
              .catch((error_: unknown) => {
                if (!controller.signal.aborted) setError(errorMessage(error_));
              })
              .finally(() => {
                if (!controller.signal.aborted) setLoadingMoreKey("");
              });
          }}
        >
          {t("discussion.loadMore")}
        </button>
      )}
    </section>
  );
}
