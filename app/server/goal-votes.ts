import { z } from "zod";

/**
 * The count of a goal that counts `votes` (issue #1043, docs/channel-connections.md): a poll vote and a new topic.
 * The API sends one key for each of them to the alert host of the page, with the internal request `/goal-count` of
 * the ChannelIngest object. The owner route and the dock route of the alerts never accept this request.
 *
 * A key names what counts one time. A vote has the entry and the voter, so a changed vote counts one time. A topic
 * has the entry. The alert host keeps a hash of the key, and never the key: the user ID goes no further.
 */

const ENTRY_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const USER_ID = "[A-Za-z0-9_-]{1,128}";
const COUNT_KEY = new RegExp(`^(?:vote:${ENTRY_ID}:${USER_ID}|topic:${ENTRY_ID})$`, "i");

/** The body of `/goal-count`. */
export const goalCountSchema = z.object({ op: z.literal("count"), key: z.string().max(200).regex(COUNT_KEY) }).strict();
export type GoalCountRequest = z.infer<typeof goalCountSchema>;

/** The key of the vote of one viewer in one poll: a changed vote has the same key. */
export function voteKey(entryId: string, userId: string): string {
  return `vote:${entryId}:${userId}`;
}

/** The key of a new topic. */
export function topicKey(entryId: string): string {
  return `topic:${entryId}`;
}
