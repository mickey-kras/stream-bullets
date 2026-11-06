import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { t } from "../../i18n";
import type { Entry, Viewer } from "../../types";
import { Avatar } from "../common";
import { DeleteButton } from "../discussion";
import { IdeaCategoryTag, IdeaOutcome, IdeaStatus } from "../ideas/ideas";
import { ReportButton } from "../report";
import { TopicIcon } from "../topic-icon";
import { Icon } from "../ui/icon";

/** Delete for the author (ideas: only while under review), the streamer and admins. Report, or "Reported", for others. */
export function EntryActions({
  entry,
  viewer,
  owner,
  moderator,
  pending,
  onDelete,
}: Readonly<{
  entry: Entry;
  viewer: Viewer | null;
  owner: boolean;
  moderator: boolean;
  pending: boolean;
  onDelete: () => Promise<void>;
}>): ReactNode {
  const [reported, setReported] = useState<boolean>(false);
  if (!viewer) return null;
  const noun = entry.status ? "idea" : entry.kind === "topic" ? "topic" : "poll";
  const author = entry.authorId === viewer.id;
  const canDelete = owner || moderator || (author && (entry.status === null || entry.status === "review"));
  const isReported = entry.reported || reported;
  if (!canDelete && author) return null;
  return (
    <div className="content-actions">
      {canDelete && <DeleteButton label={t(`entry.delete.${noun}`)} onDelete={onDelete} disabled={pending} />}
      {!author &&
        (isReported ? (
          <span className="reported-chip">
            <Icon name="flag" size={16} />
            {t("discussion.reported")}
          </span>
        ) : (
          <ReportButton
            targetKind="entry"
            targetId={entry.id}
            label={t(`entry.report.${noun}`)}
            description={t("entry.reportBody", { title: entry.title })}
            onReported={() => setReported(true)}
          />
        ))}
    </div>
  );
}

/** A topic or idea: category, title, author, details, votes and actions. The discussion follows it. */
export function EntryDetail({
  entry,
  viewer,
  owner,
  moderator,
  writable,
  pending,
  onBack,
  onReact,
  onDelete,
}: Readonly<{
  entry: Entry;
  viewer: Viewer | null;
  owner: boolean;
  moderator: boolean;
  writable: boolean;
  pending: boolean;
  onBack: () => void;
  onReact: (value: -1 | 0 | 1) => void;
  onDelete: () => Promise<void>;
}>): ReactNode {
  const idea = entry.status !== null;
  const canVote = Boolean(viewer) && writable && !pending;
  return (
    <div className="topic-content">
      <button type="button" className="back" onClick={onBack}>
        <Icon name="chevron-left" size={16} />
        {t(idea ? "ideas.allIdeas" : "entry.allTopics")}
      </button>
      <div className="detail-top">
        {idea ? (
          <>
            <IdeaCategoryTag category={entry.category} />
            <IdeaStatus status={entry.status} />
          </>
        ) : (
          <>
            <span className="category">
              <TopicIcon category={entry.category} />
              {entry.category}
            </span>
            <Link className="text-link" to={`?view=topics&entry=${entry.id}`}>
              <Icon name="link" size={16} />
              {t("entry.topicLink")}
            </Link>
          </>
        )}
      </div>
      <h2>{entry.title}</h2>
      <div className="author">
        <Avatar name={entry.author} url={entry.avatar} />
        <span className="byline">
          {t(idea ? "entry.suggestedBy" : "entry.postedBy")} <strong>{entry.author}</strong>
        </span>
      </div>
      <p className="description">{entry.body}</p>
      <IdeaOutcome entry={entry} />
      <div className="votes">
        <button
          type="button"
          disabled={!canVote}
          aria-pressed={entry.reaction === 1}
          onClick={() => onReact(entry.reaction === 1 ? 0 : 1)}
        >
          <Icon name={entry.reaction === 1 ? "thumbs-up-filled" : "thumbs-up"} size={24} />
          <span className="vote-word">{t("entry.like")}</span> <b>{entry.likes}</b>
        </button>
        <button
          type="button"
          disabled={!canVote}
          aria-pressed={entry.reaction === -1}
          onClick={() => onReact(entry.reaction === -1 ? 0 : -1)}
        >
          <Icon name={entry.reaction === -1 ? "thumbs-down-filled" : "thumbs-down"} size={24} />
          <span className="vote-word">{t("entry.dislike")}</span> <b>{entry.dislikes}</b>
        </button>
      </div>
      {!viewer && <p className="muted">{t(idea ? "ideas.signInHint" : "entry.signInHint")}</p>}
      <EntryActions
        entry={entry}
        viewer={viewer}
        owner={owner}
        moderator={moderator}
        pending={pending}
        onDelete={onDelete}
      />
    </div>
  );
}
