import type { Comment, CommentThread } from "../types";

/** Replies shown under a comment before "View N more replies" (item 40). */
export const VISIBLE_REPLIES = 2;

/** Replies sit under their thread's top-level comment, oldest first, one indent level. */
export function orderReplies(replies: readonly Comment[]): Comment[] {
  return [...replies].sort((a: Comment, b: Comment): number => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** The replies to render: the first two unless the thread is expanded, and how many stay hidden. */
export function visibleReplies(replies: readonly Comment[], expanded: boolean): { shown: Comment[]; hidden: number } {
  const ordered = orderReplies(replies);
  const shown = expanded ? ordered : ordered.slice(0, VISIBLE_REPLIES);
  return { shown, hidden: ordered.length - shown.length };
}

/**
 * Who a reply answers, for its "Reply to {name}" link: the parent's author, or null when the parent is a
 * removed comment (the caller then says "a removed comment").
 */
export function replyParent(thread: CommentThread, reply: Comment): Comment | null {
  if (!reply.parentId) return null;
  if (reply.parentId === thread.id) return thread;
  return thread.replies.find((comment: Comment): boolean => comment.id === reply.parentId) ?? null;
}

/** The top-level comments in display order: newest or most liked first, ties newest first. */
export function orderThreads(threads: readonly CommentThread[], sort: "newest" | "top"): CommentThread[] {
  return [...threads].sort(
    (a: CommentThread, b: CommentThread): number =>
      (sort === "top" ? b.likes - a.likes : 0) || b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  );
}

