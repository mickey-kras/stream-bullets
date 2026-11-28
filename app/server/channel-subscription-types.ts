import type { ActivityPlatform } from "../lib/activity";
import { KICK_SUPPORT_EVENTS, twitchSupportSubscriptions, type TwitchSubscription } from "./channel-support";

/** The provider subscription types that a channel connection needs, for the connect and for the repair. */

/** The Twitch EventSub types the feed uses, with their condition: chat first, then support when `support` is true. */
export function twitchSubscriptions(broadcaster: string, support: boolean): TwitchSubscription[] {
  const chat = { broadcaster_user_id: broadcaster, user_id: broadcaster };
  const moderator = { broadcaster_user_id: broadcaster, moderator_user_id: broadcaster };
  return [
    { type: "channel.chat.message", version: "1", condition: chat },
    { type: "channel.chat.message_delete", version: "1", condition: chat },
    { type: "channel.chat.clear", version: "1", condition: chat },
    { type: "channel.chat.clear_user_messages", version: "1", condition: chat },
    { type: "channel.moderate", version: "2", condition: moderator },
    ...(support ? twitchSupportSubscriptions(broadcaster) : []),
  ];
}

export const KICK_EVENTS: readonly string[] = ["chat.message.sent", "moderation.banned"];

/** The types a healthy channel has at its provider. YouTube has none: its chat, with the support, is polled. */
export function requiredSubscriptions(platform: ActivityPlatform, support: boolean): readonly string[] {
  if (platform === "youtube") return [];
  if (platform === "kick") return support ? [...KICK_EVENTS, ...KICK_SUPPORT_EVENTS] : KICK_EVENTS;
  return twitchSubscriptions("", support).map((subscription: TwitchSubscription): string => subscription.type);
}
