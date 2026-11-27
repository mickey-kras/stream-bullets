import type { Comment, CommentThread } from "../types";

// Initial visible reply count. The server sends this many replies of each thread before it is opened.
export const VISIBLE_REPLIES = 2;

// Flatten replies under the root, oldest first, at one indent level.
export function orderReplies(replies: readonly Comment[]): Comment[] {
  return [...replies].sort((a: Comment, b: Comment): number => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

type ReplyWindow = Pick<CommentThread, "replies" | "replyCount" | "earlierReplies">;

// The loaded replies a thread shows: two until it is opened, all of a window that starts after the first reply.
// `earlier` replies come before them and `later` ones after; `unloaded` of the later ones are not loaded yet.
export function visibleReplies(
  thread: ReplyWindow,
  expanded: boolean,
): { shown: Comment[]; earlier: number; later: number; unloaded: number } {
  const ordered = orderReplies(thread.replies);
  const shown = expanded || thread.earlierReplies > 0 ? ordered : ordered.slice(0, VISIBLE_REPLIES);
  const after: number = Math.max(0, thread.replyCount - thread.earlierReplies);
  return {
    shown,
    earlier: thread.earlierReplies,
    later: Math.max(0, after - shown.length),
    unloaded: Math.max(0, after - ordered.length),
  };
}

// The place of a reply in its thread for `GET /api/comments/:id/replies`: its time and ID.
export function replyCursor(reply: Pick<Comment, "createdAt" | "id">): string {
  return `${reply.createdAt}.${reply.id}`;
}

// Adds a page of replies to a thread without duplicates. A page before the loaded ones lowers `earlierReplies`.
export function withReplies(thread: CommentThread, page: readonly Comment[], before: boolean): CommentThread {
  const known = new Set<string>(thread.replies.map((reply: Comment): string => reply.id));
  const added: Comment[] = page.filter((reply: Comment): boolean => !known.has(reply.id));
  // An earlier page holds replies that `earlierReplies` already counted, so the total stays the lower bound.
  const earlierReplies: number = before ? Math.max(0, thread.earlierReplies - added.length) : thread.earlierReplies;
  return {
    ...thread,
    replies: orderReplies([...thread.replies, ...added]),
    earlierReplies,
    replyCount: Math.max(thread.replyCount, earlierReplies + thread.replies.length + added.length),
  };
}

// A page of `GET /api/comments/:id/replies`.
export interface ReplyPage {
  replies: Comment[];
  earlierReplies: number | null;
  laterReplies: number | null;
}

// Adds a page of replies. The server counts the replies before and after the page now, so the thread counts its
// loaded replies plus those: a reply that another reader deleted, loaded or not, cannot hide or keep "View more".
// An empty page shows that nothing lies in its direction.
export function withPage(thread: CommentThread, page: ReplyPage, before: boolean): CommentThread {
  const next: CommentThread = withReplies(thread, page.replies, before);
  const later: number = Math.max(0, thread.replyCount - thread.earlierReplies - thread.replies.length);
  const first: Comment | undefined = page.replies[0];
  const last: Comment | undefined = page.replies.at(-1);
  if (!first || !last || page.earlierReplies === null || page.laterReplies === null) {
    if (before) return { ...next, earlierReplies: 0, replyCount: next.replies.length + later };
    return { ...next, replyCount: next.earlierReplies + next.replies.length };
  }
  const loadedBefore: number = Math.max(
    0,
    next.replies.findIndex((reply: Comment) => reply.id === first.id),
  );
  const loadedAfter: number =
    next.replies.length - 1 - next.replies.findIndex((reply: Comment) => reply.id === last.id);
  const earlierReplies: number =
    before || thread.replies.length === 0 ? Math.max(0, page.earlierReplies - loadedBefore) : next.earlierReplies;
  const laterReplies: number = before ? later : Math.max(0, page.laterReplies - loadedAfter);
  return { ...next, earlierReplies, replyCount: earlierReplies + next.replies.length + laterReplies };
}

// The author a reply answers; null means a removed comment. A parent that is not loaded comes from `parentAuthor`.
export function replyParent(thread: CommentThread, reply: Comment): Pick<Comment, "author" | "removed"> | null {
  if (!reply.parentId) return null;
  if (reply.parentId === thread.id) return thread;
  const loaded = thread.replies.find((comment: Comment): boolean => comment.id === reply.parentId);
  if (loaded) return loaded;
  return reply.parentAuthor ? { author: reply.parentAuthor, removed: false } : null;
}

// A later page of root comments brings threads with their 2-reply preview. A thread the discussion already shows
// keeps its loaded replies, such as the window of a linked reply or the pages the reader loaded.
export function keepReplyWindows(current: readonly CommentThread[], page: readonly CommentThread[]): CommentThread[] {
  return page.map((thread: CommentThread): CommentThread => {
    const shown: CommentThread | undefined = current.find((value: CommentThread) => value.id === thread.id);
    if (!shown) return thread;
    return { ...thread, replies: shown.replies, earlierReplies: shown.earlierReplies, replyCount: shown.replyCount };
  });
}

// Newest or most liked; ties favor newer comments.
export function orderThreads(threads: readonly CommentThread[], sort: "newest" | "top"): CommentThread[] {
  return [...threads].sort(
    (a: CommentThread, b: CommentThread): number =>
      (sort === "top" ? b.likes - a.likes : 0) || b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  );
}
