import React from "react";

export function Logo({ kind = "full", height, label = "StreamBullets", className = "" }) {
  return <span className={`sb-logo ${className}`.trim()} data-kind={kind === "icon" ? "icon" : undefined} role="img" aria-label={label} style={height ? { height } : undefined} />;
}
