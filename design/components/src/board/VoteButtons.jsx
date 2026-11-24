import React from "react";
import { Icon } from "../core/Icon.jsx";

export function VoteButtons({ reaction = 0, likes = 0, dislikes = 0, disabled = false, size = "lg", onReact, likeLabel = "Like", dislikeLabel = "Dislike", className = "" }) {
  const btn = (v) => {
    const like = v === 1;
    const pressed = reaction === v;
    const icon = (like ? "thumbs-up" : "thumbs-down") + (pressed ? "-filled" : "");
    return (
      <button type="button" disabled={disabled} aria-pressed={pressed} onClick={() => onReact && onReact(pressed ? 0 : v)}>
        <Icon name={icon} size={24} />
        <span className="sb-vote-word">{like ? likeLabel : dislikeLabel}</span>
        <b>{like ? likes : dislikes}</b>
      </button>
    );
  };
  return <div className={`sb-votes ${className}`.trim()} data-size={size === "sm" ? "sm" : undefined} role="group">{btn(1)}{btn(-1)}</div>;
}
