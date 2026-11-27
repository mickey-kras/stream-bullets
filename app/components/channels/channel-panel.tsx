import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useRevalidator } from "react-router";
import { intlLocale, t, type MessageId } from "../../i18n";
import { quotaDay, type ActivityPlatform, type ChannelStatusCode, type ConnectResult } from "../../lib/activity";
import { channelCardState, relativeAge, type ChannelCardState, type ChannelView } from "../../lib/channel-health";
import type { Provider } from "../../types";
import { ApiError, errorMessage, postJson, sendJson } from "../api";
import { providerName, Reauthenticate } from "../shell/sign-in-dialog";
import { Dialog, DialogActions } from "../ui/dialog";
import { Icon, type IconName } from "../ui/icon";
import { useToast } from "../ui/toast";
import { paths, toolsPath, useShell } from "../../lib/shell";
import { detached } from "../../lib/detached";
import { PlatformIcon } from "../overlay/wasteland/glyphs";

export type { ChannelView } from "../../lib/channel-health";

/** How often the age of the last chat event changes in the tooltip of the status icon. */
const AGE_TICK_MS = 15_000;

/** Brand names stay as they are in every language. */
export const PLATFORM_NAMES: Readonly<Record<ActivityPlatform, string>> = {
  twitch: "Twitch",
  youtube: "YouTube",
  kick: "Kick",
};

/** The callback's result codes and their messages. */
const RESULT_MESSAGES: Readonly<Record<ConnectResult, MessageId>> = {
  connected: "channels.result.connected",
  denied: "channels.result.denied",
  state_invalid: "channels.result.stateInvalid",
  session_mismatch: "channels.result.sessionMismatch",
  channel_taken: "channels.result.channelTaken",
  disconnect_first: "channels.result.disconnectFirst",
  scope_missing: "channels.result.scopeMissing",
  support_denied: "channels.result.supportDenied",
  failed: "channels.result.failed",
};

/** Status codes the ingest object writes, with what the owner can do about each. */
const STATUS_MESSAGES: Readonly<Record<ChannelStatusCode, MessageId>> = {
  authorization_revoked: "channels.status.revoked",
  // Not used: statusMessage builds the quota message itself, with the reset time when it is still ahead.
  quota_exhausted: "channels.status.quotaReset",
  subscribe_failed: "channels.status.subscribeFailed",
  delivery_failed: "channels.status.deliveryFailed",
  subscription_removed: "channels.status.subscriptionRemoved",
  webhooks_rejected: "channels.status.webhooksRejected",
  disconnecting: "channels.status.error",
};

/**
 * The closed details of each card (docs/channel-connections.md): when chat starts, what the feed reads for chat and
 * for alerts and goals, then the limits and the gaps.
 */
const NOTES: Readonly<Record<ActivityPlatform, readonly MessageId[]>> = {
  twitch: [
    "channels.starts.connected",
    "channels.reads.twitch",
    "channels.readsSupport.twitch",
    "channels.emotes.twitch",
    "channels.twitchReconnect",
  ],
  youtube: [
    "channels.starts.overlay",
    "channels.reads.youtube",
    "channels.readsSupport.youtube",
    "channels.limits.youtube",
    "channels.gaps.youtube",
  ],
  kick: [
    "channels.starts.connected",
    "channels.reads.kick",
    "channels.readsSupport.kick",
    "channels.emotes.kick",
    "channels.gaps.kick",
  ],
};

/**
 * What the card of a connection without support events says. Only Twitch needs permissions for them: a Twitch
 * channel from before the support events has none.
 */
const SUPPORT_MISSING: Readonly<Record<ActivityPlatform, MessageId>> = {
  twitch: "channels.supportMissing.twitch",
  youtube: "channels.supportMissing.other",
  kick: "channels.supportMissing.other",
};

/** The icon of each card state: never colour alone. Its tooltip and its text for screen readers hold the words. */
const STATE_ICONS: Readonly<Record<ChannelCardState, IconName>> = {
  healthy: "success",
  repairing: "sync",
  problem: "rejected",
  support_missing: "rejected",
};

/** A change that needs a recent sign-in. The owner signs in again, then the page takes the change up again. */
export interface ChannelIntent {
  platform: ActivityPlatform;
  action: "connect" | "disconnect";
}

/** What the sign-in prompt of each change says. */
const REAUTH_MESSAGES: Readonly<Record<ChannelIntent["action"], MessageId>> = {
  connect: "channels.reauth.connect",
  disconnect: "channels.reauth.disconnect",
};

const INTENT_KEY = "sb-channel-intent";
/** As long as an authorization state lives: an older intent is not the owner's wish any more. */
const INTENT_MS = 10 * 60 * 1000;

/**
 * The intent that the session storage holds, or null for a missing, malformed or old value. The storage belongs
 * to this origin and this tab, so no link from another site can set an intent.
 */
export function parseIntent(raw: string | null, now: number, owner: string | null): ChannelIntent | null {
  if (raw === null || owner === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { platform, action, at, owner: storedOwner } = value as Record<string, unknown>;
  // Another account can sign in during the prompt. Its page must not get the channel of the first owner.
  if (storedOwner !== owner) return null;
  if (typeof platform !== "string" || !isPlatform(platform)) return null;
  if (action !== "connect" && action !== "disconnect") return null;
  if (typeof at !== "number" || at > now || now - at > INTENT_MS) return null;
  return { platform, action };
}

function rememberIntent(intent: ChannelIntent, owner: string | null): void {
  if (owner === null) return;
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify({ ...intent, owner, at: Date.now() }));
  } catch {
    // Without storage, the owner selects the button again after the sign-in.
  }
}

/** Reads the intent once: a reload does not take it up again. */
function takeIntent(owner: string | null): ChannelIntent | null {
  try {
    const raw: string | null = sessionStorage.getItem(INTENT_KEY);
    sessionStorage.removeItem(INTENT_KEY);
    return parseIntent(raw, Date.now(), owner);
  } catch {
    return null;
  }
}

function isPlatform(value: string | null): value is ActivityPlatform {
  return value !== null && Object.hasOwn(PLATFORM_NAMES, value);
}

/** The message for a callback result, or null for an unknown code or platform. */
export function resultMessage(platform: string | null, result: string | null): string | null {
  if (!isPlatform(platform) || result === null || !Object.hasOwn(RESULT_MESSAGES, result)) return null;
  return t(RESULT_MESSAGES[result as ConnectResult], { platform: PLATFORM_NAMES[platform] });
}

/**
 * What the owner should know about a connection that is not healthy, or null when it is. `quotaReset` is the
 * time the YouTube quota resets, in the viewer's time zone, or null when that reset already passed. A YouTube
 * connection that needs a new authorization also says that it goes after 7 days.
 */
export function statusMessage(
  connection: NonNullable<ChannelView["connection"]>,
  quotaReset: string | null,
  platform: ActivityPlatform,
): string | null {
  if (connection.status === "active") return null;
  const code = connection.code;
  if (code === "quota_exhausted")
    return quotaReset ? t("channels.status.quota", { time: quotaReset }) : t("channels.status.quotaReset");
  if (
    platform === "youtube" &&
    connection.status === "needs_reauth" &&
    (code === null || code === "authorization_revoked")
  )
    return t("channels.status.revokedYoutube");
  if (code !== null && Object.hasOwn(STATUS_MESSAGES, code)) return t(STATUS_MESSAGES[code as ChannelStatusCode]);
  return t(connection.status === "needs_reauth" ? "channels.status.revoked" : "channels.status.error");
}

function noSubscription(): () => void {
  return (): void => undefined;
}

/** False during the server render and hydration: times render in the viewer's own time zone only after it. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    (): boolean => true,
    (): boolean => false,
  );
}

/**
 * When the YouTube quota of the day the status began resets (midnight Pacific Time), in the viewer's own time
 * zone, or null when it already did: polls then resume when an overlay connects.
 */
function quotaResetText(statusAt: number): string | null {
  const resetAt = quotaDay(statusAt).resetAt;
  if (resetAt <= Date.now()) return null;
  return new Intl.DateTimeFormat(intlLocale(), { weekday: "short", hour: "numeric", minute: "2-digit" }).format(
    new Date(resetAt),
  );
}

/**
 * The problem of a connection in words, or null for a healthy one. A platform that this site does not offer
 * cannot be reconnected, so its status advice would mislead.
 */
export function channelProblem(channel: ChannelView): string | null {
  const connection = channel.connection;
  if (!connection || !channel.available) return null;
  const quotaReset: string | null = connection.code === "quota_exhausted" ? quotaResetText(connection.updatedAt) : null;
  return statusMessage(connection, quotaReset, channel.platform);
}

/** The sentence about the last chat event of a connection at the time `now`. */
export function lastEventText(at: number | null, now: number): string {
  if (at === null) return t("channels.noEvent");
  const age: string | null = relativeAge(at, now, intlLocale());
  return age === null ? t("channels.lastEventNow") : t("channels.lastEvent", { age });
}

/**
 * The words of the status icon of a card: its tooltip and its text for screen readers. `now` is the viewer's
 * clock, or null during the server render and hydration. A text that needs the viewer's clock or time zone waits
 * for it: the age of the last chat event, and the reset time of the YouTube quota.
 */
export function stateText(channel: ChannelView, state: ChannelCardState, now: number | null): string {
  const platform: string = PLATFORM_NAMES[channel.platform];
  if (state === "support_missing") return t(SUPPORT_MISSING[channel.platform], { platform });
  if (state === "healthy") {
    const at: number | null = channel.connection?.lastEventAt ?? null;
    if (at !== null && now === null) return t("channels.health.healthy");
    return t("channels.health.healthyEvent", { event: lastEventText(at, now ?? 0) });
  }
  const waitsForTime: boolean = channel.connection?.code === "quota_exhausted" && now === null;
  return (waitsForTime ? null : channelProblem(channel)) ?? t("channels.health.attention");
}

/**
 * The status of a connected card: an icon with a tooltip. The same words are text that only a screen reader reads,
 * so the status has an accessible name without a line of text on the card.
 */
function StateIcon({ state, label }: Readonly<{ state: ChannelCardState; label: string }>): ReactNode {
  return (
    <span className="ch-state" data-state={state} title={label}>
      {/* A problem that ends without the owner turns. It stays still for a viewer who asked for less motion. */}
      <Icon name={STATE_ICONS[state]} size={20} className={state === "repairing" ? "ch-turn" : ""} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Streamer controls for the channel connections (docs/channel-connections.md): one card for each platform, with
 * its status, connect, reconnect and disconnect. Connecting leaves for the provider and comes back with
 * `?channel=&result=`. The panel then shows and announces the result, and removes it from the address.
 */
export function ChannelPanel({
  channels,
  stale = false,
  providers,
  signInProvider,
  result: initialResult,
}: Readonly<{
  channels: ChannelView[];
  /** The last reads of the channels failed, so the status on screen can be old. */
  stale?: boolean;
  providers: Provider[];
  signInProvider: Provider | null;
  result: string | null;
}>): ReactNode {
  const toast = useToast();
  // The page that gets the channel. A stored intent is valid only for this owner.
  const owner: string | null = useShell().ownStreamer?.handle ?? null;
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const location = useLocation();
  const panel = useRef<HTMLDivElement>(null);
  const banner = useRef<HTMLOutputElement>(null);
  const resultShown = useRef<boolean>(false);
  const [result, setResult] = useState<string | null>(initialResult);
  const [busy, setBusy] = useState<ActivityPlatform | null>(null);
  const [confirming, setConfirming] = useState<ActivityPlatform | null>(null);
  /** The change that the server refused because the sign-in is too old. Its card shows the sign-in prompt. */
  const [reauth, setReauth] = useState<ChannelIntent | null>(null);
  const resumed = useRef<boolean>(false);
  /** Platforms whose last disconnect the provider did not confirm: the owner should remove the app there. */
  const [unrevoked, setUnrevoked] = useState<ReadonlySet<ActivityPlatform>>(new Set());
  // The platform of the last disconnect. Until the next dialog opens, the closed dialog does not take focus back.
  const [focusConnect, setFocusConnect] = useState<ActivityPlatform | null>(null);
  /** The platform whose Connect button waits for focus. */
  const awaitingConnect = useRef<ActivityPlatform | null>(null);
  const hydrated = useHydrated();
  const [now, setNow] = useState<number>((): number => Date.now());

  // One timer moves the age in the tooltip of every card.
  useEffect((): (() => void) => {
    const timer = setInterval((): void => setNow(Date.now()), AGE_TICK_MS);
    return (): void => clearInterval(timer);
  }, []);

  // The result of a callback: show it in view and give it focus, so it is read once (the banner is a status
  // region; no toast repeats it). Then take it out of the address, so a reload or a shared link does not show it
  // again. The message stays in this state.
  useEffect((): void => {
    if (!initialResult || resultShown.current) return;
    resultShown.current = true;
    document.getElementById("channels-title")?.scrollIntoView({ block: "start" });
    banner.current?.focus();
    const search = new URLSearchParams(location.search);
    search.delete("channel");
    search.delete("result");
    detached(
      navigate({ pathname: location.pathname, search: search.toString() }, { replace: true, preventScrollReset: true }),
    );
  }, [initialResult, location.pathname, location.search, navigate]);

  // Coming back to the page from the back-forward cache (after the provider) must not leave buttons disabled.
  useEffect((): (() => void) => {
    function shown(event: PageTransitionEvent): void {
      if (event.persisted) setBusy(null);
    }
    globalThis.addEventListener("pageshow", shown);
    return (): void => globalThis.removeEventListener("pageshow", shown);
  }, []);

  // After a disconnect, focus moves to the platform's Connect button once the reloaded list shows the card without
  // its connection. Without a Connect button (the platform is not offered), it goes to the section heading.
  useEffect((): void => {
    const platform = awaitingConnect.current;
    if (!platform) return;
    const title = document.getElementById("channels-title");
    // The list still shows the connection: the dialog and its opener go away, so focus waits on the section heading.
    // Decide from the list on screen, not from the reload state. A busy browser can skip the loading state, and
    // the router can show the new list before or after the reload ends.
    if (channels.find((channel) => channel.platform === platform)?.connection) {
      if (document.activeElement === document.body) title?.focus();
      return;
    }
    // The list shows the card without its connection: focus Connect when the card offers it, else the heading.
    awaitingConnect.current = null;
    const button = panel.current?.querySelector<HTMLButtonElement>(`[data-channel="${platform}"] [data-connect]`);
    (button ?? title)?.focus();
  }, [channels, focusConnect]);

  function focusConnectAfterReload(platform: ActivityPlatform): void {
    awaitingConnect.current = platform;
    setFocusConnect(platform);
  }

  function failed(error: unknown, intent: ChannelIntent): void {
    if (error instanceof ApiError && error.code === "reauth_required") setReauth(intent);
    else toast(errorMessage(error), { tone: "error" });
  }

  async function connect(platform: ActivityPlatform, reconnect: boolean): Promise<void> {
    setResult(null);
    setReauth(null);
    setBusy(platform);
    try {
      const { authorizeUrl } = await postJson<{ authorizeUrl: string }>(
        `/api/channels/${platform}/${reconnect ? "reconnect" : "connect"}`,
        {},
      );
      globalThis.location.assign(authorizeUrl);
    } catch (error: unknown) {
      failed(error, { platform, action: "connect" });
      setBusy(null);
    }
  }

  // Back from the sign-in that a change needed: take the change up again. A connect goes on to the provider
  // without a second click. A disconnect is not repeated by itself: its button gets focus.
  useEffect((): void => {
    if (resumed.current) return;
    resumed.current = true;
    const intent: ChannelIntent | null = takeIntent(owner);
    const channel = intent && channels.find((item: ChannelView): boolean => item.platform === intent.platform);
    if (!intent || !channel?.available || initialResult) return;
    // After the effect: the connect sets the busy state.
    if (intent.action === "connect") {
      const reconnect: boolean = channel.connection !== null;
      queueMicrotask((): void => detached(connect(intent.platform, reconnect)));
    } else {
      panel.current?.querySelector<HTMLElement>(`[data-channel="${intent.platform}"] [data-disconnect]`)?.focus();
    }
  });

  async function disconnect(platform: ActivityPlatform): Promise<void> {
    setResult(null);
    setReauth(null);
    setBusy(platform);
    try {
      const { revoked } = await sendJson<{ revoked: boolean }>("DELETE", `/api/channels/${platform}`);
      const name = PLATFORM_NAMES[platform];
      toast(
        revoked ? t("channels.disconnected", { platform: name }) : t("channels.revokeUnconfirmed", { platform: name }),
      );
      setUnrevoked((current) => {
        const next = new Set(current);
        if (revoked) next.delete(platform);
        else next.add(platform);
        return next;
      });
      focusConnectAfterReload(platform);
      setConfirming(null);
      detached(revalidator.revalidate());
    } catch (error: unknown) {
      setConfirming(null);
      failed(error, { platform, action: "disconnect" });
      // Gone already (404) or changed meanwhile (409): show the current list. After a 404 the card loses its
      // connection, so focus moves to its Connect button as after a disconnect.
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        if (error.status === 404) focusConnectAfterReload(platform);
        detached(revalidator.revalidate());
      }
    } finally {
      setBusy(null);
    }
  }

  const confirmingName = confirming ? PLATFORM_NAMES[confirming] : "";
  const signInProviders: Provider[] = signInProvider ? [signInProvider] : providers;
  const signInNames: string = new Intl.ListFormat(intlLocale(), { type: "disjunction" }).format(
    signInProviders.map((provider: Provider): string => providerName[provider]),
  );
  return (
    <div className="ch-panel" ref={panel}>
      <p className="muted">
        {t("channels.intro")}{" "}
        {channels.some((channel) => channel.platform === "youtube" && channel.available) &&
          t("channels.youtubeSchedule")}{" "}
        <Link to={`${paths.privacy}#data-we-collect`}>{t("legal.privacyPolicy")}</Link>
      </p>
      {stale && (
        <p className="muted" data-channels-stale>
          {t("channels.refreshFailed")}
        </p>
      )}
      {result && (
        <output className="ch-result" tabIndex={-1} ref={banner}>
          {result}
        </output>
      )}
      <ul className="ch-list">
        {channels.map((channel: ChannelView) => {
          const name = PLATFORM_NAMES[channel.platform];
          const connection = channel.connection;
          const state: ChannelCardState | null = channelCardState(channel);
          return (
            <li key={channel.platform} className="ch-item" data-channel={channel.platform}>
              {/* Line 1: the platform at the left. At the right, the status and the account, or Connect. */}
              <div className="ch-head">
                <span className="ch-pill">
                  <PlatformIcon className="ch-logo" platform={channel.platform} label="" />
                  {name}
                </span>
                {connection && (
                  <span className="ch-who">
                    {state && <StateIcon state={state} label={stateText(channel, state, hydrated ? now : null)} />}
                    <span className="ch-account">{connection.displayName}</span>
                  </span>
                )}
                {!connection && channel.available && (
                  <button
                    type="button"
                    className="small-button"
                    data-connect
                    aria-label={t("channels.connect", { platform: name })}
                    disabled={busy !== null}
                    onClick={() => void connect(channel.platform, false)}
                  >
                    <Icon name="link" size={16} />
                    {t("channels.connectShort")}
                  </button>
                )}
              </div>
              {!channel.available && <p className="muted">{t("channels.unavailable")}</p>}
              {/* Line 2: two equal columns, the same on each card. */}
              {connection && (
                <div className="ch-actions">
                  {channel.available && (
                    <button
                      type="button"
                      data-connect
                      aria-label={t("channels.reconnect", { platform: name })}
                      disabled={busy !== null}
                      onClick={() => void connect(channel.platform, true)}
                    >
                      <Icon name="refresh" />
                      {t("channels.reconnectShort")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="danger"
                    data-disconnect
                    aria-label={t("channels.disconnect", { platform: name })}
                    disabled={busy !== null}
                    onClick={() => {
                      setFocusConnect(null);
                      setConfirming(channel.platform);
                    }}
                  >
                    <Icon name="close" />
                    {t("channels.disconnectShort")}
                  </button>
                </div>
              )}
              {!connection && unrevoked.has(channel.platform) && (
                <p className="ch-problem">
                  <Icon name="warning" size={16} />
                  <span>{t("channels.removeApp", { platform: name })}</span>
                </p>
              )}
              {reauth?.platform === channel.platform && (
                <div className="ch-reauth" role="alert">
                  {signInProviders.length > 0 && (
                    <p>{t(REAUTH_MESSAGES[reauth.action], { platform: name, provider: signInNames })}</p>
                  )}
                  <Reauthenticate
                    providers={signInProviders}
                    callbackURL={toolsPath("channels")}
                    onStart={() => rememberIntent(reauth, owner)}
                  />
                </div>
              )}
              {/* The last line: what the feed reads and the limits, closed until the owner opens it. */}
              {channel.available && (
                <details className="ch-more">
                  <summary>{t("channels.more")}</summary>
                  <ul>
                    {NOTES[channel.platform].map((id: MessageId) => (
                      <li key={id}>{t(id)}</li>
                    ))}
                    {channel.platform === "youtube" && !connection && (
                      <li>
                        <a className="text-link" href="https://www.youtube.com/t/terms">
                          {t("channels.youtubeTerms")}
                        </a>
                      </li>
                    )}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>
      <Dialog
        open={confirming !== null}
        returnFocus={focusConnect === null}
        onOpenChange={(open: boolean) => {
          if (!open && busy === null) setConfirming(null);
        }}
        title={t("channels.disconnectTitle", { platform: confirmingName })}
        description={t("channels.disconnectBody", { platform: confirmingName })}
        actions={
          <DialogActions>
            <button
              type="button"
              className="danger"
              disabled={busy !== null}
              onClick={() => confirming && void disconnect(confirming)}
            >
              {t("channels.disconnect", { platform: confirmingName })}
            </button>
          </DialogActions>
        }
      />
    </div>
  );
}
