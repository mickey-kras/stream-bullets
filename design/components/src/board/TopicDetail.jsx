import { Avatar } from "../core/Avatar.jsx";
import { Category } from "./Category.jsx";
import { VoteButtons } from "./VoteButtons.jsx";

export function TopicDetail({
  category,
  categoryIcon,
  number,
  title,
  author,
  authorPreset = 14,
  description,
  likes = 0,
  dislikes = 0,
  reaction = 0,
  onReact,
  children,
  className = "",
}) {
  return (
    <article className={`sb-detail ${className}`.trim()}>
      <div className="sb-detail-content">
        <div className="sb-detail-top">
          {category ? <Category icon={categoryIcon}>{category}</Category> : <span />}
          {number && <span className="sb-detail-num">{number}</span>}
        </div>
        <h1>{title}</h1>
        {author && (
          <div className="sb-author">
            <Avatar preset={authorPreset} size={32} />
            <span>
              Posted by <strong>{author}</strong>
            </span>
          </div>
        )}
        {description && <p className="sb-description">{description}</p>}
        <VoteButtons likes={likes} dislikes={dislikes} reaction={reaction} onReact={onReact} />
      </div>
      {children}
    </article>
  );
}
