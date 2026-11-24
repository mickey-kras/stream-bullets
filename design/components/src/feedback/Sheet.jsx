import { Dialog as RadixDialog } from "radix-ui";
import { Icon } from "../core/Icon.jsx";
import { DialogActions, DialogCloseButton, ModalFrame, SheetActionsContext } from "./Dialog.jsx";

// The app sheet (app/components/ui/sheet.tsx): a long dialog with a sticky head, a scrolling body and docked
// actions. It fills the screen on phones; `short` keeps a centered card.
export function Sheet({
  open = true,
  onOpenChange,
  title,
  description,
  onBack,
  backLabel = "Back",
  children,
  actions,
  cancel = true,
  cancelLabel = "Cancel",
  onCancel,
  closeLabel = "Close dialog",
  short = false,
  name,
  inline = false,
  className = "",
}) {
  return (
    <ModalFrame
      open={open}
      onOpenChange={onOpenChange}
      inline={inline}
      className={`modal-content sheet${short ? " is-short" : ""} ${className}`.trim()}
      data-sheet={name}
      {...(description ? {} : { "aria-describedby": undefined })}
    >
      <div className="sheet-head">
        {onBack && (
          <button type="button" className="back-step" onClick={onBack}>
            <Icon name="chevron-left" size={18} />
            {backLabel}
          </button>
        )}
        <RadixDialog.Title tabIndex={-1}>{title}</RadixDialog.Title>
        <DialogCloseButton label={closeLabel} />
      </div>
      {description ? <RadixDialog.Description className="sr-only">{description}</RadixDialog.Description> : null}
      <div className="sheet-body">{children}</div>
      {actions && (
        <SheetActionsContext.Provider value={true}>
          <DialogActions cancel={cancel} cancelLabel={cancelLabel} onCancel={onCancel}>
            {actions}
          </DialogActions>
        </SheetActionsContext.Provider>
      )}
    </ModalFrame>
  );
}
