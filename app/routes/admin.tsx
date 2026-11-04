import { useState, type ReactNode } from "react";
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import { appContext } from "../env";
import { configuredProviders, getViewer } from "../server/auth.server";
import { isAdmin, listApplications } from "../server/access.server";
import { SignIn, SiteHeader, EmptyState } from "../components/common";
import { errorMessage, postJson, requestJson } from "../components/api";
import { DateTime } from "../components/waitlist";
import type { ApplicationQueue, ApplicationReviewItem, ApplicationStatus } from "../types";

const statuses: { value: ApplicationStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

function statusParam(value: string | null): ApplicationStatus {
  return value === "approved" || value === "rejected" ? value : "pending";
}

export function meta() {
  return [{ title: "Streamer requests · StreamBullets" }, { name: "robots", content: "noindex" }];
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const app = context.get(appContext);
  const viewer = await getViewer(request, app);
  const providers = configuredProviders(app.env);
  const status = statusParam(new URL(request.url).searchParams.get("status"));
  if (!viewer) return { viewer: null, providers, status, queue: null };
  if (!(await isAdmin(app.env, viewer.id))) throw new Response("Page not found.", { status: 404 });
  return { viewer, providers, status, queue: await listApplications(app.env, { status, cursor: null }) };
}

function linkParts(link: string): { host: string; rest: string } {
  try {
    const url = new URL(link);
    const rest = `${url.pathname === "/" ? "" : url.pathname}${url.search}`;
    return { host: url.hostname.replace(/^www\./u, ""), rest };
  } catch {
    return { host: link, rest: "" };
  }
}

function ApplicationCard({
  application,
  busy,
  onDecide,
}: Readonly<{
  application: ApplicationReviewItem;
  busy: boolean;
  onDecide: (application: ApplicationReviewItem, decision: "approved" | "rejected") => void;
}>): ReactNode {
  const headingId = `application-${application.id}`;
  const resubmitted = application.updatedAt !== application.createdAt;
  return (
    <li>
      <article className="info-card application-card" aria-labelledby={headingId}>
        <div className="application-head">
          <div>
            <h2 id={headingId}>{application.name}</h2>
            <a className="text-link" href={`mailto:${application.email}`}>
              {application.email}
            </a>
          </div>
          <dl className="application-dates">
            <div>
              <dt>Requested</dt>
              <dd>
                <DateTime time={application.createdAt} />
              </dd>
            </div>
            {resubmitted && application.status === "pending" && (
              <div>
                <dt>Updated</dt>
                <dd>
                  <DateTime time={application.updatedAt} />
                </dd>
              </div>
            )}
            {application.reviewedAt !== null && (
              <div>
                <dt>Reviewed</dt>
                <dd>
                  <DateTime time={application.reviewedAt} />
                </dd>
              </div>
            )}
          </dl>
        </div>
        <h3 className="eyebrow">Channels</h3>
        <ul className="application-links">
          {application.links.map((link: string) => {
            const { host, rest } = linkParts(link);
            return (
              <li key={link}>
                <a href={link} target="_blank" rel="noopener noreferrer nofollow">
                  <strong>{host}</strong>
                  {rest && <span className="muted">{rest}</span>}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </li>
            );
          })}
        </ul>
        {application.note && (
          <>
            <h3 className="eyebrow">Note</h3>
            <p className="application-note">{application.note}</p>
          </>
        )}
        {application.status !== "approved" && (
          <div className="application-actions">
            <button
              type="button"
              className="gold"
              disabled={busy}
              aria-label={`Approve ${application.name}`}
              onClick={() => onDecide(application, "approved")}
            >
              Approve
            </button>
            {application.status === "pending" && (
              <button
                type="button"
                disabled={busy}
                aria-label={`Reject ${application.name}`}
                onClick={() => onDecide(application, "rejected")}
              >
                Reject
              </button>
            )}
          </div>
        )}
      </article>
    </li>
  );
}

function ReviewQueue({ status, queue }: Readonly<{ status: ApplicationStatus; queue: ApplicationQueue }>): ReactNode {
  const revalidator = useRevalidator();
  const [more, setMore] = useState<ApplicationReviewItem[]>([]);
  const [moreCursor, setMoreCursor] = useState<string | null | undefined>(undefined);
  const [decided, setDecided] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");

  const seen = new Set<string>();
  const applications = [...queue.applications, ...more].filter((application: ApplicationReviewItem) => {
    if (seen.has(application.id) || decided.has(application.id) || application.status !== status) return false;
    seen.add(application.id);
    return true;
  });
  const cursor = moreCursor === undefined ? queue.nextCursor : moreCursor;

  async function decide(application: ApplicationReviewItem, decision: "approved" | "rejected"): Promise<void> {
    if (busy) return;
    setBusy(application.id);
    setError("");
    setNotice("");
    try {
      await postJson<unknown>("/api/admin/applications", { id: application.id, decision });
      setDecided((current: Set<string>) => new Set(current).add(application.id));
      setNotice(`${decision === "approved" ? "Approved" : "Rejected"} ${application.name}.`);
      await revalidator.revalidate();
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setBusy("");
    }
  }

  async function loadMore(): Promise<void> {
    if (busy || !cursor) return;
    setBusy("more");
    setError("");
    try {
      const params = new URLSearchParams({ status, cursor });
      const page = await requestJson<ApplicationQueue>(`/api/admin/applications?${params.toString()}`);
      setMore((current: ApplicationReviewItem[]) => [...current, ...page.applications]);
      setMoreCursor(page.nextCursor);
      setNotice(`Loaded ${page.applications.length} more ${page.applications.length === 1 ? "request" : "requests"}.`);
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setBusy("");
    }
  }

  const label = statuses.find((item) => item.value === status)?.label.toLowerCase() ?? status;
  return (
    <section aria-labelledby="queue-heading">
      <h2 className="sr-only" id="queue-heading">
        {statuses.find((item) => item.value === status)?.label} requests
      </h2>
      <p className="form-error" role="alert">
        {error}
      </p>
      <output className="admin-notice">{notice}</output>
      {applications.length === 0 ? (
        <EmptyState title={`No ${label} requests`}>
          {status === "pending" ? "You're all caught up. New requests will show up here." : "Nothing to show yet."}
        </EmptyState>
      ) : (
        <ul className="application-list">
          {applications.map((application: ApplicationReviewItem) => (
            <ApplicationCard
              key={application.id}
              application={application}
              busy={Boolean(busy)}
              onDecide={(item, decision) => {
                void decide(item, decision);
              }}
            />
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
          {busy === "more" ? "Loading…" : "Load more requests"}
        </button>
      )}
    </section>
  );
}

export default function Admin(): ReactNode {
  const { viewer, providers, status, queue } = useLoaderData<typeof loader>();
  return (
    <>
      <SiteHeader viewer={viewer} providers={providers} admin={Boolean(queue)} />
      <main className="page-panel settings-page admin-page" id="main-content">
        <span className="eyebrow">ADMIN</span>
        <h1>Streamer requests</h1>
        {viewer && queue ? (
          <>
            <p>Review who can create a public streamer page. Approved viewers can claim a handle from their profile.</p>
            <nav className="tabs status-tabs" aria-label="Request status">
              {statuses.map((item) => (
                <Link
                  key={item.value}
                  to={item.value === "pending" ? "/admin" : `/admin?status=${item.value}`}
                  className={item.value === status ? "active" : ""}
                  aria-current={item.value === status ? "page" : undefined}
                  preventScrollReset
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <ReviewQueue key={status} status={status} queue={queue} />
          </>
        ) : (
          <section className="info-card">
            <h2>Sign in to continue</h2>
            <p>The review queue is only available to administrators.</p>
            <SignIn providers={providers} callbackURL="/admin" />
          </section>
        )}
      </main>
    </>
  );
}
