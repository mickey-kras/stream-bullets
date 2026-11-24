import { Icon } from "../core/Icon.jsx";
import { categoryIcon } from "./Category.jsx";

const plural = (count, one, other) => `${count} ${count === 1 ? one : other}`;

// One row of the topic list, as in app/components/streamer/topic-board.tsx.
export function TopicRow({
  id,
  title,
  icon,
  category,
  likes = 0,
  dislikes = 0,
  comments = 0,
  selected = false,
  onClick,
  className = "",
}) {
  return (
    <button
      type="button"
      className={`topic ${selected ? "selected" : ""} ${className}`.trim()}
      aria-pressed={selected}
      data-entry-id={id}
      onClick={onClick}
    >
      <span className="topic-icon">
        <Icon name={icon ?? categoryIcon(category)} size={24} />
      </span>
      <span className="topic-main">
        <span className="topic-title">{title}</span>
        <span className="topic-meta">
          <span className="sr-only">
            {`${plural(likes, "like", "likes")}, ${plural(dislikes, "dislike", "dislikes")}, ${plural(comments, "comment", "comments")}`}
          </span>
          <span aria-hidden="true">
            <Icon name="thumbs-up" size={16} />
            {likes}
          </span>
          <span aria-hidden="true">
            <Icon name="thumbs-down" size={16} />
            {dislikes}
          </span>
          <span aria-hidden="true">
            <Icon name="comment" size={16} />
            {comments}
          </span>
        </span>
      </span>
      <span className="topic-chevron" aria-hidden="true">
        <Icon name="chevron-right" size={18} />
      </span>
    </button>
  );
}
