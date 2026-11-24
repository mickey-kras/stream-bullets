import React from "react";
import { IconButton } from "../core/IconButton.jsx";
import { Button } from "../core/Button.jsx";

export function Dialog({ open = true, onOpenChange, title, description, children, actions, cancel = true, cancelLabel = "Cancel", inline = false, className = "" }) {
  React.useEffect(() => {
    if (!open || inline) return undefined;
    const k = (e) => { if (e.key === "Escape") onOpenChange && onOpenChange(false); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [open, inline, onOpenChange]);
  if (!open) return null;
  const close = () => onOpenChange && onOpenChange(false);
  const box = (
    <div className={`sb-dialog ${className}`.trim()} role="dialog" aria-modal={inline ? undefined : "true"} aria-label={title} data-inline={inline || undefined}>
      <div className="sb-dialog-head">
        <h2 tabIndex={-1}>{title}</h2>
        <IconButton label="Close" icon="close" variant="bare" onClick={close} />
      </div>
      {description && <p className="sb-dialog-desc">{description}</p>}
      {children && <div className="sb-dialog-body">{children}</div>}
      {(actions || cancel) && (
        <div className="sb-dialog-actions">
          {cancel && <Button onClick={close}>{cancelLabel}</Button>}
          {actions}
        </div>
      )}
    </div>
  );
  if (inline) return box;
  return <><div className="sb-backdrop" onClick={close} />{box}</>;
}
