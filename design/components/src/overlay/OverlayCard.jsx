import React from "react";
import { Icon } from "../core/Icon.jsx";
import { Avatar } from "../core/Avatar.jsx";

export function OverlayCard({ kind = "topic", eyebrow, title, author, authorPreset = 14, likes, when, startsIn, body, cta, messageStyle = "info", className = "", style }) {
  const eb = { topic: ["topics", "Topic spotlight"], next: ["schedule", "Up next"], card: ["community", eyebrow] }[kind];
  return (
    <article className={`sb-ov-card ${className}`.trim()} style={style}>
      {eb && <span className="sb-eyebrow"><Icon name={eb[0]} size={16} />{eyebrow || eb[1]}</span>}
      <h1>
        {kind === "message" && <Icon name={messageStyle === "hype" ? "zap" : "megaphone"} size={40} />}
        {kind === "support" && <Icon name="heart" size={40} />}
        {title}
      </h1>
      {kind === "topic" && author && (
        <p className="sb-ov-meta"><Avatar preset={authorPreset} size={44} /><span>Suggested by <strong>{author}</strong></span>
          {likes !== undefined && <span className="sb-ov-likes"><Icon name="thumbs-up" size={24} />{likes}</span>}</p>
      )}
      {kind === "next" && <p className="sb-ov-meta"><Icon name="timer" size={24} />{when}{startsIn && <span className="sb-ov-pill">{startsIn}</span>}</p>}
      {body && <p className="sb-ov-body">{body}</p>}
      {cta && <p className="sb-ov-cta">{cta}</p>}
    </article>
  );
}

export function OverlayPoll({ streamer, title, options, counts, countdown, showResults = true, className = "", style }) {
  const total = counts ? counts.reduce((a, b) => a + b, 0) : 0;
  const pct = counts ? counts.map((c) => (total ? Math.round((c * 100) / total) : 0)) : [];
  return (
    <article className={`sb-poll sb-ov-poll ${className}`.trim()} style={style}>
      <span className="sb-eyebrow">{streamer} · Live poll</span>
      <div className="sb-poll-topline"><span><span className="sb-gold-dot" />Voting live</span><span>{countdown ? <><Icon name="timer" size={16} />{countdown}</> : "No time limit"}</span></div>
      <h1>{title}</h1>
      {showResults ? (
        <div className="sb-poll-options">
          {options.map((o, i) => (
            <div key={i} className="sb-poll-option">
              <span className="sb-opt-track"><span className="sb-opt-fill" style={{ width: pct[i] + "%" }} /><span className="sb-opt-label">{o}</span></span>
              <span className="sb-opt-score"><small>{counts[i]} votes</small><span>{pct[i]}%</span></span>
            </div>
          ))}
        </div>
      ) : <p className="sb-ov-hidden">Results hidden</p>}
      <p className="sb-ov-total">{total} votes</p>
    </article>
  );
}
