import type { ReactNode } from "react";
import { t, tn } from "../i18n";
import { largestRemainder } from "../lib/percent";
import type { Entry, LiveSnapshot } from "../types";
import { MashCard } from "./mash/mash-card";

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
        const content: ReactNode = (
          <>
            {count !== undefined && <span className="fill" style={{ width: `${percentage}%` }} />}
            <span>
              {myVote === index ? "✓ " : ""}
              {option}
            </span>
            {count !== undefined && (
              <span className="option-score">
                <small>{tn("poll.votes", count)}</small>
                {percentage}%
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

export function PollStatus({ poll, now }: Readonly<{ poll: PublicPoll; now: number }>): ReactNode {
  const remaining: number | null = poll.endsAt === null ? null : Math.max(0, Math.ceil((poll.endsAt - now) / 1000));
  let badge: ReactNode = (
    <>
      <span className="live-dot" />
      <span>{t("poll.votingLive")}</span>
    </>
  );
  if (poll.revealed) badge = t("poll.revealed");
  else if (remaining === 0) badge = t("poll.closed");
  let countdown: string;
  if (poll.revealed) countdown = t("poll.final");
  else if (remaining === null) countdown = t("poll.noLimit");
  else if (remaining === 0) countdown = t("poll.timeUp");
  else
    countdown = t("poll.remaining", {
      time: `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`,
    });
  return (
    <div className="poll-topline">
      <span className="poll-badge">{badge}</span>
      <span className="poll-countdown">{countdown}</span>
    </div>
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
}: Readonly<{
  entry: Entry;
  now: number;
  signedIn: boolean;
  owner: boolean;
  pending: boolean;
  onAction: (body: unknown) => void;
  onDiscuss: () => void;
}>): ReactNode {
  if (entry.kind === "mash")
    return <MashCard entry={entry} now={now} signedIn={signedIn} owner={owner} pending={pending} onAction={onAction} />;
  let votingMessage: string;
  if (entry.kind === "binary" && !entry.revealed) votingMessage = t("poll.privateUntilReveal");
  else if (entry.revealed) votingMessage = t("poll.finalResults");
  else if (signedIn) votingMessage = t("poll.canChange");
  else votingMessage = t("poll.signInToVote");
  return (
    <article className="poll-card">
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
          {votingMessage}
        </p>
        {owner && !entry.revealed && (
          <button type="button" disabled={pending} onClick={() => onAction({ action: "reveal", id: entry.id })}>
            {t("poll.endReveal")}
          </button>
        )}
      </div>
      <div className="poll-engagement">
        <button
          type="button"
          disabled={!signedIn || pending}
          aria-label={t("poll.like")}
          aria-pressed={entry.reaction === 1}
          onClick={() => onAction({ action: "react", id: entry.id, value: entry.reaction === 1 ? 0 : 1 })}
        >
          {t("entry.like")} {entry.likes}
        </button>
        <button
          type="button"
          disabled={!signedIn || pending}
          aria-label={t("poll.dislike")}
          aria-pressed={entry.reaction === -1}
          onClick={() => onAction({ action: "react", id: entry.id, value: entry.reaction === -1 ? 0 : -1 })}
        >
          {t("entry.dislike")} {entry.dislikes}
        </button>
        <button type="button" className="discuss-link" onClick={onDiscuss}>
          {t("poll.discuss", { count: entry.comments })}
        </button>
        <a href={`?view=polls&entry=${entry.id}`}>{t("poll.link")}</a>
      </div>
    </article>
  );
}
