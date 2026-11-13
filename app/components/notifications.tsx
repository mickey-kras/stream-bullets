import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { intlLocale, t } from "../i18n";
import type { NotificationItem, NotificationPreferences, NotificationSnapshot } from "../types";
import { errorMessage, postJson, requestJson } from "./api";
import { Icon } from "./ui/icon";

const NOTIFICATIONS_CHANGED = "notifications-changed";

function changed(): void {
  globalThis.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
}

export function NotificationLink(): ReactNode {
  const [unread, setUnread] = useState<number>(0);
  const [error, setError] = useState<string>("");
  useEffect(() => {
    let controller: AbortController | null = null;
    const refresh = (): void => {
      if (document.visibilityState === "hidden") return;
      controller?.abort();
      controller = new AbortController();
      const signal: AbortSignal = controller.signal;
      requestJson<NotificationSnapshot>("/api/notifications", { signal })
        .then((snapshot: NotificationSnapshot) => {
          if (signal.aborted) return;
          setUnread(snapshot.unreadCount);
          setError("");
        })
        .catch((cause: unknown) => {
          if (!signal.aborted) setError(errorMessage(cause));
        });
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    globalThis.addEventListener("focus", refresh);
    globalThis.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller?.abort();
      clearInterval(timer);
      globalThis.removeEventListener("focus", refresh);
      globalThis.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const label: string = unread > 0 ? t("notifications.unread", { count: unread }) : t("notifications.title");
  return (
    <Link className="notification-nav" to="/notifications" aria-label={label} title={error || label}>
      <Icon name={error ? "warning" : "requests"} size={20} />
      {unread > 0 && (
        <span className="notification-badge" aria-hidden="true">
          {unread}
        </span>
      )}
      {error && <span className="sr-only">{error}</span>}
    </Link>
  );
}

export function Notifications({ initial }: Readonly<{ initial: NotificationSnapshot }>): ReactNode {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<NotificationSnapshot>(initial);
  const [preferences, setPreferences] = useState<NotificationPreferences>(initial.preferences);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState<string>("");

  async function load(append: boolean): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const query: string = append && snapshot.nextCursor ? `?cursor=${encodeURIComponent(snapshot.nextCursor)}` : "";
      const next: NotificationSnapshot = await requestJson<NotificationSnapshot>(`/api/notifications${query}`);
      setSnapshot((current: NotificationSnapshot) => ({
        ...next,
        notifications: append
          ? [
              ...new Map(
                [...current.notifications, ...next.notifications].map((item: NotificationItem) => [item.id, item]),
              ).values(),
            ]
          : next.notifications,
      }));
      changed();
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function mark(item: NotificationItem, read: boolean): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await postJson("/api/notifications", { action: "read", id: item.id, read });
      setSnapshot((current: NotificationSnapshot) => ({
        ...current,
        unreadCount: Math.max(0, current.unreadCount + (read ? -1 : 1)),
        notifications: current.notifications.map((value: NotificationItem) =>
          value.id === item.id ? { ...value, read } : value,
        ),
      }));
      changed();
      return true;
    } catch (cause: unknown) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function open(event: MouseEvent<HTMLAnchorElement>, item: NotificationItem): void {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || item.read) return;
    event.preventDefault();
    if (busy) return;
    void mark(item, true).then((saved: boolean) => {
      if (saved) void navigate(item.href);
    });
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await postJson("/api/notifications", { action: "preferences", ...preferences });
      setSnapshot((current: NotificationSnapshot) => ({ ...current, preferences }));
      setStatus(t("notifications.saved"));
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="info-card" aria-labelledby="notifications-title">
        <div className="discussion-head">
          <h1 id="notifications-title">{t("notifications.title")}</h1>
          <button type="button" disabled={busy} onClick={() => void load(false)}>
            <Icon name="refresh" size={18} />
            {t("notifications.refresh")}
          </button>
        </div>
        <p role="alert" className="form-error">
          {error}
        </p>
        <output className="muted">{t("notifications.unread", { count: snapshot.unreadCount })}</output>
        {snapshot.notifications.length === 0 && <p className="empty">{t("notifications.empty")}</p>}
        <ul className="notification-list" aria-busy={busy}>
          {snapshot.notifications.map((item: NotificationItem) => (
            <li className="notification-item" data-unread={!item.read} key={item.id}>
              <Link className="notification-link" to={item.href} onClick={(event) => open(event, item)}>
                <strong>
                  {t(item.kind === "reply" ? "notifications.reply" : "notifications.mention", { name: item.actor })}
                </strong>
                <time dateTime={new Date(item.createdAt).toISOString()}>
                  {new Intl.DateTimeFormat(intlLocale(), {
                    dateStyle: "medium",
                    timeStyle: "long",
                    timeZone: "UTC",
                  }).format(item.createdAt)}
                </time>
              </Link>
              <button
                type="button"
                className="small-button"
                disabled={busy}
                onClick={() => void mark(item, !item.read)}
              >
                {t(item.read ? "notifications.markUnread" : "notifications.markRead")}
              </button>
            </li>
          ))}
        </ul>
        {snapshot.nextCursor && (
          <button type="button" className="load-more" disabled={busy} onClick={() => void load(true)}>
            {t("notifications.loadMore")}
          </button>
        )}
      </section>
      <form className="info-card" onSubmit={(event) => void save(event)}>
        <fieldset className="notification-preferences" disabled={busy}>
          <legend>{t("notifications.preferences")}</legend>
          <p className="muted">{t("notifications.delivery")}</p>
          <label>
            <input
              type="checkbox"
              checked={preferences.replies}
              onChange={(event) => {
                const replies: boolean = event.currentTarget.checked;
                setPreferences((current: NotificationPreferences) => ({ ...current, replies }));
                setStatus("");
              }}
            />
            <span>{t("notifications.replies")}</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={preferences.mentions}
              onChange={(event) => {
                const mentions: boolean = event.currentTarget.checked;
                setPreferences((current: NotificationPreferences) => ({ ...current, mentions }));
                setStatus("");
              }}
            />
            <span>{t("notifications.mentions")}</span>
          </label>
          <button className="gold" type="submit">
            {t("common.save")}
          </button>
        </fieldset>
        <output>{status}</output>
      </form>
    </>
  );
}
