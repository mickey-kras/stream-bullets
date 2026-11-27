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
  replyCount: number;
}

// Adds a page of replies with the counts the server sent: the replies now in the thread, and the ones before the
// first loaded reply. An empty page shows that nothing more lies in its direction.
export function withPage(thread: CommentThread, page: ReplyPage, before: boolean): CommentThread {
  const next: CommentThread = withReplies(thread, page.replies, before);
  if (page.earlierReplies === null || page.replies.length === 0) {
    if (before) return { ...next, earlierReplies: 0, replyCount: Math.max(page.replyCount, next.replies.length) };
    return { ...next, replyCount: next.earlierReplies + next.replies.length };
  }
  const loadedBefore: number = next.replies.findIndex((reply: Comment) => reply.id === page.replies[0].id);
  return {
    ...next,
    earlierReplies: Math.max(0, page.earlierReplies - Math.max(0, loadedBefore)),
    replyCount: page.replyCount,
  };
}

// The author a reply answers; null means a removed comment. A parent that is not loaded comes from `parentAuthor`.
export function replyParent(thread: CommentThread, reply: Comment): Pick<Comment, "author" | "removed"> | null {
  if (!reply.parentId) return null;
  if (reply.parentId === thread.id) return thread;
  const loaded = thread.replies.find((comment: Comment): boolean => comment.id === reply.parentId);
  if (loaded) return loaded;
  return reply.parentAuthor ? { author: reply.parentAuthor, removed: false } : null;
}

// Newest or most liked; ties favor newer comments.
export function orderThreads(threads: readonly CommentThread[], sort: "newest" | "top"): CommentThread[] {
  return [...threads].sort(
    (a: CommentThread, b: CommentThread): number =>
      (sort === "top" ? b.likes - a.likes : 0) || b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  );
}
