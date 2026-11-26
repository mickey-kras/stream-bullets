import type { ActivityEvent, ActivityPlatform } from "./activity";
import { SAMPLE_CHAT } from "./chat-feed";

/**
 * The chat test (issue #663): a dry run of the chat layer in OBS. The owner starts it in Streamer tools. The server
 * keeps only its end time; each overlay page makes the sample chat itself. Nothing goes to a provider.
 */

/** How long a chat test runs. The characters test (#664) will use its own, longer time. */
export const CHAT_TEST_MS = 60_000;

/** The timeout of the sample timeout event. */
const SAMPLE_TIMEOUT_MS = 600_000;

const deleted = SAMPLE_CHAT[3];
const timedOut = SAMPLE_CHAT[8];

/**
 * What a test plays, one event at a time, on a loop: chat from all three platforms, a deleted message and a timeout.
 * The player sets the times when it sends an event. The `until` of the ban is the length of the timeout.
 */
export const CHAT_TEST_SCRIPT: readonly ActivityEvent[] = [
  ...SAMPLE_CHAT.slice(0, 4),
  { kind: "delete", platform: deleted.platform, messageId: deleted.messageId, receivedAt: 0 },
  ...SAMPLE_CHAT.slice(4),
  { kind: "ban", platform: timedOut.platform, userId: timedOut.user.id, until: SAMPLE_TIMEOUT_MS, receivedAt: 0 },
];

/** What a test plays on an output that shows `platform` only. Null: the whole script. */
export function chatTestScript(platform: ActivityPlatform | null): readonly ActivityEvent[] {
  if (platform === null) return CHAT_TEST_SCRIPT;
  return CHAT_TEST_SCRIPT.filter((event: ActivityEvent): boolean => event.platform === platform);
}

/** Milliseconds left in a test that ends at `until` (server time), at server time `now`. Zero when it is off. */
export function chatTestLeft(until: number, now: number): number {
  return Math.max(0, Math.min(until - now, CHAT_TEST_MS));
}
