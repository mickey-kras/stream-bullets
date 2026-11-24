import { Icon } from "../core/Icon.jsx";

export function TopicRow({
  title,
  icon = "cat-chatting",
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
      className={`sb-topic ${className}`.trim()}
      aria-current={selected || undefined}
      onClick={onClick}
    >
      <span className="sb-topic-icon">
        <Icon name={icon} size={32} />
      </span>
      <span className="sb-topic-main">
        <span className="sb-topic-title">{title}</span>
        <span className="sb-topic-meta">
          <span>
            <Icon name="thumbs-up-filled" size={16} />
            {likes}
          </span>
          <span>
            <Icon name="thumbs-down-filled" size={16} />
            {dislikes}
          </span>
          <span>
            <Icon name="comment" size={16} />
            {comments}
          </span>
        </span>
      </span>
      <Icon name="chevron-right" size={16} />
    </button>
  );
}
