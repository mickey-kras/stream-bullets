import React from "react";
import { IconButton } from "../core/IconButton.jsx";
import { Icon } from "../core/Icon.jsx";

export function Sheet({ open = true, onOpenChange, title, onBack, backLabel = "Back", children, actions, inline = false, className = "" }) {
  if (!open) return null;
  const close = () => onOpenChange && onOpenChange(false);
  const box = (
    <div className={`sb-dialog sb-sheet ${className}`.trim()} role="dialog" aria-label={title} data-inline={inline || undefined}>
      <div className="sb-dialog-head">
        {onBack && <button type="button" className="sb-back" onClick={onBack}><Icon name="chevron-left" size={18} />{backLabel}</button>}
        <h2 tabIndex={-1} style={{ flex: 1 }}>{title}</h2>
        <IconButton label="Close" icon="close" variant="bare" onClick={close} />
      </div>
      <div className="sb-sheet-body">{children}</div>
      {actions && <div className="sb-dialog-actions">{actions}</div>}
    </div>
  );
  if (inline) return box;
  return <><div className="sb-backdrop" onClick={close} />{box}</>;
}
