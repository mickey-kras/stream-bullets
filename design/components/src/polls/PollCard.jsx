import { Icon } from "../core/Icon.jsx";
import { Avatar } from "../core/Avatar.jsx";
import { Button } from "../core/Button.jsx";
import { VoteButtons } from "../board/VoteButtons.jsx";

function shares(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return counts.map(() => 0);
  const raw = counts.map((c) => (c * 100) / total);
  const floor = raw.map(Math.floor);
  let left = 100 - floor.reduce((a, b) => a + b, 0);
  raw
    .map((r, i) => [r - floor[i], i])
    .sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => {
      if (left > 0) {
        floor[i]++;
        left--;
      }
    });
  return floor;
}

export function PollStatus({ state = "live", countdown }) {
  const badge =
    state === "live" ? (
      <>
        <span className="sb-gold-dot" />
        Voting live
      </>
    ) : state === "revealed" ? (
      <>
        <Icon name="eye" size={16} />
        Results revealed
      </>
    ) : (
      <>
        <Icon name="lock" size={16} />
        Voting closed
      </>
    );
  return (
    <div className="sb-poll-topline">
      <span>{badge}</span>
      <span>
        {countdown ? (
          <>
            <Icon name="timer" size={16} />
            {countdown}
          </>
        ) : state === "live" ? (
          "No time limit"
        ) : (
          "Final"
        )}
      </span>
    </div>
  );
}

export function PollResults({ options, counts, myVote = null, onVote, disabled = false, kind = "choice" }) {
  const pct = counts ? shares(counts) : [];
  return (
    <div className="sb-poll-options" data-kind={kind === "binary" ? "binary" : undefined}>
      {options.map((opt, i) => {
        const content = (
          <>
            <span className="sb-opt-track">
              {counts && <span className="sb-opt-fill" style={{ width: pct[i] + "%" }} />}
              <span className="sb-opt-label">
                {onVote && myVote === i && <Icon name="check" size={16} />}
                {opt}
              </span>
            </span>
            {counts && (
              <span className="sb-opt-score">
                <small>
                  {counts[i]} {counts[i] === 1 ? "vote" : "votes"}
                </small>
                <span>{pct[i]}%</span>
              </span>
            )}
          </>
        );
        return onVote ? (
          <button
            key={i}
            type="button"
            className="sb-poll-option"
            aria-pressed={myVote === i}
            disabled={disabled}
            onClick={() => onVote(i)}
          >
            {content}
          </button>
        ) : (
          <div key={i} className="sb-poll-option">
            {content}
          </div>
        );
      })}
    </div>
  );
}

export function PollCard({
  title,
  author,
  authorPreset = 14,
  options,
  counts,
  myVote = null,
  onVote,
  state = "live",
  countdown,
  kind = "choice",
  owner = false,
  onReveal,
  likes = 0,
  dislikes = 0,
  reaction = 0,
  onReact,
  comments = 0,
  onDiscuss,
  className = "",
}) {
  const total = counts ? counts.reduce((a, b) => a + b, 0) : 0;
  const msg =
    state !== "live"
      ? "Voting is closed. These are the final results."
      : myVote === null
        ? "Tap an option to vote."
        : "You can change your vote until voting closes.";
  return (
    <article className={`sb-poll ${className}`.trim()}>
      <PollStatus state={state} countdown={countdown} />
      <h2>{title}</h2>
      {author && (
        <div className="sb-author">
          <Avatar preset={authorPreset} size={32} />
          <span>
            Posted by <strong>{author}</strong>
          </span>
        </div>
      )}
      <PollResults
        options={options}
        counts={counts}
        myVote={myVote}
        onVote={onVote}
        disabled={state !== "live"}
        kind={kind}
      />
      <div className="sb-poll-footer">
        <p>
          {total} {total === 1 ? "vote" : "votes"}
          {myVote !== null && " · Your vote is in"}
          <br />
          {msg}
        </p>
        {owner && state === "live" && (
          <Button font="display" icon="eye" onClick={onReveal}>
            End & reveal
          </Button>
        )}
      </div>
      <div className="sb-poll-react">
        <span>React</span>
        <VoteButtons size="sm" likes={likes} dislikes={dislikes} reaction={reaction} onReact={onReact} />
      </div>
      <div className="sb-poll-engagement">
        <Button className="sb-discuss" icon="comment" onClick={onDiscuss}>
          Discuss · {comments}
        </Button>
        <Button icon="link">Poll link</Button>
      </div>
    </article>
  );
}
