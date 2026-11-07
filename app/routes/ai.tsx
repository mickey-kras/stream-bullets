import { useState, type ReactNode } from "react";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { announce } from "../components/a11y/announcer";
import { errorMessage, postJson } from "../components/api";
import { BackLink } from "../components/shell/back-link";
import { SiteHeader } from "../components/shell/site-header";
import { Icon } from "../components/ui/icon";
import { useToast } from "../components/ui/toast";
import { appContext } from "../env";
import { intlLocale, t, type MessageId } from "../i18n";
import { aiInterestStatus, type AiInterestStatus, type AiInterestTotals } from "../server/ai.server";

export function meta() {
  return [{ title: `${t("ai.title")} · StreamBullets` }, { name: "description", content: t("ai.lead") }];
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<AiInterestStatus> {
  return aiInterestStatus(context.get(appContext).env, request, Date.now());
}

const ALLOWED: readonly MessageId[] = ["ai.can1", "ai.can2", "ai.can3"];
const NOT_YET: readonly MessageId[] = ["ai.not1", "ai.not2", "ai.not3", "ai.not4"];

/** A message with `{file}` in it, with the file name set as code. */
function WithFile({ id, file }: Readonly<{ id: MessageId; file: string }>): ReactNode {
  const [before, after = ""] = t(id).split("{file}");
  return (
    <span>
      {before}
      <code>{file}</code>
      {after}
    </span>
  );
}

function PolicyList({ items, icon }: Readonly<{ items: readonly MessageId[]; icon: "check" | "close" }>): ReactNode {
  return (
    <ul className="ai-list">
      {items.map((id: MessageId) => (
        <li key={id}>
          <Icon name={icon} size={18} />
          {id === "ai.can2" ? <WithFile id={id} file="/llms.txt" /> : t(id)}
        </li>
      ))}
    </ul>
  );
}

/** The like and dislike counter (item 45). One unverified vote per visitor per day; the IP is never stored. */
function Interest({ status }: Readonly<{ status: AiInterestStatus }>): ReactNode {
  const toast = useToast();
  const [totals, setTotals] = useState<AiInterestTotals>(status.totals);
  const [mine, setMine] = useState<AiInterestStatus["mine"]>(status.mine);
  const [busy, setBusy] = useState<boolean>(false);
  const [apiOpen, setApiOpen] = useState<boolean>(false);
  const number = new Intl.NumberFormat(intlLocale());
  async function vote(value: "up" | "down"): Promise<void> {
    setBusy(true);
    try {
      const result = await postJson<{ counted: boolean; totals: AiInterestTotals }>("/api/ai-interest", { vote: value });
      setTotals(result.totals);
      if (result.counted) setMine(value);
      const message: string = result.counted ? t(value === "up" ? "ai.countedUp" : "ai.countedDown") : t("ai.already");
      toast(message);
      announce(message);
    } catch (error: unknown) {
      toast(errorMessage(error), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="info-card ai-interest" aria-labelledby="ai-interest-title">
      <h2 id="ai-interest-title">{t("ai.interestTitle")}</h2>
      <p className="ai-counts">
        <span>
          <Icon name="thumbs-up" size={24} />
          <strong>{number.format(totals.up)}</strong> {t("ai.inFavor")}
        </span>
        <span>
          <Icon name="thumbs-down" size={24} />
          <strong>{number.format(totals.down)}</strong> {t("ai.against")}
        </span>
      </p>
      <div className="sched-actions">
        <button type="button" disabled={busy || mine !== null} aria-pressed={mine === "up"} onClick={() => void vote("up")}>
          <Icon name="thumbs-up" size={18} />
          {t("ai.voteUp")}
        </button>
        <button
          type="button"
          disabled={busy || mine !== null}
          aria-pressed={mine === "down"}
          onClick={() => void vote("down")}
        >
          <Icon name="thumbs-down" size={18} />
          {t("ai.voteDown")}
        </button>
        <button
          type="button"
          className="text-button"
          aria-expanded={apiOpen}
          aria-controls="ai-api"
          onClick={() => setApiOpen(!apiOpen)}
        >
          <Icon name="terms" size={16} />
          {t("ai.apiToggle")}
        </button>
      </div>
      <div id="ai-api" hidden={!apiOpen}>
        <pre className="code-block">
          <code>
            {"POST /api/ai-interest\nContent-Type: application/json\n\n"}
            {'{"vote":"up"|"down","agent":"<name/version>"}'}
          </code>
        </pre>
        <p className="muted">{t("ai.apiLimit")}</p>
      </div>
      {mine !== null && <p className="muted">{t("ai.already")}</p>}
      <p className="muted">{t("ai.unverified")}</p>
    </section>
  );
}

/** "For AI agents" (item 45): the agent policy, the llms.txt pointer and the interest counter. */
export default function AiPage(): ReactNode {
  const status = useLoaderData<typeof loader>();
  return (
    <>
      <SiteHeader />
      <main className="page-panel" id="main-content">
        <div className="page-column ai-page">
          <BackLink />
          <span className="eyebrow">{t("ai.eyebrow")}</span>
          <h1>{t("ai.title")}</h1>
          <p className="lead">{t("ai.lead")}</p>
          <section className="info-card" aria-labelledby="ai-can-title">
            <h2 id="ai-can-title">{t("ai.canTitle")}</h2>
            <PolicyList items={ALLOWED} icon="check" />
          </section>
          <section className="info-card" aria-labelledby="ai-not-title">
            <h2 id="ai-not-title">{t("ai.notTitle")}</h2>
            <PolicyList items={NOT_YET} icon="close" />
          </section>
          {status.available && <Interest status={status} />}
          <section className="info-card" aria-labelledby="ai-later-title">
            <h2 id="ai-later-title">{t("ai.laterTitle")}</h2>
            <p>{t("ai.later")}</p>
          </section>
        </div>
      </main>
    </>
  );
}
