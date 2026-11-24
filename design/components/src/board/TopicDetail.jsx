import { Avatar } from "../core/Avatar.jsx";
import { Icon } from "../core/Icon.jsx";
import { Category } from "./Category.jsx";
import { VoteButtons } from "./VoteButtons.jsx";

// The selected topic, as in app/components/streamer/entry-detail.tsx inside the `#detail` panel of
// app/components/streamer/topic-board.tsx. The CSS puts the vote buttons in a rail on the left of the topic.
// Put a <Discussion> in it as a child: the app shows the discussion under the topic, in the same panel.
export function TopicDetail({
  category = "Tech & setups",
  categoryIcon,
  title,
  author,
  authorPreset = 14,
  authorUrl,
  description,
  likes = 0,
  dislikes = 0,
  reaction = 0,
  onReact,
  signedIn = true,
  topicLink = "?view=topics",
  backLabel = "All topics",
  onBack,
  onDiscuss,
  report = true,
  reported = false,
  onReport,
  children,
  className = "",
}) {
  return (
    <section className={`detail ${className}`.trim()} id="detail" aria-label="Selected topic">
      <div className="topic-content">
        <button type="button" className="back" onClick={onBack}>
          <Icon name="chevron-left" size={16} />
          {backLabel}
        </button>
        <div className="detail-top">
          <Category icon={categoryIcon} category={category} />
          <a className="text-link" href={topicLink}>
            <Icon name="link" size={16} />
            Topic link
          </a>
        </div>
        <h2 className="detail-title" tabIndex={-1}>
          {title}
        </h2>
        <div className="author">
          <Avatar preset={authorPreset} url={authorUrl} />
          <span className="byline">
            Posted by <strong>{author}</strong>
          </span>
        </div>
        <p className="description">{description}</p>
        <button type="button" className="open-discussion gold" onClick={onDiscuss}>
          <Icon name="comment" size={18} />
          Open discussion
        </button>
        <VoteButtons reaction={reaction} likes={likes} dislikes={dislikes} disabled={!signedIn} onReact={onReact} />
        {!signedIn && <p className="muted">Sign in to vote or suggest a topic.</p>}
        {signedIn && (report || reported) && (
          <div className="content-actions">
            {reported ? (
              <span className="reported-chip">
                <Icon name="flag" size={16} />
                Reported
              </span>
            ) : (
              <button type="button" aria-label="Report topic" onClick={onReport}>
                <Icon name="flag" size={16} />
                Report
              </button>
            )}
          </div>
        )}
      </div>
      {children}
    </section>
  );
}
