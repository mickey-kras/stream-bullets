import React from "react";

export function Toast({ message, tone = "status", action, floating = false, className = "" }) {
  return (
    <div className={`sb-toast ${className}`.trim()} role={tone === "error" ? "alert" : "status"} data-tone={tone === "error" ? "error" : undefined} data-floating={floating || undefined}>
      <span>{message}</span>
      {action && <button type="button" className="sb-toast-action" onClick={action.onClick}>{action.label}</button>}
    </div>
  );
}
