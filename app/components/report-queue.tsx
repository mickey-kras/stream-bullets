import { useState, type ReactNode } from "react";
import { Link, useRevalidator } from "react-router";
import type { ContentReport, ReportQueue, ReportStatus } from "../types";
import { EmptyState } from "./common";
import { errorMessage, postJson, requestJson } from "./api";
import { DeleteButton } from "./discussion";
import { reportReasons } from "./report";
import { DateTime } from "./waitlist";

export const reportStatuses: { value: ReportStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "actioned", label: "Removed" },
  { value: "dismissed", label: "Dismissed" },
];

type Decision = "remove" | "dismiss";

function reasonLabel(report: ContentReport): string {
  return reportReasons.find((item) => item.value === report.reason)?.label ?? report.reason;
}

function ReportCard({
  report,
  busy,
  onResolve,
  onDecide,
}: Readonly<{
  report: ContentReport;
  busy: boolean;
  /** Rejects on failure, so the confirmation dialog can show the error. */
  onResolve: (report: ContentReport, decision: Decision) => Promise<void>;
  /** Reports failures on the page. */
  onDecide: (report: ContentReport, decision: Decision) => void;
}>): ReactNode {
  const headingId = `report-${report.id}`;
  const kind = report.targetKind === "entry" ? "topic or poll" : "comment";
  const available = report.entryId !== null && report.streamerHandle !== null;
  return (
    <li>
      <article className="info-card application-card" aria-labelledby={headingId}>
        <div className="application-head">
          <div>
            <h2 id={headingId}>{reasonLabel(report)}</h2>
            <p className="report-meta">
              <span>
                Reported {kind}
                {report.streamerHandle && <> on @{report.streamerHandle}</>}
              </span>
              <span>by {report.reporterName ?? "a deleted account"}</span>
            </p>
          </div>
          <dl className="application-dates">
            <div>
              <dt>Reported</dt>
              <dd>
                <DateTime time={report.createdAt} />
              </dd>
            </div>
            {report.resolvedAt !== null && (
              <div>
                <dt>Resolved</dt>
                <dd>
                  <DateTime time={report.resolvedAt} />
                </dd>
              </div>
            )}
          </dl>
        </div>
        <h3 className="eyebrow">Reported content</h3>
        <blockquote className="report-snapshot">{report.snapshot}</blockquote>
        {report.details && (
          <>
            <h3 className="eyebrow">Details from the reporter</h3>
            <p className="application-note">{report.details}</p>
          </>
        )}
        {available ? (
          <p>
            <Link className="text-link" to={`/@${report.streamerHandle}?entry=${report.entryId}`}>
              Open the {report.targetKind === "entry" ? "conversation" : "discussion"}
            </Link>
          </p>
        ) : (
          <p className="muted">This content is no longer available.</p>
        )}
        {report.status === "open" && (
          <div className="application-actions">
            {available ? (
              <>
                <DeleteButton label="Remove content" disabled={busy} onDelete={() => onResolve(report, "remove")} />
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Dismiss report: ${reasonLabel(report)}`}
                  onClick={() => onDecide(report, "dismiss")}
                >
                  Dismiss
                </button>
              </>
            ) : (
              <button type="button" className="gold" disabled={busy} onClick={() => onDecide(report, "remove")}>
                Close report
              </button>
            )}
          </div>
        )}
      </article>
    </li>
  );
}

/** The moderation queue: reports about topics, polls, and comments. */
export function ReportReviewQueue({
  status,
  queue,
}: Readonly<{ status: ReportStatus; queue: ReportQueue }>): ReactNode {
  const revalidator = useRevalidator();
  const [more, setMore] = useState<ContentReport[]>([]);
  const [moreCursor, setMoreCursor] = useState<string | null | undefined>(undefined);
  const [resolved, setResolved] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");

  const seen = new Set<string>();
  const reports = [...queue.reports, ...more].filter((report: ContentReport) => {
    if (seen.has(report.id) || resolved.has(report.id) || report.status !== status) return false;
    seen.add(report.id);
    return true;
  });
  const cursor = moreCursor === undefined ? queue.nextCursor : moreCursor;

  /** Rejects on failure; the caller shows the error. */
  async function resolve(report: ContentReport, decision: Decision): Promise<void> {
    if (busy) return;
    setBusy(report.id);
    setError("");
    setNotice("");
    try {
      const result = await postJson<{ resolved: number }>("/api/admin/reports", { id: report.id, action: decision });
      // Every open report about the same content closes with this decision.
      setResolved((current: Set<string>) => {
        const next = new Set(current);
        for (const item of reports) if (item.targetId === report.targetId) next.add(item.id);
        return next;
      });
      const count = `${result.resolved} ${result.resolved === 1 ? "report" : "reports"}`;
      setNotice(decision === "remove" ? `Removed the content and closed ${count}.` : `Dismissed ${count}.`);
      await revalidator.revalidate();
    } finally {
      setBusy("");
    }
  }

  function decide(report: ContentReport, decision: Decision): void {
    resolve(report, decision).catch((error_: unknown) => setError(errorMessage(error_)));
  }

  async function loadMore(): Promise<void> {
    if (busy || !cursor) return;
    setBusy("more");
    setError("");
    try {
      const params = new URLSearchParams({ status, cursor });
      const page = await requestJson<ReportQueue>(`/api/admin/reports?${params.toString()}`);
      setMore((current: ContentReport[]) => [...current, ...page.reports]);
      setMoreCursor(page.nextCursor);
      setNotice(`Loaded ${page.reports.length} more ${page.reports.length === 1 ? "report" : "reports"}.`);
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setBusy("");
    }
  }

  const label = reportStatuses.find((item) => item.value === status)?.label ?? status;
  return (
    <section aria-labelledby="queue-heading">
      <h2 className="sr-only" id="queue-heading">
        {label} reports
      </h2>
      <p className="form-error" role="alert">
        {error}
      </p>
      <output className="admin-notice">{notice}</output>
      {reports.length === 0 ? (
        <EmptyState title={`No ${label.toLowerCase()} reports`}>
          {status === "open" ? "Nothing needs review. New reports will show up here." : "Nothing to show yet."}
        </EmptyState>
      ) : (
        <ul className="application-list">
          {reports.map((report: ContentReport) => (
            <ReportCard key={report.id} report={report} busy={Boolean(busy)} onResolve={resolve} onDecide={decide} />
          ))}
        </ul>
      )}
      {cursor && (
        <button
          type="button"
          className="load-more"
          disabled={Boolean(busy)}
          onClick={() => {
            void loadMore();
          }}
        >
          {busy === "more" ? "Loading…" : "Load more reports"}
        </button>
      )}
    </section>
  );
}
