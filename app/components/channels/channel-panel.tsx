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
import { SignIn } from "../shell/sign-in-dialog";
import { Dialog, DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";

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
  disconnecting: "channels.status.error",
};

const NOTES: Readonly<Partial<Record<ActivityPlatform, readonly MessageId[]>>> = {
  youtube: ["channels.youtubeNote", "channels.gaps.youtube"],
  kick: ["channels.gaps.kick"],
};

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
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const location = useLocation();
  const panel = useRef<HTMLDivElement>(null);
  const banner = useRef<HTMLOutputElement>(null);
  const resultShown = useRef<boolean>(false);
  const [result, setResult] = useState<string | null>(initialResult);
  const [busy, setBusy] = useState<ActivityPlatform | null>(null);
  const [confirming, setConfirming] = useState<ActivityPlatform | null>(null);
  const [reauth, setReauth] = useState<boolean>(false);
  /** Platforms whose last disconnect the provider did not confirm: the owner should remove the app there. */
  const [unrevoked, setUnrevoked] = useState<ReadonlySet<ActivityPlatform>>(new Set());
  const [focusConnect, setFocusConnect] = useState<ActivityPlatform | null>(null);
  /** Whether the list reload after a disconnect has started, so its end can be told from the state before it. */
  const reloading = useRef<boolean>(false);
  const hydrated = useHydrated();

  // The result of a callback: show it in view and give it focus, so it is read once (the banner is a status
  // region; no toast repeats it). Then take it out of the address, so a reload or a shared link does not show it
  // again. The message stays in this state.
  useEffect((): void => {
    if (!initialResult || resultShown.current) return;
    resultShown.current = true;
    document.getElementById("channels-title")?.scrollIntoView({ block: "start" });
    banner.current?.focus();
    navigate(location.pathname, { replace: true, preventScrollReset: true });
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
    if (!focusConnect) return;
    const title = document.getElementById("channels-title");
    if (revalidator.state !== "idle") {
      reloading.current = true;
      return;
    }
    // Right after the disconnect: the dialog and its opener go away, so focus waits on the section heading.
    if (!reloading.current) {
      title?.focus();
      return;
    }
    // The reload ended (whatever its result): focus Connect when the card shows it, else stay on the heading.
    reloading.current = false;
    setFocusConnect(null);
    const card = channels.find((channel) => channel.platform === focusConnect);
    const button = card?.connection
      ? null
      : panel.current?.querySelector<HTMLButtonElement>(`[data-channel="${focusConnect}"] [data-connect]`);
    (button ?? title)?.focus();
  }, [channels, focusConnect, revalidator.state]);

  function failed(error: unknown): void {
    if (error instanceof ApiError && error.code === "reauth_required") setReauth(true);
    else toast(errorMessage(error), { tone: "error" });
  }

  async function connect(platform: ActivityPlatform, reconnect: boolean): Promise<void> {
    setResult(null);
    setBusy(platform);
    try {
      const { authorizeUrl } = await postJson<{ authorizeUrl: string }>(
        `/api/channels/${platform}/${reconnect ? "reconnect" : "connect"}`,
        {},
      );
      globalThis.location.assign(authorizeUrl);
    } catch (error: unknown) {
      failed(error);
      setBusy(null);
    }
  }

  async function disconnect(platform: ActivityPlatform): Promise<void> {
    setResult(null);
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
      setFocusConnect(platform);
      setConfirming(null);
      revalidator.revalidate();
    } catch (error: unknown) {
      setConfirming(null);
      failed(error);
      // Gone already (404) or changed meanwhile (409): show the current list. After a 404 the card loses its
      // connection, so focus moves to its Connect button as after a disconnect.
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        if (error.status === 404) setFocusConnect(platform);
        revalidator.revalidate();
      }
    } finally {
      setBusy(null);
    }
  }

  const confirmingName = confirming ? PLATFORM_NAMES[confirming] : "";
  return (
    <div className="ch-panel" ref={panel}>
      <p className="muted">{t("channels.intro")}</p>
      {result && (
        <output className="ch-result" tabIndex={-1} ref={banner}>
          {result}
        </output>
      )}
      {reauth && (
        <div className="ch-reauth" role="alert">
          <p>{t("channels.reauth")}</p>
          <SignIn providers={signInProvider ? [signInProvider] : providers} callbackURL="/overlay-control" />
        </div>
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
              {!channel.available && <p className="muted">{t("channels.unavailable")}</p>}
              {(channel.available ? (NOTES[channel.platform] ?? []) : []).map((id: MessageId) => (
                <p key={id} className="muted">
                  {t(id)}
                </p>
              ))}
              <p className="ch-actions">
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
                    disabled={busy !== null}
                    onClick={() => setConfirming(channel.platform)}
                  >
                    {t("channels.disconnect", { platform: name })}
                  </button>
                )}
              </p>
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
