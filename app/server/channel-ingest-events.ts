import {
  MAX_ACTIVITY_MESSAGE_LENGTH,
  isSupport,
  type ActivityChat,
  type ActivityEvent,
  type ActivitySupport,
  type IngestEvent,
} from "../lib/activity";

/**
 * The content key of a ban: the same user, end and ban time is one ban, so copies match while a new ban after an
 * unban (a new ban time) does not.
 */
export function banKey(event: Extract<ActivityEvent, { kind: "ban" }>): string {
  return `ban:${event.platform}:${event.userId}:${event.until ?? "perm"}:${event.bannedAt ?? ""}`;
}

/** `events` without the support events: a connection that does not read them stores and sends none. */
export function withoutSupport(events: readonly IngestEvent[]): IngestEvent[] {
  return events.filter((event: IngestEvent): boolean => !isSupport(event));
}

/**
 * The kept chat messages and support events of a snapshot in the order of their receive times. Each list keeps its
 * own order: a support event goes before the first message that the server received after it.
 */
export function snapshotEvents(chats: readonly ActivityChat[], support: readonly ActivitySupport[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  let next = 0;
  for (const chat of chats) {
    while (next < support.length && support[next].receivedAt < chat.receivedAt) events.push(support[next++]);
    events.push(chat);
  }
  return [...events, ...support.slice(next)];
}

/**
 * The snapshot as one socket message. The oldest events are left out until it fits the consumer's message limit,
 * so a reconnecting consumer always gets the newest history.
 *
 * `since` is a receive time: the snapshot has each kept message that is newer. A message that is left out moves it
 * forward. A consumer reads a newer message of its own that the snapshot does not have as moderated. A support
 * event that is left out never moves `since`: no moderation removes a support event.
 */
export function snapshotMessage(events: readonly ActivityEvent[], since: number): string {
  let start = 0;
  let message = JSON.stringify({ type: "snapshot", events, replay: true, since });
  while (message.length > MAX_ACTIVITY_MESSAGE_LENGTH && start < events.length) {
    start += Math.max(1, Math.ceil((events.length - start) / 10));
    const left: number[] = events
      .slice(0, start)
      .map((event: ActivityEvent): number => (event.kind === "chat" ? event.receivedAt : 0));
    message = JSON.stringify({
      type: "snapshot",
      events: events.slice(start),
      replay: true,
      since: Math.max(since, ...left),
    });
  }
  return message;
}

/** Expired timeouts still clear messages, but must not announce an active ban. */
export function eventForBroadcast(event: ActivityEvent, now: number): ActivityEvent {
  if (event.kind === "ban" && event.until !== null && event.until <= now)
    return {
      kind: "clear_user",
      platform: event.platform,
      userId: event.userId,
      receivedAt: event.receivedAt,
    };
  return event;
}
