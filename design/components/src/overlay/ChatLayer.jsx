import React from "react";

// Platform glyphs from app/components/overlay/wasteland/glyphs.tsx (24×24; fill or 2px stroke).
const GLYPHS = {
  youtube: [["M6 5h12a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z", "stroke"], ["m10 8 6 4-6 4z", "fill"]],
  twitch: [["M4 2h18v13l-6 6h-5l-4 3v-3H2V6zm1 3v12h5v3l3-3h4l3-3V5z", "fill"], ["M11 7v6m5-6v6", "stroke"]],
  kick: [["M3 3h5v7h3V7h3V3h7v6h-4v3h-3v2h3v3h4v4h-7v-3h-3v-3H8v6H3z", "fill"]],
};
const NAMES = { youtube: "YouTube", twitch: "Twitch", kick: "Kick" };

function PlatformIcon({ platform }) {
  return (
    <>
      <svg className="sb-chat-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        {(GLYPHS[platform] || []).map(([d, paint]) => paint === "fill" ? <path key={d} fill="currentColor" d={d} /> : <path key={d} fill="none" stroke="currentColor" strokeWidth="2" d={d} />)}
      </svg>
      <span className="sr-only">{NAMES[platform]} </span>
    </>
  );
}

function short(name, max = 20) {
  const chars = Array.from(name);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : name;
}

export function ChatLayer({ rows, backgroundOpacity = 100, test = false, absolute = true, className = "", style }) {
  return (
    <ol className={`sb-chat ${className}`.trim()} data-static={absolute ? undefined : ""} data-outline={backgroundOpacity < 50 || undefined} aria-label="Chat" style={{ "--wl-bg": String(backgroundOpacity / 100), ...style }}>
      {test && <li className="sb-chat-test" aria-hidden="true">TEST</li>}
      {rows.map((r, i) => (
        <li key={r.id ?? i} className="sb-chat-item" data-phase={r.removed ? "removed" : undefined} data-newest={(i === rows.length - 1 && !r.removed) || undefined} data-enter={r.enter || undefined}>
          <div className="sb-chat-card">
            <span className="sb-chat-line">
              <PlatformIcon platform={r.platform} />
              {!r.removed && (r.badges || []).slice(0, 2).map((b) => <span key={b} className="sb-chat-badge">{b}</span>)}
              <span className="sb-chat-user"><bdi>{short(r.name)}</bdi>: </span>
              <span className="sb-chat-msg" dir="auto">{r.removed ? "message removed by a moderator" : r.text}</span>
            </span>
            <svg className="sb-chat-vault" viewBox="0 0 36 24" aria-hidden="true" focusable="false"><path d="M1 9h10M1 15h10M25 9h10M25 15h10" /><circle cx="18" cy="12" r="9" /><circle cx="18" cy="12" r="4" /></svg>
          </div>
        </li>
      ))}
    </ol>
  );
}
