import type { ReactNode } from "react";
import { Link } from "react-router";
import { t, tn } from "../i18n";
import { MASH_DRAW, MASH_NAME, mashWinner } from "../lib/mash";
import { largestRemainder } from "../lib/percent";
import type { Entry, LiveSnapshot } from "../types";
import { DeleteButton } from "./discussion";
import { formatPercent } from "./mash/mash-parts";
import { useMashView } from "./mash/use-mash";
import { VoteButtons } from "./streamer/vote-buttons";
import { Icon } from "./ui/icon";

type PublicPoll = LiveSnapshot["polls"][number];

export function PollResults({
  poll,
  now,
  myVote = null,
  canVote = false,
  pending = false,
  onVote,
}: Readonly<{
  poll: PublicPoll;
  now: number;
  myVote?: number | null;
  canVote?: boolean;
  pending?: boolean;
  onVote?: (choice: number) => void;
}>): ReactNode {
  const closed: boolean = poll.revealed || (poll.endsAt !== null && poll.endsAt <= now);
  // Largest-remainder shares always total exactly 100 (item 49).
  const shares: number[] = largestRemainder(poll.counts ?? []);
  return (
    <div className={poll.kind === "binary" ? "poll-choices binary-votes" : "poll-choices"}>
      {poll.options.map((option: string, index: number) => {
        const count: number | undefined = poll.counts?.[index];
        const percentage: number = shares[index] ?? 0;
        // The fill ends inside its own track; the score sits in a fixed column outside it (mockup M1, round 13).
        const content: ReactNode = (
          <>
            <span className="opt-track">
              {count !== undefined && <span className="fill" style={{ width: `${percentage}%` }} />}
              <span className="opt-label">
                {onVote && myVote === index && <Icon name="check" size={16} />}
                {option}
              </span>
            </span>
            {count !== undefined && (
              <span className="option-score">
                <small>{tn("poll.votes", count)}</small>
                <span className="opt-pct">{formatPercent(percentage)}</span>
              </span>
            )}
          </>
        );
        return onVote ? (
          <button
            className="poll-option"
            type="button"
            key={`${index}:${option}`}
            aria-pressed={myVote === index}
            disabled={!canVote || closed || pending}
            onClick={() => onVote(index)}
          >
            {content}
          </button>
        ) : (
          <div className="poll-option" key={`${index}:${option}`}>
            {content}
          </div>
        );
      })}
    </div>
  );
}

/** Time left as the mockup words it: "1 h 55 min left", "55 min left", "40 s left". */
export function timeLeft(seconds: number): string {
  if (seconds < 60) return t("poll.leftSeconds", { s: seconds });
  const minutes: number = Math.ceil(seconds / 60);
  if (minutes < 60) return t("poll.leftMinutes", { m: minutes });
  return t("poll.leftHours", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

export function PollStatus({ poll, now }: Readonly<{ poll: PublicPoll; now: number }>): ReactNode {
  const remaining: number | null = poll.endsAt === null ? null : Math.max(0, Math.ceil((poll.endsAt - now) / 1000));
  let badge: ReactNode = (
    <>
      <span className="live-dot" />
      <span>{t("poll.votingLive")}</span>
    </>
  );
  // A revealed choice poll was ended by the host; a revealed Yes/No poll shows its results.
  if (poll.revealed)
    badge =
      poll.kind === "binary" ? (
        <>
          <Icon name="eye" size={16} />
          <span>{t("poll.revealed")}</span>
        </>
      ) : (
        <>
          <Icon name="lock" size={16} />
          <span>{t("poll.endedByHost")}</span>
        </>
      );
  else if (remaining === 0)
    badge = (
      <>
        <Icon name="lock" size={16} />
        <span>{t("poll.closed")}</span>
      </>
    );
  let countdown: ReactNode;
  if (poll.revealed) countdown = t("poll.final");
  else if (remaining === null) countdown = t("poll.noLimit");
  else if (remaining === 0) countdown = t("poll.timeUp");
  else
    countdown = (
      <>
        <Icon name="timer" size={16} />
        {timeLeft(remaining)}
      </>
    );
  return (
    <div className="poll-topline">
      <span className="poll-badge">{badge}</span>
      <span className="poll-countdown">{countdown}</span>
    </div>
  );
}

/** The line under a poll's results: what this viewer can do now. */
function votingMessage(entry: Entry, closed: boolean, signedIn: boolean, owner: boolean): string {
  if (entry.kind === "binary" && !entry.revealed) return t("poll.privateUntilReveal");
  if (entry.revealed && entry.kind === "binary") return t("poll.finalResults");
  if (closed) return t("poll.closedFinal");
  if (owner) return t("poll.ownerCanVote");
  if (!signedIn) return t("poll.signInToVote");
  return entry.myVote === null ? t("poll.tapToVote") : t("poll.canChange");
}

/** The owner's ⋯ menu on a poll (round 9): end voting or reveal the results, and delete. */
function PollMenu({
  entry,
  closed,
  pending,
  onAction,
  onDelete,
}: Readonly<{
  entry: Entry;
  closed: boolean;
  pending: boolean;
  onAction: (body: unknown) => void;
  onDelete: () => Promise<void>;
}>): ReactNode {
  // Revealing ends a choice poll, so "End voting" and "Reveal results" are the same action here.
  let reveal: string | null = null;
  if (!entry.revealed) {
    if (entry.kind === "binary") reveal = t("poll.revealResults");
    else if (!closed) reveal = t("poll.endVoting");
  }
  return (
    <details className="more-actions poll-kebab">
      <summary aria-label={t("poll.actions", { title: entry.title })}>
        <Icon name="more" size={18} />
      </summary>
      <div className="more-menu">
        {reveal && (
          <button type="button" disabled={pending} onClick={() => onAction({ action: "reveal", id: entry.id })}>
            <Icon name={entry.kind === "binary" ? "eye" : "lock"} size={18} />
            {reveal}
          </button>
        )}
        <DeleteButton label={t("entry.delete.poll")} onDelete={onDelete} disabled={pending} />
      </div>
    </details>
  );
}

/** A Mash Battle in the polls list: a short row that opens the battle's own view (mockup M2, round 9). */
export function MashTeaser({ entry, now }: Readonly<{ entry: Entry; now: number }>): ReactNode {
  const view = useMashView(entry, now);
  const phase: string = view?.current ?? "setup";
  let label: string = t("mash.teaserSoon", { name: MASH_NAME });
  if (phase === "live" || phase === "countdown") label = t("mash.teaserLive", { name: MASH_NAME });
  if (phase === "finished" && view) {
    const winner: number = view.winner ?? mashWinner(view.totals);
    const side: string = winner === MASH_DRAW ? t("mash.draw") : (entry.options[winner] ?? "");
    label = t("mash.teaserFinal", { name: MASH_NAME, side });
  }
  return (
    <Link
      className={`poll-card mash-teaser phase-${phase === "setup" ? "waiting" : phase}`}
      to={`?view=polls&entry=${entry.id}`}
    >
      <Icon name="zap" size={24} />
      <span>
        <span className="eyebrow">
          {(phase === "live" || phase === "countdown") && <span className="live-dot" aria-hidden="true" />}
          {label}
        </span>
        <strong>{entry.title}</strong>
        <span className="muted">
          {entry.options.join(" vs ")} · {t("mash.battleLength", { n: entry.mash?.durationS ?? 0 })}
        </span>
      </span>
      <Icon name="chevron-right" size={20} />
    </Link>
  );
}

export function PollCard({
  entry,
  now,
  signedIn,
  owner,
  pending,
  onAction,
  onDiscuss,
  onDelete,
}: Readonly<{
  entry: Entry;
  now: number;
  signedIn: boolean;
  owner: boolean;
  pending: boolean;
  onAction: (body: unknown) => void;
  onDiscuss: () => void;
  onDelete: () => Promise<void>;
}>): ReactNode {
  const closed: boolean = entry.revealed || (entry.endsAt !== null && entry.endsAt <= now);
  return (
    <article className="poll-card">
      {owner && <PollMenu entry={entry} closed={closed} pending={pending} onAction={onAction} onDelete={onDelete} />}
      <PollStatus poll={entry} now={now} />
      <h2>{entry.title}</h2>
      <PollResults
        poll={entry}
        now={now}
        myVote={entry.myVote}
        canVote={signedIn}
        pending={pending}
        onVote={(choice: number) => onAction({ action: "vote", id: entry.id, choice })}
      />
      <div className="poll-footer">
        <p>
          {tn("poll.votes", entry.total)}
          {entry.myVote !== null && ` · ${t("poll.voteIn")}`}
          <br />
          {votingMessage(entry, closed, signedIn, owner)}
        </p>
        {owner && !entry.revealed && (
          <button type="button" disabled={pending} onClick={() => onAction({ action: "reveal", id: entry.id })}>
            <Icon name="eye" size={18} />
            {t("poll.endReveal")}
          </button>
        )}
      </div>
      <fieldset className="poll-react">
        <legend className="sr-only">{t("poll.reactGroup")}</legend>
        <span className="react-label" aria-hidden="true">
          {t("poll.react")}
        </span>
        <VoteButtons
          reaction={entry.reaction}
          likes={entry.likes}
          dislikes={entry.dislikes}
          disabled={!signedIn || pending}
          poll
          onReact={(value) => onAction({ action: "react", id: entry.id, value })}
        />
      </fieldset>
      <div className="poll-engagement">
        <button type="button" className="discuss-link" onClick={onDiscuss}>
          <Icon name="comment" size={16} />
          {t("poll.discuss", { count: entry.comments })}
        </button>
        <a href={`?view=polls&entry=${entry.id}`}>
          <Icon name="link" size={16} />
          {t("poll.link")}
          <span className="sr-only">: {entry.title}</span>
        </a>
      </div>
    </article>
  );
}
