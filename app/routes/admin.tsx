import { useState, type ReactNode } from "react";
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import type { ReportGroupFilter } from "../admin-types";
import { appContext } from "../env";
import { t, type MessageId } from "../i18n";
import { configuredProviders } from "../server/auth.server";
import { requestSession } from "../lib/shell.server";
import { isAdmin, listApplications } from "../server/access.server";
import { listModerationPages, pageQuerySchema } from "../server/moderation.server";
import { listReportGroups, reportGroupQuerySchema } from "../server/report-groups.server";
import { getStepUpStatus, listKeys, requireAdminSession } from "../server/stepup.server";
import { SignIn, SiteHeader, EmptyState } from "../components/common";
import { BackLink } from "../components/shell/back-link";
import { errorMessage, postJson, requestJson } from "../components/api";
import { DateTime } from "../components/waitlist";
import { KeyConfirm } from "../components/admin/key-confirm";
import { KeySetup, SecurityKeys } from "../components/admin/security-keys";
import { ReportGroups } from "../components/admin/report-groups";
import { StreamerPages, type PageFilter } from "../components/admin/streamer-pages";
import { Icon, type IconName } from "../components/ui/icon";
import type { ApplicationQueue, ApplicationReviewItem, ApplicationStatus } from "../types";

const statuses: { value: ApplicationStatus; label: MessageId }[] = [
  { value: "pending", label: "admin.requests.pending" },
  { value: "approved", label: "admin.requests.approved" },
  { value: "rejected", label: "admin.requests.rejected" },
];

type AdminView = "requests" | "reports" | "pages" | "keys";

const views: { value: AdminView; icon: IconName; label: MessageId; short: MessageId; to: string }[] = [
  {
    value: "requests",
    icon: "requests",
    label: "admin.view.requests",
    short: "admin.view.requestsShort",
    to: "/admin",
  },
  {
    value: "reports",
    icon: "flag",
    label: "admin.view.reports",
    short: "admin.view.reportsShort",
    to: "/admin?view=reports",
  },
  {
    value: "pages",
    icon: "streamers",
    label: "admin.view.pages",
    short: "admin.view.pagesShort",
    to: "/admin?view=pages",
  },
  { value: "keys", icon: "key", label: "admin.view.keys", short: "admin.view.keysShort", to: "/admin?view=keys" },
];

function viewParam(value: string | null): AdminView {
  return value === "reports" || value === "pages" || value === "keys" ? value : "requests";
}

function statusParam(value: string | null): ApplicationStatus {
  return value === "approved" || value === "rejected" ? value : "pending";
}

function reportFilterParam(value: string | null): ReportGroupFilter {
  return value === "resolved" || value === "all" ? value : "open";
}

export function meta() {
  return [{ title: `${t("account.admin")} · StreamBullets` }, { name: "robots", content: "noindex" }];
}

/**
 * Admin data loads only after the server-side gate: an administrator, and under ADMIN_STEP_UP=enforce two
 * registered keys and a step-up in this session from the last 15 minutes. The API checks the same on every call.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const app = context.get(appContext);
  const session = await requestSession(request, app);
  const providers = configuredProviders(app.env);
  const params = new URL(request.url).searchParams;
  const view = viewParam(params.get("view"));
  const base = {
    providers,
    view,
    screen: "admin" as "signed-out" | "setup" | "gate" | "admin",
    stepUp: null as Awaited<ReturnType<typeof getStepUpStatus>> | null,
    keys: [] as Awaited<ReturnType<typeof listKeys>>,
    status: statusParam(params.get("status")),
    reportFilter: reportFilterParam(params.get("status")),
    pageFilter: "all" as PageFilter,
    pageQuery: "",
    reportQuery: "",
    queue: null as ApplicationQueue | null,
    groups: null as Awaited<ReturnType<typeof listReportGroups>> | null,
    pages: null as Awaited<ReturnType<typeof listModerationPages>> | null,
  };
  if (!session) return { ...base, screen: "signed-out" as const };
  if (!(await isAdmin(app.env, session.viewer.id))) throw new Response("Page not found.", { status: 404 });
  const stepUp = await getStepUpStatus(request, app);
  const keys = await listKeys(app.env, session.viewer.id);
  if (stepUp.need === "keys") return { ...base, screen: "setup" as const, stepUp, keys };
  if (stepUp.need === "step_up") return { ...base, screen: "gate" as const, stepUp, keys };
  const admin = await requireAdminSession(request, app);
  const ready = { ...base, stepUp, keys };
  if (view === "reports") {
    const parsed = reportGroupQuerySchema.safeParse({
      group: "streamer",
      status: ready.reportFilter,
      query: params.get("query") ?? undefined,
    });
    const query = parsed.success ? parsed.data : { group: "streamer" as const, status: ready.reportFilter };
    return {
      ...ready,
      reportQuery: parsed.success ? parsed.data.query : "",
      groups: await listReportGroups(app.env, admin.viewer.id, query),
    };
  }
  if (view === "pages") {
    const parsed = pageQuerySchema.safeParse({
      status: params.get("status") ?? undefined,
      query: params.get("query") ?? undefined,
    });
    const query = parsed.success ? parsed.data : { status: "all" as const, query: "", cursor: null };
    return {
      ...ready,
      pageFilter: query.status,
      pageQuery: query.query,
      pages: await listModerationPages(app.env, admin.viewer.id, query),
    };
  }
  if (view === "keys") return ready;
  return { ...ready, queue: await listApplications(app.env, { status: ready.status, cursor: null }) };
}

type LoaderData = ReturnType<typeof useLoaderData<typeof loader>>;

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
              <dt>{t("admin.requests.requested")}</dt>
              <dd>
                <DateTime time={application.createdAt} />
              </dd>
            </div>
            {resubmitted && application.status === "pending" && (
              <div>
                <dt>{t("admin.requests.updated")}</dt>
                <dd>
                  <DateTime time={application.updatedAt} />
                </dd>
              </div>
            )}
            {application.reviewedAt !== null && (
              <div>
                <dt>{t("admin.requests.reviewed")}</dt>
                <dd>
                  <DateTime time={application.reviewedAt} />
                </dd>
              </div>
            )}
          </dl>
        </div>
        <h3 className="eyebrow">{t("admin.requests.channels")}</h3>
        <ul className="application-links">
          {application.links.map((link: string) => {
            const { host, rest } = linkParts(link);
            return (
              <li key={link}>
                <a href={link} target="_blank" rel="noopener noreferrer nofollow">
                  <strong>{host}</strong>
                  {rest && <span className="muted">{rest}</span>}
                  <span className="sr-only"> {t("common.newTab")}</span>
                </a>
              </li>
            );
          })}
        </ul>
        {application.note && (
          <>
            <h3 className="eyebrow">{t("admin.requests.note")}</h3>
            <p className="application-note">{application.note}</p>
          </>
        )}
        {application.status !== "approved" && (
          <div className="application-actions">
            <button
              type="button"
              className="gold"
              disabled={busy}
              aria-label={t("admin.requests.approveName", { name: application.name })}
              onClick={() => onDecide(application, "approved")}
            >
              <Icon name="approve" size={18} />
              {t("admin.requests.approve")}
            </button>
            {application.status === "pending" && (
              <button
                type="button"
                disabled={busy}
                aria-label={t("admin.requests.rejectName", { name: application.name })}
                onClick={() => onDecide(application, "rejected")}
              >
                <Icon name="reject" size={18} />
                {t("admin.requests.reject")}
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

  const label = t(statuses.find((item) => item.value === status)?.label ?? "admin.requests.pending");
  return (
    <section aria-labelledby="queue-heading">
      <h2 className="sr-only" id="queue-heading">
        {t("admin.requests.heading", { status: label })}
      </h2>
      <p className="form-error" role="alert">
        {error}
      </p>
      <output className="admin-notice">{notice}</output>
      {applications.length === 0 ? (
        <EmptyState title={t("admin.requests.empty", { status: label.toLowerCase() })} icon="requests">
          {status === "pending" ? t("admin.requests.caughtUp") : t("admin.nothingYet")}
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
          {busy === "more" ? t("account.loading") : t("admin.requests.more")}
        </button>
      )}
    </section>
  );
}

function RequestsView({ status, queue }: Readonly<{ status: ApplicationStatus; queue: ApplicationQueue }>): ReactNode {
  return (
    <>
      <p>{t("admin.requests.intro")}</p>
      <nav className="tabs status-tabs level-2" aria-label={t("admin.requests.statusLabel")}>
        {statuses.map((item) => (
          <Link
            key={item.value}
            to={item.value === "pending" ? "/admin" : `/admin?status=${item.value}`}
            className={item.value === status ? "active" : ""}
            aria-current={item.value === status ? "page" : undefined}
            preventScrollReset
          >
            {t(item.label)}
          </Link>
        ))}
      </nav>
      <ReviewQueue key={status} status={status} queue={queue} />
    </>
  );
}

function ViewTabs({ current }: Readonly<{ current: AdminView }>): ReactNode {
  return (
    <nav className="tabs status-tabs view-tabs" aria-label={t("admin.sections")}>
      {views.map((item) => (
        <Link
          key={item.value}
          to={item.to}
          className={item.value === current ? "active" : ""}
          aria-current={item.value === current ? "page" : undefined}
          preventScrollReset
        >
          <Icon name={item.icon} size={18} />
          <span className="tab-long">{t(item.label)}</span>
          <span className="tab-short" aria-hidden="true">
            {t(item.short)}
          </span>
        </Link>
      ))}
    </nav>
  );
}

function AdminContent({ data }: Readonly<{ data: LoaderData }>): ReactNode {
  if (data.view === "keys" && data.stepUp) return <SecurityKeys status={data.stepUp} keys={data.keys} />;
  if (data.groups)
    return (
      <ReportGroups
        key={`${data.reportFilter}:${data.reportQuery}`}
        filter={data.reportFilter}
        query={data.reportQuery}
        list={data.groups}
      />
    );
  if (data.pages)
    return (
      <StreamerPages
        key={`${data.pageFilter}:${data.pageQuery}`}
        filter={data.pageFilter}
        query={data.pageQuery}
        list={data.pages}
      />
    );
  if (data.queue) return <RequestsView status={data.status} queue={data.queue} />;
  return null;
}

/** Under ADMIN_STEP_UP=report: a reminder until two keys exist. Admin still opens. */
function KeysReminder({ data }: Readonly<{ data: LoaderData }>): ReactNode {
  if (data.stepUp?.mode !== "report" || data.stepUp.keys >= data.stepUp.requiredKeys) return null;
  if (data.view === "keys") return null;
  return (
    <div className="application-status pending">
      <strong>
        <Icon name="key" size={18} />
        {t("admin.keysReminderTitle")}
      </strong>
      <p>
        {t("admin.keysReminderBody")} <Link to="/admin?view=keys">{t("admin.keysReminderLink")}</Link>
      </p>
    </div>
  );
}

function Gate({ onSkip }: Readonly<{ onSkip?: () => void }>): ReactNode {
  const revalidator = useRevalidator();
  return (
    <>
      <span className="eyebrow">{t("account.admin")}</span>
      <KeyConfirm
        pageHeading
        onConfirmed={async () => {
          await revalidator.revalidate();
        }}
      />
      {onSkip && (
        <p className="muted">
          {t("admin.reportModeSkipHint")}{" "}
          <button type="button" className="text-button" onClick={onSkip}>
            {t("admin.reportModeSkip")}
          </button>
        </p>
      )}
    </>
  );
}

export default function Admin(): ReactNode {
  const data = useLoaderData<typeof loader>();
  const [skipped, setSkipped] = useState<boolean>(false);
  const { providers, view, screen, stepUp } = data;
  const sectionLabel = t(views.find((item) => item.value === view)?.label ?? "admin.view.requests");
  // Report mode: ask for the key like enforce would, but let the admin continue (the server logs it).
  const softGate =
    screen === "admin" &&
    stepUp?.mode === "report" &&
    stepUp.keys >= stepUp.requiredKeys &&
    stepUp.freshUntil === null &&
    !skipped;

  let body: ReactNode;
  if (screen === "signed-out")
    body = (
      <>
        <BackLink />
        <h1>{t("account.admin")}</h1>
        <section className="info-card">
          <h2>{t("admin.signInTitle")}</h2>
          <p>{t("admin.signInBody")}</p>
          <SignIn providers={providers} callbackURL={view === "requests" ? "/admin" : `/admin?view=${view}`} />
        </section>
      </>
    );
  else if (screen === "setup" && stepUp) body = <KeySetup standalone status={stepUp} keys={data.keys} />;
  else if (screen === "gate") body = <Gate />;
  else if (softGate) body = <Gate onSkip={() => setSkipped(true)} />;
  else
    body = (
      <>
        <BackLink />
        <h1>
          {t("account.admin")}
          <span className="sr-only">: {sectionLabel}</span>
        </h1>
        <KeysReminder data={data} />
        <ViewTabs current={view} />
        <AdminContent data={data} />
      </>
    );

  const narrow = screen === "setup" || screen === "gate" || softGate;
  return (
    <>
      <SiteHeader />
      <main className="page-panel settings-page admin-page" id="main-content">
        <div className={`page-column${narrow ? " gate-column" : ""}`}>{body}</div>
      </main>
    </>
  );
}
