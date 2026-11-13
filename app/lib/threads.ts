import type { Comment, CommentThread } from "../types";

// Initial visible reply count.
export const VISIBLE_REPLIES = 2;

// Flatten replies under the root, oldest first, at one indent level.
export function orderReplies(replies: readonly Comment[]): Comment[] {
  return [...replies].sort((a: Comment, b: Comment): number => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

// Show two replies until expanded; return the hidden count.
export function visibleReplies(replies: readonly Comment[], expanded: boolean): { shown: Comment[]; hidden: number } {
  const ordered = orderReplies(replies);
  const shown = expanded ? ordered : ordered.slice(0, VISIBLE_REPLIES);
  return { shown, hidden: ordered.length - shown.length };
}

// Parent author for the reply link; null means a removed comment.
export function replyParent(thread: CommentThread, reply: Comment): Comment | null {
  if (!reply.parentId) return null;
  if (reply.parentId === thread.id) return thread;
  return thread.replies.find((comment: Comment): boolean => comment.id === reply.parentId) ?? null;
}

// Newest or most liked; ties favor newer comments.
export function orderThreads(threads: readonly CommentThread[], sort: "newest" | "top"): CommentThread[] {
  return [...threads].sort(
    (a: CommentThread, b: CommentThread): number =>
      (sort === "top" ? b.likes - a.likes : 0) || b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  );
}
