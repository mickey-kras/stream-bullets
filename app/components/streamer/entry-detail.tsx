import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { t } from "../../i18n";
import type { Entry, Viewer } from "../../types";
import { Avatar } from "../common";
import { DeleteButton } from "../discussion";
import { IdeaStatusControl } from "../ideas/idea-status-control";
import { IdeaCategoryTag, IdeaOutcome, IdeaStatus } from "../ideas/ideas";
import { ReportButton } from "../report";
import { TopicIcon, topicCategoryLabel } from "../topic-icon";
import { Icon } from "../ui/icon";
import { VoteButtons } from "./vote-buttons";

/** Delete for the author (ideas: only while under review), the streamer and admins. Report, or "Reported", for others. */
export function EntryActions({
  entry,
  viewer,
  owner,
  moderator,
  writable,
  pending,
  onDelete,
}: Readonly<{
  entry: Entry;
  viewer: Viewer | null;
  owner: boolean;
  moderator: boolean;
  /** False on a frozen or suspended page, where only admins can still remove content (mockup m14, round 2). */
  writable: boolean;
  pending: boolean;
  onDelete: () => Promise<void>;
}>): ReactNode {
  // The entry reported from here: the panel stays mounted while the viewer selects other entries.
  const [reportedId, setReportedId] = useState<string | null>(null);
  if (!viewer) return null;
  let noun: "idea" | "topic" | "poll" = entry.kind === "topic" ? "topic" : "poll";
  if (entry.status) noun = "idea";
  const author = entry.authorId === viewer.id;
  const canDelete =
    moderator || (writable && (owner || (author && (entry.status === null || entry.status === "review"))));
  const isReported = entry.reported || reportedId === entry.id;
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
            onReported={() => setReportedId(entry.id)}
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
  onStatusSaved,
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
  /** Reloads the board after an admin sets an idea's status. */
  onStatusSaved: () => Promise<void>;
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
              {topicCategoryLabel(entry.category)}
            </span>
            <Link className="text-link" to={`?view=topics&entry=${entry.id}`}>
              <Icon name="link" size={16} />
              {t("entry.topicLink")}
            </Link>
          </>
        )}
      </div>
      <h2 className="detail-title" tabIndex={-1}>
        {entry.title}
      </h2>
      <div className="author">
        <Avatar name={entry.author} url={entry.avatar} preset={entry.avatarPreset} />
        <span className="byline">
          {t(idea ? "entry.suggestedBy" : "entry.postedBy")} <strong>{entry.author}</strong>
        </span>
      </div>
      <p className="description">{entry.body}</p>
      <IdeaOutcome entry={entry} />
      <div className="votes">
        <VoteButtons
          reaction={entry.reaction}
          likes={entry.likes}
          dislikes={entry.dislikes}
          disabled={!canVote}
          onReact={onReact}
        />
      </div>
      {!viewer && <p className="muted">{t(idea ? "ideas.signInHint" : "entry.signInHint")}</p>}
      <EntryActions
        entry={entry}
        viewer={viewer}
        owner={owner}
        moderator={moderator}
        writable={writable}
        pending={pending}
        onDelete={onDelete}
      />
      {idea && moderator && (
        <IdeaStatusControl key={`${entry.id}:${entry.status}`} entry={entry} onSaved={onStatusSaved} />
      )}
    </div>
  );
}
