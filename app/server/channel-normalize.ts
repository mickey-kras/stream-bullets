import { z } from "zod";
import {
  isLiveMessage,
  MAX_BADGES,
  MAX_FRAGMENTS,
  MAX_TEXT_LENGTH,
  type ActivityChat,
  type ActivityEvent,
  type ActivityFragment,
} from "../lib/activity";
import type { YoutubeMessage } from "./channel-providers.server";

/**
 * Turns verified provider payloads into the activity contract (app/lib/activity.ts). Unknown or malformed
 * payloads give no events. Text is bounded and stripped of control characters; emote URLs are built from ids on
 * an allowed host, never copied from a payload.
 */

// Control and format characters (bidi overrides, zero-width joiners) except tab, which becomes a space.
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Removes control characters and cuts the text to at most `max` UTF-16 code units, which is how the activity
 * schema counts length. The cut never splits a surrogate pair.
 */
export function cleanText(value: string, max: number = MAX_TEXT_LENGTH): string {
  let text = "";
  for (const char of value.replaceAll("\t", " ").replaceAll(CONTROL, "")) {
    if (text.length + char.length > max) break;
    text += char;
  }
  return text;
}

const id = z.union([z.string().regex(/^[\w:.-]{1,128}$/), z.number().int().nonnegative()]).transform(String);
const name = z
  .string()
  .max(200)
  .transform((value: string): string => cleanText(value, 100));
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .optional()
  .catch(undefined);

function parseTime(value: string | undefined | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Joins fragments to the bounded text, keeping at most MAX_FRAGMENTS. */
function boundFragments(fragments: ActivityFragment[]): { text: string; fragments: ActivityFragment[] } {
  const kept: ActivityFragment[] = [];
  let length = 0;
  for (const fragment of fragments) {
    if (kept.length >= MAX_FRAGMENTS || length >= MAX_TEXT_LENGTH) break;
    if (fragment.type === "text") {
      const text = cleanText(fragment.text, MAX_TEXT_LENGTH - length);
      if (!text) continue;
      kept.push({ type: "text", text });
      length += text.length;
    } else {
      // An emote name counts against the same text budget. One that does not fit ends the message.
      if (length + fragment.name.length > MAX_TEXT_LENGTH) break;
      kept.push(fragment);
      length += fragment.name.length;
    }
  }
  return {
    text: kept.map((fragment) => (fragment.type === "text" ? fragment.text : fragment.name)).join(""),
    fragments: kept,
  };
}

const twitchChatSchema = z.object({
  broadcaster_user_id: id,
  chatter_user_id: id,
  chatter_user_login: z.string().max(100),
  chatter_user_name: name,
  message_id: id,
  message: z.object({
    text: z.string().max(4000),
    fragments: z
      .array(
        z.object({
          type: z.string().max(32),
          text: z.string().max(4000),
          emote: z.object({ id: z.string().regex(/^[\w-]{1,64}$/) }).nullish(),
        }),
      )
      .max(500)
      .catch([]),
  }),
  color: z.unknown().optional(),
  badges: z
    .array(z.object({ set_id: z.string().max(64), id: z.string().max(64) }))
    .max(100)
    .catch([]),
});

const twitchTarget = z.object({ target_user_id: id });
const twitchModerate = z.object({
  action: z.string().max(40),
  ban: z.object({ user_id: id }).nullish(),
  timeout: z.object({ user_id: id, expires_at: z.string().max(64) }).nullish(),
  delete: z.object({ message_id: id }).nullish(),
});

function twitchEmoteUrl(emoteId: string): string {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(emoteId)}/default/dark/1.0`;
}

/** Events from one Twitch EventSub notification. `sentAt` is the message timestamp header. */
export function twitchEvents(
  subscriptionType: string,
  event: unknown,
  receivedAt: number,
  sentAt: number | null,
): ActivityEvent[] {
  if (subscriptionType === "channel.chat.message") {
    const parsed = twitchChatSchema.safeParse(event);
    if (!parsed.success) return [];
    const value = parsed.data;
    const raw: ActivityFragment[] = value.message.fragments.length
      ? value.message.fragments.map(
          (fragment): ActivityFragment =>
            fragment.type === "emote" && fragment.emote
              ? {
                  type: "emote",
                  id: fragment.emote.id,
                  name: cleanText(fragment.text, 100),
                  url: twitchEmoteUrl(fragment.emote.id),
                }
              : { type: "text", text: fragment.text },
        )
      : [{ type: "text", text: value.message.text }];
    const { text, fragments } = boundFragments(raw);
    const chat: ActivityChat = {
      kind: "chat",
      id: `twitch:${value.message_id}`,
      platform: "twitch",
      channelId: value.broadcaster_user_id,
      messageId: value.message_id,
      user: {
        id: value.chatter_user_id,
        login: cleanText(value.chatter_user_login, 100),
        displayName: value.chatter_user_name,
        ...(color.parse(value.color) ? { color: color.parse(value.color) } : {}),
      },
      text,
      fragments,
      badges: value.badges
        .slice(0, MAX_BADGES)
        .map((badge) => ({ id: cleanText(badge.set_id, 64), label: cleanText(badge.set_id, 64) })),
      sentAt,
      receivedAt,
      live: isLiveMessage(sentAt, receivedAt),
    };
    return [chat];
  }
  if (subscriptionType === "channel.chat.message_delete") {
    const parsed = z.object({ message_id: id }).safeParse(event);
    return parsed.success
      ? [{ kind: "delete", platform: "twitch", messageId: parsed.data.message_id, receivedAt }]
      : [];
  }
  if (subscriptionType === "channel.chat.clear") return [{ kind: "clear", platform: "twitch", receivedAt }];
  if (subscriptionType === "channel.chat.clear_user_messages") {
    const parsed = twitchTarget.safeParse(event);
    return parsed.success
      ? [{ kind: "clear_user", platform: "twitch", userId: parsed.data.target_user_id, receivedAt }]
      : [];
  }
  if (subscriptionType === "channel.moderate") {
    const parsed = twitchModerate.safeParse(event);
    if (!parsed.success) return [];
    const { action, ban, timeout } = parsed.data;
    if (action === "ban" && ban)
      return [{ kind: "ban", platform: "twitch", userId: ban.user_id, until: null, receivedAt, bannedAt: sentAt }];
    if (action === "timeout" && timeout) {
      const until = parseTime(timeout.expires_at);
      return until === null
        ? []
        : [{ kind: "ban", platform: "twitch", userId: timeout.user_id, until, receivedAt, bannedAt: sentAt }];
    }
    // Deletions and clears also arrive as channel.chat.* events; unbans need no feed change.
  }
  return [];
}

const kickUser = z.object({ user_id: id, username: z.string().max(100), channel_slug: z.string().max(100).optional() });
const kickChatSchema = z.object({
  message_id: id,
  broadcaster: z.object({ user_id: id }),
  sender: kickUser.extend({
    username: name,
    identity: z
      .object({
        username_color: z.unknown().optional(),
        badges: z
          .array(z.object({ text: z.string().max(64), type: z.string().max(64) }))
          .max(100)
          .catch([]),
      })
      .nullish(),
  }),
  content: z.string().max(4000),
  created_at: z.string().max(64).optional(),
});
const kickBanSchema = z.object({
  banned_user: z.object({ user_id: id }),
  metadata: z.object({ created_at: z.string().max(64).nullish(), expires_at: z.string().max(64).nullish() }).catch({}),
});

/** `[emote:123:Name]` in Kick chat text. Kick documents no emote image host, so the feed shows the name. */
const KICK_EMOTE = /\[emote:\d{1,20}:([\w-]{1,100})\]/g;

/** Events from one Kick webhook delivery. */
export function kickEvents(eventType: string, body: unknown, receivedAt: number): ActivityEvent[] {
  if (eventType === "chat.message.sent") {
    const parsed = kickChatSchema.safeParse(body);
    if (!parsed.success) return [];
    const value = parsed.data;
    const { text, fragments } = boundFragments([{ type: "text", text: value.content.replaceAll(KICK_EMOTE, "$1") }]);
    const userColor = color.parse(value.sender.identity?.username_color);
    return [
      {
        kind: "chat",
        id: `kick:${value.message_id}`,
        platform: "kick",
        channelId: value.broadcaster.user_id,
        messageId: value.message_id,
        user: {
          id: value.sender.user_id,
          ...(value.sender.channel_slug ? { login: cleanText(value.sender.channel_slug, 100) } : {}),
          displayName: value.sender.username,
          ...(userColor ? { color: userColor } : {}),
        },
        text,
        fragments,
        badges: (value.sender.identity?.badges ?? [])
          .slice(0, MAX_BADGES)
          .map((badge) => ({ id: cleanText(badge.type, 64), label: cleanText(badge.text, 64) })),
        sentAt: parseTime(value.created_at),
        receivedAt,
        live: isLiveMessage(parseTime(value.created_at), receivedAt),
      },
    ];
  }
  if (eventType === "moderation.banned") {
    const parsed = kickBanSchema.safeParse(body);
    if (!parsed.success) return [];
    return [
      {
        kind: "ban",
        platform: "kick",
        userId: parsed.data.banned_user.user_id,
        until: parseTime(parsed.data.metadata.expires_at),
        receivedAt,
        bannedAt: parseTime(parsed.data.metadata.created_at),
      },
    ];
  }
  return [];
}

/** YouTube flags authors with booleans only; these are the badge ids the feed uses. */
const YOUTUBE_BADGES = [
  ["isChatOwner", "owner", "Owner"],
  ["isChatModerator", "moderator", "Moderator"],
  ["isChatSponsor", "member", "Member"],
  ["isVerified", "verified", "Verified"],
] as const;

/** Events from one page of YouTube live chat messages. */
export function youtubeEvents(
  items: readonly YoutubeMessage[],
  channelId: string,
  receivedAt: number,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const item of items) {
    const { snippet, authorDetails } = item;
    if (snippet.type === "textMessageEvent" && authorDetails) {
      const { text, fragments } = boundFragments([
        { type: "text", text: snippet.textMessageDetails?.messageText ?? snippet.displayMessage ?? "" },
      ]);
      events.push({
        kind: "chat",
        id: `youtube:${item.id}`,
        platform: "youtube",
        channelId,
        messageId: item.id,
        user: { id: authorDetails.channelId, displayName: cleanText(authorDetails.displayName, 100) },
        text,
        fragments,
        badges: YOUTUBE_BADGES.filter(([flag]) => authorDetails[flag] === true).map(([, badgeId, label]) => ({
          id: badgeId,
          label,
        })),
        sentAt: parseTime(snippet.publishedAt),
        receivedAt,
        live: isLiveMessage(parseTime(snippet.publishedAt), receivedAt),
      });
    } else if (snippet.type === "tombstone") {
      // Not documented in detail: a tombstone is taken to replace the deleted message under the same id.
      events.push({ kind: "delete", platform: "youtube", messageId: item.id, receivedAt });
    } else if (snippet.type === "messageDeletedEvent" && snippet.messageDeletedDetails) {
      events.push({
        kind: "delete",
        platform: "youtube",
        messageId: snippet.messageDeletedDetails.deletedMessageId,
        receivedAt,
      });
    } else if (snippet.type === "userBannedEvent" && snippet.userBannedDetails) {
      const details = snippet.userBannedDetails;
      const temporary = details.banType === "temporary" && details.banDurationSeconds !== undefined;
      events.push({
        kind: "ban",
        platform: "youtube",
        userId: details.bannedUserDetails.channelId,
        until: temporary
          ? (parseTime(snippet.publishedAt) ?? receivedAt) + (details.banDurationSeconds ?? 0) * 1000
          : null,
        receivedAt,
        bannedAt: parseTime(snippet.publishedAt),
      });
    }
  }
  return events;
}
