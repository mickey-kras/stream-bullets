import { useState, type ReactNode } from "react";
import { Link, useRevalidator } from "react-router";
import type {
  AdminPerson,
  PageAction,
  ReportGroup,
  ReportGroupFilter,
  ReportItem,
  ReportItemList,
} from "../../admin-types";
import { t, tn, type MessageId } from "../../i18n";
import type { ReportReason } from "../../types";
import { EmptyState } from "../common";
import { Avatar, StreamerLogo } from "../ui/avatar";
import { DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Sheet } from "../ui/sheet";
import { DateTime } from "../waitlist";
import { actionIcon, actionLabel, ModerateSheet, pageActions, type ModeratedPage } from "./moderate-sheet";
import { StatusBadge } from "./streamer-pages";
import { adminRequest, errorText } from "./webauthn";

/* Content reports grouped by streamer page, de-duplicated by item, with an optional By author view (item 27). */

export const reportFilters: { value: ReportGroupFilter; label: MessageId }[] = [
  { value: "open", label: "admin.reports.open" },
  { value: "resolved", label: "admin.reports.resolved" },
  { value: "all", label: "admin.reports.all" },
];

const shortReasons: Record<ReportReason, MessageId> = {
  illegal: "admin.reports.reason.illegal",
  harassment: "admin.reports.reason.harassment",
  spam: "admin.reports.reason.spam",
  privacy: "admin.reports.reason.privacy",
  other: "admin.reports.reason.other",
};

function ReasonChips({ reasons }: Readonly<{ reasons: { reason: ReportReason; count: number }[] }>): ReactNode {
  return (
    <div className="reason-chips">
      {reasons.map((item) => (
        <span key={item.reason} className="reason-chip">
          {t("admin.reports.reasonCount", { reason: t(shortReasons[item.reason]), count: item.count })}
        </span>
      ))}
    </div>
  );
}

function countReasons(item: ReportItem): { reason: ReportReason; count: number }[] {
  const counts = new Map<ReportReason, number>();
  for (const report of item.reports) counts.set(report.reason, (counts.get(report.reason) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));
}

function personName(person: AdminPerson | null): string {
  return person?.name ?? t("admin.deletedAccount");
}

type Pending = { item: ReportItem; action: "remove" | "dismiss" } | null;

function ItemRow({
  item,
  handle,
  busy,
  onResolve,
}: Readonly<{
  item: ReportItem;
  handle: string | null;
  busy: boolean;
  onResolve: (pending: Pending) => void;
}>): ReactNode {
  const kind = t(item.targetKind === "entry" ? "admin.reports.kindEntry" : "admin.reports.kindComment");
  const newest = Math.max(...item.reports.map((report) => report.createdAt));
  return (
    <li className="report-item">
      <div className="report-item-head">
        <span className="person">
          <Avatar url={item.author?.avatar ?? null} preset={item.author?.avatarPreset ?? null} className="avatar-32" />
          <span>
            <strong>{personName(item.author)}</strong>
            <span className="muted"> · {kind}</span>
          </span>
        </span>
        <span className="reported-by">
          <Icon name="flag" size={16} />
          {tn("admin.reports.reportedBy", item.reports.length)}
        </span>
      </div>
      <blockquote className="report-snapshot">{item.snapshot}</blockquote>
      <ReasonChips reasons={countReasons(item)} />
      <p className="muted reporters">
        {item.reports.map((report) => `${personName(report.reporter)} (${t(shortReasons[report.reason])})`).join(", ")}
        {" · "}
        {t("admin.reports.newest")} <DateTime time={newest} />
      </p>
      {item.reports
        .filter((report) => report.details)
        .map((report) => (
          <p key={report.id} className="application-note">
            {t("admin.reports.details", { name: personName(report.reporter), details: report.details })}
          </p>
        ))}
      {item.entryId && handle && (
        <Link className="text-link" to={`/@${handle}?entry=${item.entryId}`}>
          <Icon name="external" size={16} />
          {t("admin.reports.context")}
        </Link>
      )}
      {item.status === "open" ? (
        <div className="application-actions">
          <button type="button" disabled={busy} onClick={() => onResolve({ item, action: "remove" })}>
            <Icon name="trash" size={18} />
            {t("admin.reports.remove")}
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label={t("admin.reports.dismissLabel", { kind })}
            onClick={() => onResolve({ item, action: "dismiss" })}
          >
            <Icon name="check" size={18} />
            {t("admin.reports.dismiss")}
          </button>
        </div>
      ) : (
        <p className="resolved-line">
          <Icon name={item.status === "actioned" ? "trash" : "check"} size={16} />
          {t(item.status === "actioned" ? "admin.reports.removed" : "admin.reports.dismissed")}
          {item.resolvedAt !== null && (
            <>
              {" · "}
              <DateTime time={item.resolvedAt} />
            </>
          )}
        </p>
      )}
    </li>
  );
}

function ItemList({
  items,
  byAuthor,
  handle,
  busy,
  onResolve,
}: Readonly<{
  items: ReportItem[];
  byAuthor: boolean;
  handle: string | null;
  busy: boolean;
  onResolve: (pending: Pending) => void;
}>): ReactNode {
  const row = (item: ReportItem): ReactNode => (
    <ItemRow
      key={`${item.targetKind}:${item.targetId}`}
      item={item}
      handle={handle}
      busy={busy}
      onResolve={onResolve}
    />
  );
  if (items.length === 0) return <p className="muted">{t("admin.reports.nothingInFilter")}</p>;
  if (!byAuthor) return <ul className="report-items">{items.map(row)}</ul>;
  const authors = new Map<string, ReportItem[]>();
  for (const item of items) {
    const key = item.author?.id ?? "";
    authors.set(key, [...(authors.get(key) ?? []), item]);
  }
  return (
    <ul className="author-groups">
      {[...authors.values()]
        .sort((a, b) => b.length - a.length)
        .map((list: ReportItem[]) => (
          <li key={list[0].author?.id ?? "deleted"} className="author-group">
            <h3 className="person author-head">
              <Avatar
                url={list[0].author?.avatar ?? null}
                preset={list[0].author?.avatarPreset ?? null}
                className="avatar-32"
              />
              <span>{tn("admin.reports.authorItems", list.length, { name: personName(list[0].author) })}</span>
            </h3>
            <ul className="report-items">{list.map(row)}</ul>
          </li>
        ))}
    </ul>
  );
}

/** A confirm button's state: busy while `onConfirm` runs, and the error text when it fails. */
function useConfirm(onConfirm: () => Promise<void>): { busy: boolean; error: string; run: () => void } {
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const run = (): void => {
    setBusy(true);
    setError("");
    onConfirm().catch((error_: unknown) => {
      setError(errorText(error_));
      setBusy(false);
    });
  };
  return { busy, error, run };
}

function ResolveSheet({
  pending,
  onClose,
  onConfirm,
}: Readonly<{ pending: NonNullable<Pending>; onClose: () => void; onConfirm: () => Promise<void> }>): ReactNode {
  const { busy, error, run } = useConfirm(onConfirm);
  const remove = pending.action === "remove";
  const count = pending.item.reports.filter((report) => report.status === "open").length;
  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(remove ? "admin.reports.removeTitle" : "admin.reports.dismissTitle")}
      short
      name="resolve-report"
      actions={
        <DialogActions>
          <button type="button" className={remove ? "danger" : "gold"} disabled={busy} onClick={run}>
            <Icon name={remove ? "trash" : "check"} size={18} />
            {t(remove ? "admin.reports.remove" : "admin.reports.dismiss")}
          </button>
        </DialogActions>
      }
    >
      <blockquote className="report-snapshot">{pending.item.snapshot}</blockquote>
      <p>{tn(remove ? "admin.reports.removeBody" : "admin.reports.dismissBody", count)}</p>
      <p className="form-error" role="alert">
        {error}
      </p>
    </Sheet>
  );
}

function DismissAllSheet({
  group,
  onClose,
  onConfirm,
}: Readonly<{ group: ReportGroup; onClose: () => void; onConfirm: () => Promise<void> }>): ReactNode {
  const { busy, error, run } = useConfirm(onConfirm);
  const handle = group.streamer?.handle ?? "";
  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("admin.reports.dismissAllTitle", { handle })}
      short
      name="dismiss-all"
      actions={
        <DialogActions>
          <button type="button" className="gold" disabled={busy} onClick={run}>
            <Icon name="check" size={18} />
            {t("admin.reports.dismissAll")}
          </button>
        </DialogActions>
      }
    >
      <p>{tn("admin.reports.dismissAllBody", group.open)}</p>
      <p className="form-error" role="alert">
        {error}
      </p>
    </Sheet>
  );
}

type GroupDialog =
  | { kind: "resolve"; pending: NonNullable<Pending> }
  | { kind: "dismiss-all" }
  | { kind: "moderate"; action: PageAction }
  | null;

function GroupCard({
  group,
  filter,
  onChanged,
}: Readonly<{
  group: ReportGroup;
  filter: ReportGroupFilter;
  onChanged: (message: string) => Promise<void>;
}>): ReactNode {
  const [detail, setDetail] = useState<ReportItemList | null>(null);
  const [open, setOpen] = useState<boolean>(false);
  const [byAuthor, setByAuthor] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [dialog, setDialog] = useState<GroupDialog>(null);
  const page = group.streamer;
  const name = page?.name ?? t("admin.reports.deletedPage");
  const headingId = `group-${group.streamerId}`;
  const detailId = `group-detail-${group.streamerId}`;

  async function load(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      setDetail(await adminRequest<ReportItemList>(`/api/admin/report-groups/${group.streamerId}?status=${filter}`));
    } catch (error_: unknown) {
      setError(errorText(error_));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(): Promise<void> {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    await load();
  }

  async function changed(message: string): Promise<void> {
    setDialog(null);
    await onChanged(message);
    if (open) await load();
  }

  const moderated: ModeratedPage | null = page;
  return (
    <li>
      <article
        className={`info-card application-card report-group${open ? " is-open" : ""}`}
        aria-labelledby={headingId}
      >
        <div className="application-head">
          <div className="person">
            {page ? <StreamerLogo streamer={page} className="avatar-48" /> : <Icon name="eye-off" size={40} />}
            <div>
              <h2 id={headingId}>{name}</h2>
              {page && <p className="muted">@{page.handle}</p>}
            </div>
          </div>
          {page && (
            <div className="mod-status">
              <StatusBadge status={page.status} />
            </div>
          )}
        </div>
        <dl className="group-stats">
          <div>
            <dt>{t(filter === "open" ? "admin.reports.statOpen" : "admin.reports.statReports")}</dt>
            <dd>{filter === "open" ? group.open : group.reports}</dd>
          </div>
          <div>
            <dt>{t("admin.reports.statItems")}</dt>
            <dd>{group.items}</dd>
          </div>
          <div>
            <dt>{t("admin.reports.stat30")}</dt>
            <dd>{group.last30Days}</dd>
          </div>
          <div>
            <dt>{t("admin.reports.statNewest")}</dt>
            <dd>
              <DateTime time={group.newest} />
            </dd>
          </div>
        </dl>
        <ReasonChips reasons={group.reasons} />
        <button
          type="button"
          className="text-button group-toggle"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => {
            void toggle();
          }}
        >
          <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
          {open ? t("admin.reports.hideItems") : tn("admin.reports.showItems", group.items)}
        </button>
        <p className="form-error" role="alert">
          {error}
        </p>
        {open && (
          <div className="group-detail" id={detailId}>
            <fieldset className="tabs group-mode">
              <legend className="sr-only">{t("admin.reports.groupBy")}</legend>
              <button
                type="button"
                className={byAuthor ? "" : "active"}
                aria-pressed={!byAuthor}
                onClick={() => setByAuthor(false)}
              >
                <Icon name="comment" size={16} />
                {t("admin.reports.byItem")}
              </button>
              <button
                type="button"
                className={byAuthor ? "active" : ""}
                aria-pressed={byAuthor}
                onClick={() => setByAuthor(true)}
              >
                <Icon name="user" size={16} />
                {t("admin.reports.byAuthor")}
              </button>
            </fieldset>
            {detail ? (
              <ItemList
                items={detail.items}
                byAuthor={byAuthor}
                handle={page?.handle ?? null}
                busy={busy}
                onResolve={(pending) => pending && setDialog({ kind: "resolve", pending })}
              />
            ) : (
              <p className="muted">{t("account.loading")}</p>
            )}
          </div>
        )}
        <div className="application-actions group-actions">
          {group.open > 0 && filter !== "resolved" && (
            <button type="button" onClick={() => setDialog({ kind: "dismiss-all" })}>
              <Icon name="check" size={18} />
              {t("admin.reports.dismissAll")}
            </button>
          )}
          {page &&
            pageActions(page.status).map((action: PageAction) => (
              <button
                key={action}
                type="button"
                className={action === "suspend" ? "danger" : ""}
                aria-label={`${actionLabel(action)} @${page.handle}`}
                onClick={() => setDialog({ kind: "moderate", action })}
              >
                <Icon name={actionIcon(action)} size={18} />
                {actionLabel(action)}
              </button>
            ))}
        </div>
      </article>
      {dialog?.kind === "resolve" && (
        <ResolveSheet
          pending={dialog.pending}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const { item, action } = dialog.pending;
            await adminRequest<unknown>("/api/admin/reports/resolve", "POST", {
              targetKind: item.targetKind,
              targetId: item.targetId,
              action,
            });
            await changed(t(action === "remove" ? "admin.reports.removedDone" : "admin.reports.dismissedDone"));
          }}
        />
      )}
      {dialog?.kind === "dismiss-all" && (
        <DismissAllSheet
          group={group}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await adminRequest<unknown>("/api/admin/reports/resolve", "POST", {
              streamerId: group.streamerId,
              action: "dismiss",
            });
            await changed(t("admin.reports.dismissedAllDone", { name }));
          }}
        />
      )}
      {dialog?.kind === "moderate" && moderated && (
        <ModerateSheet page={moderated} action={dialog.action} onClose={() => setDialog(null)} onDone={changed} />
      )}
    </li>
  );
}

/** The Content reports tab. */
export function ReportGroups({
  filter,
  groups,
}: Readonly<{ filter: ReportGroupFilter; groups: ReportGroup[] }>): ReactNode {
  const revalidator = useRevalidator();
  const [notice, setNotice] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? groups.filter((group) =>
        `${group.streamer?.name ?? ""} ${group.streamer?.handle ?? ""}`.toLowerCase().includes(needle),
      )
    : groups;
  const label = t(reportFilters.find((item) => item.value === filter)?.label ?? "admin.reports.open");

  return (
    <>
      <p>{t("admin.reports.intro")}</p>
      <search className="search directory-search">
        <label className="sr-only" htmlFor="group-search">
          {t("admin.reports.search")}
        </label>
        <input
          id="group-search"
          type="search"
          value={search}
          maxLength={60}
          placeholder={t("admin.reports.searchPlaceholder")}
          onChange={(event) => setSearch(event.target.value)}
        />
        <span className="search-lead" aria-hidden="true">
          <Icon name="search" size={18} />
        </span>
      </search>
      <nav className="tabs status-tabs level-2" aria-label={t("admin.reports.statusLabel")}>
        {reportFilters.map((item) => (
          <Link
            key={item.value}
            to={item.value === "open" ? "/admin?view=reports" : `/admin?view=reports&status=${item.value}`}
            className={item.value === filter ? "active" : ""}
            aria-current={item.value === filter ? "page" : undefined}
            preventScrollReset
          >
            {t(item.label)}
          </Link>
        ))}
      </nav>
      <section aria-labelledby="reports-heading">
        <h2 className="sr-only" id="reports-heading">
          {t("admin.reports.heading", { filter: label })}
        </h2>
        <output className="admin-notice">{notice}</output>
        {shown.length === 0 ? (
          <EmptyState title={t(filter === "open" ? "admin.reports.emptyOpen" : "admin.nothingYet")} icon="shield-check">
            {t(filter === "open" ? "admin.reports.emptyOpenBody" : "admin.reports.emptyResolvedBody")}
          </EmptyState>
        ) : (
          <ul className="application-list">
            {shown.map((group: ReportGroup) => (
              <GroupCard
                key={group.streamerId}
                group={group}
                filter={filter}
                onChanged={async (message: string) => {
                  setNotice(message);
                  await revalidator.revalidate();
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
