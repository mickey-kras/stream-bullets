import type { ReactNode } from 'react';
import type { Entry, LiveSnapshot } from '../types';

type PublicPoll = LiveSnapshot['polls'][number];

export function PollResults({ poll, now, myVote = null, canVote = false, pending = false, onVote }: {
  poll: PublicPoll;
  now: number;
  myVote?: number | null;
  canVote?: boolean;
  pending?: boolean;
  onVote?: (choice: number) => void;
}): ReactNode {
  const closed: boolean = poll.revealed || (poll.endsAt !== null && poll.endsAt <= now);
  return <div className={poll.kind === 'binary' ? 'poll-choices binary-votes' : 'poll-choices'}>
    {poll.options.map((option: string, index: number) => {
      const count: number | undefined = poll.counts?.[index];
      const percentage: number = count === undefined || poll.total === 0 ? 0 : Math.round(count / poll.total * 100);
      const content: ReactNode = <>
        {count !== undefined && <span className="fill" style={{ width: `${percentage}%` }} />}
        <span>{myVote === index ? '✓ ' : ''}{option}</span>
        {count !== undefined && <span className="option-score"><small>{count} {count === 1 ? 'vote' : 'votes'}</small>{percentage}%</span>}
      </>;
      return onVote
        ? <button className="poll-option" type="button" key={`${index}:${option}`} aria-pressed={myVote === index} disabled={!canVote || closed || pending} onClick={() => onVote(index)}>{content}</button>
        : <div className="poll-option" key={`${index}:${option}`}>{content}</div>;
    })}
  </div>;
}

export function PollStatus({ poll, now }: { poll: PublicPoll; now: number }): ReactNode {
  const remaining: number | null = poll.endsAt === null ? null : Math.max(0, Math.ceil((poll.endsAt - now) / 1000));
  return <div className="poll-topline">
    <span className="poll-badge">{poll.revealed ? 'Results revealed' : remaining === 0 ? 'Voting closed' : <><span className="live-dot" />Voting live</>}</span>
    <span className="poll-countdown">{poll.revealed ? 'Final' : remaining === null ? 'No time limit' : remaining === 0 ? 'Time is up' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} remaining`}</span>
  </div>;
}

export function PollCard({ entry, now, signedIn, owner, pending, onAction, onDiscuss }: {
  entry: Entry;
  now: number;
  signedIn: boolean;
  owner: boolean;
  pending: boolean;
  onAction: (body: unknown) => void;
  onDiscuss: () => void;
}): ReactNode {
  return <article className="poll-card">
    <PollStatus poll={entry} now={now} />
    <h2>{entry.title}</h2>
    <PollResults poll={entry} now={now} myVote={entry.myVote} canVote={signedIn} pending={pending} onVote={(choice: number) => onAction({ action: 'vote', id: entry.id, choice })} />
    <div className="poll-footer">
      <p>{entry.total} {entry.total === 1 ? 'vote' : 'votes'}{entry.myVote !== null && ' · Your vote is in'}<br />
        {entry.kind === 'binary' && !entry.revealed ? 'Results stay private until the host reveals them.' : entry.revealed ? 'Final results' : !signedIn ? 'Sign in to vote.' : 'You can change your vote until voting closes.'}
      </p>
      {owner && !entry.revealed && <button type="button" disabled={pending} onClick={() => onAction({ action: 'reveal', id: entry.id })}>End &amp; reveal</button>}
    </div>
    <div className="poll-engagement">
      <button type="button" disabled={!signedIn || pending} aria-label="Like poll" aria-pressed={entry.reaction === 1} onClick={() => onAction({ action: 'react', id: entry.id, value: entry.reaction === 1 ? 0 : 1 })}>Like {entry.likes}</button>
      <button type="button" disabled={!signedIn || pending} aria-label="Dislike poll" aria-pressed={entry.reaction === -1} onClick={() => onAction({ action: 'react', id: entry.id, value: entry.reaction === -1 ? 0 : -1 })}>Dislike {entry.dislikes}</button>
      <button type="button" className="discuss-link" onClick={onDiscuss}>Discuss · {entry.comments}</button>
      <a href={`?view=polls&entry=${entry.id}`}>Poll link</a>
    </div>
  </article>;
}
