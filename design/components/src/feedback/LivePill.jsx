export function LivePill({ label = "Live", pulse = true, className = "" }) {
  return (
    <span className={`sb-live-pill ${className}`.trim()} data-pulse={pulse || undefined}>
      <span className="sb-live-dot" />
      {label}
    </span>
  );
}
