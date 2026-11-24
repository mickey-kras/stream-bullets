import { largestRemainder } from "../../../../app/lib/percent.ts";
import { Avatar } from "../core/Avatar.jsx";
import { Icon } from "../core/Icon.jsx";

// A poll, as in app/components/poll.tsx, and the discussion box under an open poll, as in
// app/components/streamer/polls-view.tsx. App data and actions are plain props here.

const votes = (count) => `${count} ${count === 1 ? "vote" : "votes"}`;
const percent = (share) =>
  new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 0 }).format(share / 100);

/**
 * The gold top line. `state` is "live", "closed" (the time is up) or "revealed" (the host ended the poll).
 * `countdown` is the time left of a live poll, for example "1 h 2 min left". Without it a live poll has no limit.
 */
export function PollStatus({ state = "live", countdown, kind = "choice" }) {
  let badge = (
    <>
      <span className="live-dot" />
      <span>Voting live</span>
    </>
  );
  if (state === "revealed")
    badge =
      kind === "binary" ? (
        <>
          <Icon name="eye" size={16} />
          <span>Results revealed</span>
        </>
      ) : (
        <>
          <Icon name="lock" size={16} />
          <span>Ended by host</span>
        </>
      );
  else if (state === "closed")
    badge = (
      <>
        <Icon name="lock" size={16} />
        <span>Voting closed</span>
      </>
    );
  let time = "No time limit";
  if (state === "revealed") time = "Final";
  else if (state === "closed") time = "Time is up";
  else if (countdown)
    time = (
      <>
        <Icon name="timer" size={16} />
        {countdown}
      </>
    );
  return (
    <div className="poll-topline">
      <span className="poll-badge">{badge}</span>
      <span className="poll-countdown">{time}</span>
    </div>
  );
}

/**
 * The option rows. With `counts` each row shows its bar, votes and share. With `onVote` the rows are buttons and
 * the row of `myVote` has a check mark.
 */
export function PollResults({ options, counts, myVote = null, onVote, disabled = false, kind = "choice" }) {
  const shares = largestRemainder(counts ?? []);
  return (
    <div className={kind === "binary" ? "poll-choices binary-votes" : "poll-choices"}>
      {options.map((option, index) => {
        const count = counts?.[index];
        const share = shares[index] ?? 0;
        const content = (
          <>
            <span className="opt-track">
              {count !== undefined && <span className="fill" style={{ width: `${share}%` }} />}
              <span className="opt-label">
                {onVote && myVote === index && <Icon name="check" size={16} />}
                {option}
              </span>
            </span>
            {count !== undefined && (
              <span className="option-score">
                <small>{votes(count)}</small>
                <span className="opt-pct">{percent(share)}</span>
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
            disabled={disabled}
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

function message({ kind, state, signedIn, owner, myVote }) {
  if (kind === "binary" && state !== "revealed") return "Results stay private until the host reveals them.";
  if (kind === "binary") return "Final results";
  if (state !== "live") return "Voting is closed. These are the final results.";
  if (owner) return "Viewers can vote until voting closes.";
  if (!signedIn) return "Sign in to vote.";
  return myVote === null ? "Tap an option to vote." : "You can change your vote until voting closes.";
}

// The actions menu of the poll owner: reveal or end the poll, and delete it.
function PollMenu({ title, kind, state, onReveal, onDelete }) {
  let reveal = null;
  if (state !== "revealed") {
    if (kind === "binary") reveal = "Reveal results";
    else if (state === "live") reveal = "End voting";
  }
  return (
    <details className="more-actions poll-kebab">
      <summary aria-label={`Poll actions: ${title}`}>
        <Icon name="more" size={18} />
      </summary>
      <div className="more-menu">
        {reveal && (
          <button type="button" onClick={onReveal}>
            <Icon name={kind === "binary" ? "eye" : "lock"} size={18} />
            {reveal}
          </button>
        )}
        <button type="button" onClick={onDelete}>
          <Icon name="trash" size={16} />
          Delete poll
        </button>
      </div>
    </details>
  );
}

export function PollCard({
  id,
  title,
  author,
  authorPreset = 14,
  authorUrl,
  options,
  counts,
  myVote = null,
  onVote,
  state = "live",
  countdown,
  kind = "choice",
  signedIn = true,
  owner = false,
  onReveal,
  onDelete,
  comments = 0,
  onDiscuss,
  href = "?view=polls",
  className = "",
}) {
  const total = (counts ?? []).reduce((sum, count) => sum + count, 0);
  const closed = state !== "live";
  return (
    <article className={`poll-card ${className}`.trim()} data-entry-id={id}>
      {owner && <PollMenu title={title} kind={kind} state={state} onReveal={onReveal} onDelete={onDelete} />}
      <PollStatus state={state} countdown={countdown} kind={kind} />
      <h2>{title}</h2>
      <div className="author" data-poll-author>
        <Avatar preset={authorPreset} url={authorUrl} />
        <span className="byline">
          Posted by <strong>{author}</strong>
        </span>
      </div>
      <PollResults
        options={options}
        counts={counts}
        myVote={myVote}
        onVote={onVote ?? (() => {})}
        disabled={!signedIn || closed}
        kind={kind}
      />
      <div className="poll-footer">
        <p>
          {votes(total)}
          {myVote !== null && " · Your vote is in"}
          <br />
          {message({ kind, state, signedIn, owner, myVote })}
        </p>
        {owner && state !== "revealed" && (
          <button type="button" onClick={onReveal}>
            <Icon name="eye" size={18} />
            End &amp; reveal
          </button>
        )}
      </div>
      <div className="poll-engagement">
        <button type="button" className="discuss-link" onClick={onDiscuss}>
          <Icon name="comment" size={16} />
          Discuss · {comments}
        </button>
        <a href={href}>
          <Icon name="link" size={16} />
          Poll link
          <span className="sr-only">: {title}</span>
        </a>
      </div>
    </article>
  );
}

/**
 * The box under an open poll: the Report action, the Open discussion button, and the discussion. Put a
 * <Discussion> in it as a child.
 */
export function PollDiscussion({ title, report = true, reported = false, onReport, onDiscuss, children }) {
  return (
    <div className="poll-card poll-discussion">
      <h2 className="sr-only">Discussion of poll: {title}</h2>
      {(report || reported) && (
        <div className="content-actions">
          {reported ? (
            <span className="reported-chip">
              <Icon name="flag" size={16} />
              Reported
            </span>
          ) : (
            <button type="button" aria-label="Report poll" onClick={onReport}>
              <Icon name="flag" size={16} />
              Report
            </button>
          )}
        </div>
      )}
      <button type="button" className="open-discussion gold" onClick={onDiscuss}>
        <Icon name="comment" size={18} />
        Open discussion
      </button>
      {children}
    </div>
  );
}
