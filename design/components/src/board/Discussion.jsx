import React from "react";
import { Avatar } from "../core/Avatar.jsx";
import { Icon } from "../core/Icon.jsx";
import { Button } from "../core/Button.jsx";
import { Select } from "../forms/Select.jsx";

export function Discussion({ title = "Discussion", count, sort = true, children, className = "" }) {
  return (
    <section className={`sb-discussion ${className}`.trim()}>
      <div className="sb-discussion-head">
        <h3>{title}</h3>
        {count !== undefined && <span className="sb-discussion-count">{count} comments</span>}
        {sort && <Select label="Sort comments" defaultValue="top" style={{ width: 125 }} options={[{ value: "top", label: "Top" }, { value: "new", label: "Newest" }]} />}
      </div>
      {children}
    </section>
  );
}

export function Comment({ name, role, preset = 14, time, children, likes = 0, liked = false, reply = false, onLike, onReply }) {
  return (
    <div className="sb-comment" data-reply={reply || undefined}>
      <Avatar preset={preset} size={42} />
      <div className="sb-comment-body">
        <div className="sb-comment-meta"><strong>{name}</strong>{role && <small>{role}</small>}{time && <time>{time}</time>}</div>
        <p>{children}</p>
        <div className="sb-comment-actions">
          <button type="button" aria-pressed={liked} onClick={onLike}><Icon name={liked ? "thumbs-up-filled" : "thumbs-up"} size={20} />{likes}</button>
          <button type="button" onClick={onReply}><Icon name="reply" size={18} />Reply</button>
        </div>
      </div>
    </div>
  );
}

export function Composer({ placeholder = "Write a comment…", postLabel = "Post", value, onChange, onPost, replyingTo }) {
  return (
    <>
      {replyingTo && <p className="sb-replying">Replying to {replyingTo}</p>}
      <div className="sb-composer">
        <textarea rows={1} placeholder={placeholder} value={value} onChange={onChange} aria-label={placeholder} />
        <Button variant="gold" onClick={onPost}>{postLabel}</Button>
      </div>
    </>
  );
}
