import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLocation, useNavigate, useRevalidator } from "react-router";
import { intlLocale, t, type MessageId } from "../../i18n";
import {
  quotaDay,
  type ActivityPlatform,
  type ChannelStatus,
  type ChannelStatusCode,
  type ConnectResult,
} from "../../lib/activity";
import type { Provider } from "../../types";
import { ApiError, errorMessage, postJson, sendJson } from "../api";
import { providerName, Reauthenticate } from "../shell/sign-in-dialog";
import { Dialog, DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { useShell } from "../../lib/shell";
import { detached } from "../../lib/detached";

/** One platform as GET /api/channels and the overlay-control loader list it. */
export interface ChannelView {
  platform: ActivityPlatform;
  available: boolean;
  connection: {
    displayName: string;
    status: ChannelStatus;
    code: string | null;
    connectedAt: number;
    lastEventAt: number | null;
    updatedAt: number;
  } | null;
}

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

/** The one sentence of each card: when chat starts (docs/channel-connections.md). */
const STARTS: Readonly<Record<ActivityPlatform, MessageId>> = {
  twitch: "channels.starts.connected",
  youtube: "channels.starts.overlay",
  kick: "channels.starts.connected",
};

/** The closed details of each card: what the feed reads, then the limits and the gaps. */
const NOTES: Readonly<Record<ActivityPlatform, readonly MessageId[]>> = {
  twitch: ["channels.reads.twitch", "channels.emotes.twitch", "channels.twitchReconnect"],
  youtube: ["channels.reads.youtube", "channels.limits.youtube", "channels.gaps.youtube"],
  kick: ["channels.reads.kick", "channels.emotes.kick", "channels.gaps.kick"],
};

/** A change that needs a recent sign-in. The owner signs in again, then the page takes the change up again. */
export interface ChannelIntent {
  platform: ActivityPlatform;
  action: "connect" | "disconnect";
}

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

/** A spent quota is expected and ends by itself, so it is a polite status; every other problem is an alert. */
export function problemRole(code: string | null): "status" | "alert" {
  return code === "quota_exhausted" ? "status" : "alert";
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

function LastActivity({ at }: Readonly<{ at: number | null }>): ReactNode {
  const hydrated = useHydrated();
  if (at === null) return <p className="muted">{t("channels.noActivity")}</p>;
  if (!hydrated) return null;
  const time = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));
  return <p className="muted">{t("channels.lastActivity", { time })}</p>;
}

/**
 * Streamer controls for the channel connections (docs/channel-connections.md): status, connect, reconnect and
 * disconnect for each platform. Connecting leaves for the provider and comes back with `?channel=&result=`. The
 * panel then shows and announces the result, and removes it from the address.
 */
export function ChannelPanel({
  channels,
  providers,
  signInProvider,
  result: initialResult,
}: Readonly<{
  channels: ChannelView[];
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

  // The result of a callback: show it in view and give it focus, so it is read once (the banner is a status
  // region; no toast repeats it). Then take it out of the address, so a reload or a shared link does not show it
  // again. The message stays in this state.
  useEffect((): void => {
    if (!initialResult || resultShown.current) return;
    resultShown.current = true;
    document.getElementById("channels-title")?.scrollIntoView({ block: "start" });
    banner.current?.focus();
    detached(navigate(location.pathname, { replace: true, preventScrollReset: true }));
  }, [initialResult, location.pathname, navigate]);

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
    const details: HTMLDetailsElement | null | undefined = panel.current?.closest("details");
    if (details) details.open = true;
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
      <p className="muted">{t("channels.intro")}</p>
      {result && (
        <output className="ch-result" tabIndex={-1} ref={banner}>
          {result}
        </output>
      )}
      <ul className="ch-list">
        {channels.map((channel: ChannelView) => {
          const name = PLATFORM_NAMES[channel.platform];
          const connection = channel.connection;
          // A platform this site no longer offers cannot be reconnected, so its status advice would mislead.
          // The quota message names the reset time in the viewer's time zone, so it shows after hydration.
          const waitsForTime = connection?.code === "quota_exhausted" && !hydrated;
          let problem: string | null = null;
          if (connection && channel.available && !waitsForTime) {
            const quotaReset: string | null =
              connection.code === "quota_exhausted" ? quotaResetText(connection.updatedAt) : null;
            problem = statusMessage(connection, quotaReset, channel.platform);
          }
          return (
            <li key={channel.platform} className="ch-item" data-channel={channel.platform}>
              <p className="ch-head">
                <span className="ch-badge">{name}</span>
                <strong>
                  {connection
                    ? t("channels.connectedAs", { name: connection.displayName })
                    : t("channels.notConnected")}
                </strong>
              </p>
              <div className="ch-body">
                {channel.available ? <p>{t(STARTS[channel.platform])}</p> : <p>{t("channels.unavailable")}</p>}
                {connection && <LastActivity at={connection.lastEventAt} />}
                {problem && (
                  // A used-up quota is a known state, not news: it is a status, so it is not read out as an alert.
                  <p className="ch-problem" role={problemRole(connection?.code ?? null)}>
                    <Icon name="warning" size={16} />
                    <span>{problem}</span>
                  </p>
                )}
                {!connection && unrevoked.has(channel.platform) && (
                  <p className="ch-problem">
                    <Icon name="warning" size={16} />
                    <span>{t("channels.removeApp", { platform: name })}</span>
                  </p>
                )}
              </div>
              <div className="ch-actions">
                {channel.available && channel.platform === "youtube" && !connection && (
                  <a className="text-link ch-terms" href="https://www.youtube.com/t/terms">
                    {t("channels.youtubeTerms")}
                  </a>
                )}
                {channel.available && (
                  <button
                    type="button"
                    data-connect
                    disabled={busy !== null}
                    onClick={() => void connect(channel.platform, connection !== null)}
                  >
                    {connection
                      ? t("channels.reconnect", { platform: name })
                      : t("channels.connect", { platform: name })}
                  </button>
                )}
                {connection && (
                  <button
                    type="button"
                    className="danger"
                    data-disconnect
                    disabled={busy !== null}
                    onClick={() => {
                      setFocusConnect(null);
                      setConfirming(channel.platform);
                    }}
                  >
                    {t("channels.disconnect", { platform: name })}
                  </button>
                )}
              </div>
              <div className="ch-foot">
                {reauth?.platform === channel.platform && (
                  <div className="ch-reauth" role="alert">
                    {signInProviders.length > 0 && (
                      <p>
                        {t(reauth.action === "connect" ? "channels.reauth.connect" : "channels.reauth.disconnect", {
                          platform: name,
                          provider: signInNames,
                        })}
                      </p>
                    )}
                    <Reauthenticate
                      providers={signInProviders}
                      callbackURL="/overlay-control"
                      onStart={() => rememberIntent(reauth, owner)}
                    />
                  </div>
                )}
                {channel.available && (
                  <details className="ch-more">
                    <summary>{t("channels.more")}</summary>
                    <ul>
                      {NOTES[channel.platform].map((id: MessageId) => (
                        <li key={id}>{t(id)}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
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
