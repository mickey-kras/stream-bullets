// The live badge next to the streamer name while an event of the schedule runs (app/routes/streamer.tsx).
// It links to the schedule. `title` is the event, for screen readers.
export function LivePill({ label = "Scheduled now", title, href = "?view=schedule", className = "" }) {
  return (
    <a className={`live-pill ${className}`.trim()} href={href}>
      <span className="live-dot" aria-hidden="true" />
      {label}
      {title && <span className="sr-only">: {title}</span>}
    </a>
  );
}

// The on-air strip under the streamer header while an event runs.
export function OnAirTicker({ title, label = "Scheduled now", href = "?view=schedule" }) {
  return (
    <a className="onair-ticker-link" href={href}>
      <span className="live-dot" aria-hidden="true" />
      <strong>{label}</strong>
      <span className="onair-ticker-title">{title}</span>
    </a>
  );
}
