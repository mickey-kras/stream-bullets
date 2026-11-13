import { z } from "zod";
import type { CommentMention as MentionSelection } from "../types";

export interface DiscussionDraft {
  text: string;
  mentions: MentionSelection[];
  replyText: string;
  replyMentions: MentionSelection[];
  replyId: string | null;
}
export const draftSchema = z.object({
  text: z.string().max(2000),
  mentions: z
    .array(
      z.object({
        userId: z.string().min(1).max(128),
        start: z.number().int().min(0),
        end: z.number().int().max(2000),
      }),
    )
    .max(5),
  replyText: z.string().max(2000),
  replyMentions: z
    .array(
      z.object({
        userId: z.string().min(1).max(128),
        start: z.number().int().min(0),
        end: z.number().int().max(2000),
      }),
    )
    .max(5),
  replyId: z.string().uuid().nullable(),
});
export function readDraft(key: string): { draft: DiscussionDraft; unavailable: boolean } {
  const empty: DiscussionDraft = {
    text: "",
    mentions: [],
    replyText: "",
    replyMentions: [],
    replyId: null,
  };
  try {
    if (typeof sessionStorage === "undefined") return { draft: empty, unavailable: false };
    const value = sessionStorage.getItem(key);
    if (!value) return { draft: empty, unavailable: false };
    const result = draftSchema.safeParse(JSON.parse(value));
    return { draft: result.success ? result.data : empty, unavailable: !result.success };
  } catch {
    return { draft: empty, unavailable: true };
  }
}

interface DraftSnapshot {
  draft: DiscussionDraft;
  unavailable: boolean;
}
export interface DiscussionDraftStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => DraftSnapshot;
  getServerSnapshot: () => DraftSnapshot;
  update: (change: Partial<DiscussionDraft>) => void;
}

export function createDraftStore(key: string): DiscussionDraftStore {
  let current: DraftSnapshot | undefined;
  const server: DraftSnapshot = {
    draft: { text: "", mentions: [], replyText: "", replyMentions: [], replyId: null },
    unavailable: false,
  };
  const listeners = new Set<() => void>();
  const getSnapshot = (): DraftSnapshot => (current ??= readDraft(key));
  return {
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot,
    getServerSnapshot: (): DraftSnapshot => server,
    update: (change: Partial<DiscussionDraft>): void => {
      const draft: DiscussionDraft = { ...getSnapshot().draft, ...change };
      let unavailable = false;
      try {
        sessionStorage.setItem(key, JSON.stringify(draft));
      } catch {
        unavailable = true;
      }
      current = { draft, unavailable };
      for (const listener of listeners) listener();
    },
  };
}
