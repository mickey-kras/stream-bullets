import { useId, type ReactNode } from "react";
import { intlLocale, t, type MessageId } from "../../i18n";
import type { ActivityPlatform } from "../../lib/activity";
import { supportAnswerSchema, type ChannelView, type SupportAnswer } from "../../lib/channel-health";
import { ApiError, postJson } from "../api";
import { PLATFORM_NAMES } from "../overlay/wasteland/theme";
import { Icon } from "../ui/icon";

/** What the support events of each platform are (docs/channel-connections.md). */
const SUPPORT_READS: Readonly<Record<ActivityPlatform, MessageId>> = {
  twitch: "channels.support.reads.twitch",
  youtube: "channels.support.reads.youtube",
  kick: "channels.support.reads.kick",
};

/** The provider permissions for support events, in plain words. */
const SCOPE_NAMES: Readonly<Record<string, MessageId>> = {
  "moderator:read:followers": "channels.support.scope.followers",
  "channel:read:subscriptions": "channels.support.scope.subscriptions",
  "bits:read": "channels.support.scope.bits",
};

/**
 * The permissions that the provider asks for, as one list in words, or null when it asks for none. A permission
 * that this version does not know shows as the provider names it.
 */
export function supportPermissions(scopes: readonly string[]): string | null {
  if (scopes.length === 0) return null;
  const names: string[] = scopes.map((scope: string): string =>
    Object.hasOwn(SCOPE_NAMES, scope) ? t(SCOPE_NAMES[scope]) : scope,
  );
  return new Intl.ListFormat(intlLocale(), { type: "conjunction" }).format(names);
}

/** Asks the server to turn the support events of a channel on or off. An answer that is not valid is a failure. */
export async function changeSupport(platform: ActivityPlatform, on: boolean): Promise<SupportAnswer> {
  const answer = supportAnswerSchema.safeParse(await postJson<unknown>(`/api/channels/${platform}/support`, { on }));
  if (!answer.success) throw new ApiError(t("common.failed"), 200, null);
  return answer.data;
}

/**
 * What the card does with the answer to a change. With a `url`, the browser goes to the provider, and the callback
 * turns the support events on. Without one, the switch shows the state of the answer. `denied`: the streamer turned
 * the switch on, and the provider refused the support events.
 */
export type SupportOutcome = { url: string } | { url: null; support: boolean; denied: boolean };

export function supportOutcome(answer: SupportAnswer, on: boolean): SupportOutcome {
  if (answer.url !== null) return { url: answer.url };
  return { url: null, support: answer.support, denied: on && !answer.support };
}

/**
 * The switch for the support events of one connected channel, with what the events are. While the switch is off,
 * the card names the permissions that the provider asks for. Only Twitch asks for new permissions.
 */
export function SupportSwitch({
  channel,
  on,
  busy,
  denied,
  onChange,
}: Readonly<{
  channel: ChannelView;
  on: boolean;
  /** A change of a channel runs: the switch takes no change. */
  busy: boolean;
  /** The provider refused the support events when the streamer turned the switch on. */
  denied: boolean;
  onChange: (on: boolean) => void;
}>): ReactNode {
  const noteId: string = useId();
  const platform: string = PLATFORM_NAMES[channel.platform];
  const permissions: string | null = on ? null : supportPermissions(channel.supportScopes);
  return (
    <div className="ch-support">
      <label className="choice">
        <input
          type="checkbox"
          checked={on}
          // Not the `disabled` attribute: a disabled control loses the keyboard focus.
          aria-disabled={busy || undefined}
          aria-describedby={noteId}
          onChange={(event) => {
            if (!busy) onChange(event.currentTarget.checked);
          }}
          data-support-switch
        />
        <span>{t("channels.support.label", { platform })}</span>
      </label>
      <p className="muted" id={noteId}>
        {t(SUPPORT_READS[channel.platform])}
        {permissions && ` ${t("channels.support.permissions", { platform, permissions })}`}
      </p>
      {denied && (
        <p className="ch-problem" role="alert">
          <Icon name="warning" size={16} />
          <span>{t("channels.result.supportDenied", { platform })}</span>
        </p>
      )}
    </div>
  );
}
