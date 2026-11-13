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
export function readDraft(key: string): DiscussionDraft {
  const empty: DiscussionDraft = {
    text: "",
    mentions: [],
    replyText: "",
    replyMentions: [],
    replyId: null,
  };
  if (typeof sessionStorage === "undefined") return empty;
  try {
    const value = sessionStorage.getItem(key);
    if (!value) return empty;
    const result = draftSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : empty;
  } catch {
    return empty;
  }
}
