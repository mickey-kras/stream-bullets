import { Icon } from "../core/Icon.jsx";

// The Like and Dislike buttons of a topic, as in app/components/streamer/vote-buttons.tsx, in the `.votes` box of
// app/components/streamer/entry-detail.tsx. Filled thumbs show the reaction of the viewer.
export function VoteButtons({
  reaction = 0,
  likes = 0,
  dislikes = 0,
  disabled = false,
  onReact,
  likeLabel = "Like",
  dislikeLabel = "Dislike",
  className = "",
}) {
  const button = (value) => {
    const like = value === 1;
    const pressed = reaction === value;
    let icon = like ? "thumbs-up" : "thumbs-down";
    if (pressed) icon = like ? "thumbs-up-filled" : "thumbs-down-filled";
    return (
      <button type="button" disabled={disabled} aria-pressed={pressed} onClick={() => onReact?.(pressed ? 0 : value)}>
        <Icon name={icon} size={24} />
        <span className="vote-word">{like ? likeLabel : dislikeLabel}</span> <b>{like ? likes : dislikes}</b>
      </button>
    );
  };
  return (
    <div className={`votes ${className}`.trim()}>
      {button(1)}
      {button(-1)}
    </div>
  );
}
