export function Logo({ kind = "full", height, label = "StreamBullets", className = "" }) {
  return (
    <span
      className={`sb-logo ${className}`.trim()}
      data-kind={kind === "icon" ? "icon" : undefined}
      style={height ? { height } : undefined}
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}
