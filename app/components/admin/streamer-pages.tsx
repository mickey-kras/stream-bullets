import { useState, type ReactNode } from "react";
import { Form, Link, useRevalidator } from "react-router";
import type { AdminPage, AdminPageList, ModerationEvent, PageAction, StreamerStatus } from "../../types";
import { t, tn } from "../../i18n";
import { reasonText } from "../../lib/moderation";
import { EmptyState } from "../common";
import { Avatar, StreamerLogo } from "../ui/avatar";
import { Icon } from "../ui/icon";
import { DateTime } from "../waitlist";
import { actionIcon, actionLabel, ModerateSheet, pageActions, type ModeratedPage } from "./moderate-sheet";
import { OfficialSheet } from "./official-sheet";
import { adminRequest, errorText } from "./webauthn";

export type PageFilter = "all" | StreamerStatus;

export const pageFilters: { value: PageFilter; label: "admin.pages.all" | `admin.pages.${StreamerStatus}` }[] = [
  { value: "all", label: "admin.pages.all" },
  { value: "active", label: "admin.pages.active" },
  { value: "frozen", label: "admin.pages.frozen" },
  { value: "suspended", label: "admin.pages.suspended" },
];

/** Active, Frozen or Suspended, as a badge. */
export function StatusBadge({ status }: Readonly<{ status: StreamerStatus }>): ReactNode {
  const icons = { suspended: "eye-off", frozen: "lock", active: "success" } as const;
  const icon = icons[status];
  return (
    <span className={`mod-badge ${status}`}>
      <Icon name={icon} size={16} />
      {t(`admin.pages.${status}`)}
    </span>
  );
}

const historyLabels: Record<string, PageAction> = {
  freeze: "freeze",
  unfreeze: "unfreeze",
  suspend: "suspend",
  unsuspend: "unsuspend",
};

/** An audit action in words; unknown actions show as stored. */
function historyLabel(action: string): string {
  if (action in historyLabels) return actionLabel(historyLabels[action]);
  if (action === "official") return t("admin.pages.markedOfficial");
  if (action === "unofficial") return t("admin.pages.clearedOfficial");
  return action;
}

function History({ events }: Readonly<{ events: ModerationEvent[] }>): ReactNode {
  if (events.length === 0) return <p className="muted mod-none">{t("admin.pages.noHistory")}</p>;
  return (
    <details className="mod-history">
      <summary>
        <Icon name="pending" size={16} />
        {t("admin.pages.history", { count: events.length })}
      </summary>
      <ol>
        {events.map((event: ModerationEvent) => (
          <li key={event.id}>
            <strong>{historyLabel(event.action)}</strong>
            {event.reason && <> · {reasonText(event.reason)}</>}
            <span className="muted">
              {" · "}
              {event.actor ?? t("admin.deletedAccount")}, <DateTime time={event.createdAt} />
            </span>
            {event.note && <p className="muted">{event.note}</p>}
          </li>
        ))}
      </ol>
    </details>
  );
}

function PageRow({
  page,
  onAction,
  onOfficial,
}: Readonly<{
  page: AdminPage;
  onAction: (page: AdminPage, action: PageAction) => void;
  onOfficial: (page: AdminPage) => void;
}>): ReactNode {
  const headingId = `page-${page.id}`;
  return (
    <li>
      <article className="info-card application-card page-row" aria-labelledby={headingId}>
        <div className="application-head">
          <div className="person">
            <StreamerLogo streamer={page} className="avatar-48" />
            <div>
              <h2 id={headingId}>{page.name}</h2>
              <p className="muted">@{page.handle}</p>
            </div>
          </div>
          <div className="mod-status">
            {page.isOfficial && (
              <span className="official-badge">
                <Icon name="shield-check" size={16} />
                {t("streamers.official")}
              </span>
            )}
            <StatusBadge status={page.status} />
          </div>
        </div>
        <p className="page-owner">
          <Avatar url={page.owner.avatar} preset={page.owner.avatarPreset} className="avatar-20" />
          {t("admin.pages.owner", { name: page.owner.name || t("admin.deletedAccount") })}
        </p>
        {page.owner.email && (
          <p className="muted owner-mail">
            <a className="text-link" href={`mailto:${page.owner.email}`}>
              <Icon name="mail" size={16} />
              {page.owner.email}
            </a>
          </p>
        )}
        {page.statusReason && page.status !== "active" && (
          <p className="muted">{t("admin.pages.reason", { reason: reasonText(page.statusReason) })}</p>
        )}
        <p className="muted page-counts">
          <Icon name="topics" size={16} />
          {tn("admin.pages.topics", page.topics)} · <Icon name="polls" size={16} />
          {tn("admin.pages.polls", page.polls)}
        </p>
        <History events={page.history} />
        <div className="application-actions">
          {pageActions(page.status).map((action: PageAction) => (
            <button
              key={action}
              type="button"
              className={action === "suspend" ? "danger" : ""}
              aria-label={`${actionLabel(action)} @${page.handle}`}
              onClick={() => onAction(page, action)}
            >
              <Icon name={actionIcon(action)} size={18} />
              {actionLabel(action)}
            </button>
          ))}
          <button
            type="button"
            aria-label={`${t(page.isOfficial ? "admin.pages.clearOfficial" : "admin.pages.markOfficial")} @${page.handle}`}
            onClick={() => onOfficial(page)}
          >
            <Icon name="shield-check" size={18} />
            {t(page.isOfficial ? "admin.pages.clearOfficial" : "admin.pages.markOfficial")}
          </button>
          <Link className="button-link" to={`/@${page.handle}`}>
            <Icon name="arrow-right" size={18} />
            {t("admin.pages.view")}
          </Link>
        </div>
      </article>
    </li>
  );
}

/** The Streamer pages tab: search, status filter, and Freeze/Suspend with their reverse. */
export function StreamerPages({
  filter,
  query,
  list,
}: Readonly<{ filter: PageFilter; query: string; list: AdminPageList }>): ReactNode {
  const revalidator = useRevalidator();
  const [more, setMore] = useState<AdminPage[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<boolean>(false);
  const [notice, setNotice] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [dialog, setDialog] = useState<{ page: ModeratedPage; action: PageAction } | null>(null);
  const [official, setOfficial] = useState<AdminPage | null>(null);
  const nextCursor = cursor === undefined ? list.nextCursor : cursor;
  const seen = new Set<string>();
  const pages = [...list.pages, ...more].filter((page: AdminPage) => {
    if (seen.has(page.id)) return false;
    seen.add(page.id);
    return true;
  });

  async function done(message: string): Promise<void> {
    setNotice(message);
    setMore([]);
    setCursor(undefined);
    await revalidator.revalidate();
  }

  async function loadMore(): Promise<void> {
    if (busy || !nextCursor) return;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ status: filter, cursor: nextCursor });
      if (query) params.set("query", query);
      const page = await adminRequest<AdminPageList>(`/api/admin/streamers?${params.toString()}`);
      setMore((current: AdminPage[]) => [...current, ...page.pages]);
      setCursor(page.nextCursor);
    } catch (error_: unknown) {
      setError(errorText(error_));
    } finally {
      setBusy(false);
    }
  }

  const filterHref = (value: PageFilter): string => {
    const params = new URLSearchParams({ view: "pages" });
    if (value !== "all") params.set("status", value);
    if (query) params.set("query", query);
    return `/admin?${params.toString()}`;
  };
  const label = t(pageFilters.find((item) => item.value === filter)?.label ?? "admin.pages.all");

  return (
    <>
      <p>{t("admin.pages.intro")}</p>
      <search className="search directory-search">
        <Form method="get" action="/admin">
          <input type="hidden" name="view" value="pages" />
          {filter !== "all" && <input type="hidden" name="status" value={filter} />}
          <label className="sr-only" htmlFor="page-search">
            {t("admin.pages.search")}
          </label>
          <input
            id="page-search"
            type="search"
            name="query"
            maxLength={60}
            defaultValue={query}
            placeholder={t("admin.pages.searchPlaceholder")}
          />
          <span className="search-lead" aria-hidden="true">
            <Icon name="search" size={18} />
          </span>
        </Form>
      </search>
      <nav className="tabs status-tabs level-2" aria-label={t("admin.pages.statusLabel")}>
        {pageFilters.map((item) => (
          <Link
            key={item.value}
            to={filterHref(item.value)}
            className={item.value === filter ? "active" : ""}
            aria-current={item.value === filter ? "page" : undefined}
            preventScrollReset
          >
            {t(item.label)}
          </Link>
        ))}
      </nav>
      <section aria-labelledby="pages-heading">
        <h2 className="sr-only" id="pages-heading">
          {t("admin.pages.heading", { filter: label })}
        </h2>
        <p className="form-error" role="alert">
          {error}
        </p>
        <output className="admin-notice">{notice}</output>
        {pages.length === 0 ? (
          <EmptyState title={t("admin.pages.empty", { filter: label.toLowerCase() })} icon="shield-check">
            {t("admin.nothingYet")}
          </EmptyState>
        ) : (
          <ul className="application-list">
            {pages.map((page: AdminPage) => (
              <PageRow
                key={page.id}
                page={page}
                onAction={(item, action) => setDialog({ page: item, action })}
                onOfficial={setOfficial}
              />
            ))}
          </ul>
        )}
        {nextCursor && (
          <button
            type="button"
            className="load-more"
            disabled={busy}
            onClick={() => {
              void loadMore();
            }}
          >
            {busy ? t("account.loading") : t("admin.pages.more")}
          </button>
        )}
      </section>
      {official && (
        <OfficialSheet
          page={official}
          official={!official.isOfficial}
          onClose={() => setOfficial(null)}
          onDone={async (message: string) => {
            setOfficial(null);
            await done(message);
          }}
        />
      )}
      {dialog && (
        <ModerateSheet
          page={dialog.page}
          action={dialog.action}
          onClose={() => setDialog(null)}
          onDone={async (message: string) => {
            setDialog(null);
            await done(message);
          }}
        />
      )}
    </>
  );
}
