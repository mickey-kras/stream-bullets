import { MAX_ACTIVITY_MESSAGE_LENGTH, type ActivityChat, type ActivityEvent } from "../lib/activity";

/**
 * The content key of a ban: the same user, end and ban time is one ban, so copies match while a new ban after an
 * unban (a new ban time) does not.
 */
export function banKey(event: Extract<ActivityEvent, { kind: "ban" }>): string {
  return `ban:${event.platform}:${event.userId}:${event.until ?? "perm"}:${event.bannedAt ?? ""}`;
}

/**
 * The snapshot as one socket message. The oldest messages are left out until it fits the consumer's message limit,
 * so a reconnecting consumer always gets the newest history.
 */
export function snapshotMessage(events: readonly ActivityChat[]): string {
  let start = 0;
  let message = JSON.stringify({ type: "snapshot", events, replay: true });
  while (message.length > MAX_ACTIVITY_MESSAGE_LENGTH && start < events.length) {
    start += Math.max(1, Math.ceil((events.length - start) / 10));
    message = JSON.stringify({ type: "snapshot", events: events.slice(start), replay: true });
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
