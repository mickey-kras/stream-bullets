import React from "react";

// Presets 0–15 come from the 4×4 avatars.webp sprite; 16 = Jack Russell, 17 = alien. 14 = default Space explorer.
export function Avatar({ src, preset = 14, size = 42, ring = "gold", alt = "", className = "", style }) {
  const s = { width: size, height: size, ...style };
  if (src) return <img className={`sb-avatar ${className}`.trim()} src={src} alt={alt} style={s} data-ring={ring === "cream" ? "cream" : undefined} />;
  const p = preset >= 0 && preset < 18 ? preset : 14;
  const pos = p < 16 ? `${((p % 4) * 100) / 3}% ${(Math.floor(p / 4) * 100) / 3}%` : undefined;
  return <span className={`sb-avatar ${className}`.trim()} data-portrait="" data-preset={p} data-ring={ring === "cream" ? "cream" : undefined} role={alt ? "img" : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : "true"} style={{ ...s, backgroundPosition: pos }} />;
}
