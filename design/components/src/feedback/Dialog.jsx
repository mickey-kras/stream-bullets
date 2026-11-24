import { useEffect, useRef } from "react";
import { IconButton } from "../core/IconButton.jsx";
import { Button } from "../core/Button.jsx";

// Native <dialog>: showModal() gives the top layer, focus containment, Escape and ::backdrop.
// closedby="any" also closes it on a backdrop click where the browser supports the attribute.
export function useModal(open, inline, onOpenChange) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !inline && dialog && !dialog.open) dialog.showModal();
  }, [open, inline]);
  const onClose = () => onOpenChange?.(false);
  return { ref, onClose, open: inline || undefined, closedby: inline ? undefined : "any" };
}

export function Dialog({
  open = true,
  onOpenChange,
  title,
  description,
  children,
  actions,
  cancel = true,
  cancelLabel = "Cancel",
  inline = false,
  className = "",
}) {
  const modal = useModal(open, inline, onOpenChange);
  if (!open) return null;
  const close = () => onOpenChange?.(false);
  return (
    <dialog {...modal} className={`sb-dialog ${className}`.trim()} aria-label={title} data-inline={inline || undefined}>
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
    </dialog>
  );
}
