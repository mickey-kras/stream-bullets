import { createContext, useContext, useRef } from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { Icon } from "../core/Icon.jsx";

// The app dialog (app/components/ui/dialog.tsx): a Radix modal with the .modal-backdrop overlay, the
// .modal-content panel and a .dialog-head row. The app CSS styles these elements and [role=dialog].

// Focus the title on open; give focus back to the opener on close.
export function useReturnFocus(returnFocus = true) {
  const opener = useRef(null);
  return {
    onOpenAutoFocus: (event) => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const title = event.target instanceof HTMLElement ? event.target.querySelector("h2[tabindex='-1']") : null;
      if (!title) return;
      event.preventDefault();
      title.focus();
    },
    onCloseAutoFocus: (event) => {
      event.preventDefault();
      if (!returnFocus) return;
      const target = opener.current;
      const visible = Boolean(target?.isConnected && target.getClientRects().length > 0);
      const fallback = document.querySelector(".account-menu-wrap > button.profile");
      (visible ? target : fallback)?.focus();
    },
  };
}

// Inside a sheet, the actions dock below the scrolling body.
export const SheetActionsContext = createContext(false);

// The IconButton markup of the app (icon-button), as a plain button so that Radix can pass its ref.
export function DialogCloseButton({ label = "Close dialog", title = "Close" }) {
  return (
    <RadixDialog.Close asChild>
      <button type="button" className="icon-button modal-close" aria-label={label} title={title}>
        <Icon name="close" size={20} />
      </button>
    </RadixDialog.Close>
  );
}

// Sticky actions: Cancel first, primary last.
export function DialogActions({ children, cancel = true, cancelLabel = "Cancel", onCancel, className = "" }) {
  const docked = useContext(SheetActionsContext);
  return (
    <div className={`modal-actions sticky-actions${docked ? " sheet-actions" : ""} ${className}`.trim()}>
      {cancel && (
        <RadixDialog.Close asChild>
          <button type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
        </RadixDialog.Close>
      )}
      {children}
    </div>
  );
}

// In a preview, `inline` shows the panel in the page flow: no portal, no backdrop, no focus trap.
export const INLINE_PANEL = { position: "relative", left: "auto", top: "auto", transform: "none", zIndex: "auto" };

// Shared frame of Dialog and Sheet.
export function ModalFrame({ open, onOpenChange, inline, returnFocus = true, children, ...content }) {
  const focus = useReturnFocus(returnFocus);
  const panel = (
    <RadixDialog.Content
      {...content}
      {...(inline
        ? {
            style: INLINE_PANEL,
            onOpenAutoFocus: (event) => event.preventDefault(),
            onInteractOutside: (event) => event.preventDefault(),
          }
        : focus)}
    >
      {children}
    </RadixDialog.Content>
  );
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange} modal={!inline}>
      {inline ? (
        panel
      ) : (
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="modal-backdrop sheet-backdrop" />
          {panel}
        </RadixDialog.Portal>
      )}
    </RadixDialog.Root>
  );
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
  onCancel,
  closeLabel = "Close dialog",
  inline = false,
  returnFocus = true,
  className = "",
}) {
  return (
    <ModalFrame
      open={open}
      onOpenChange={onOpenChange}
      inline={inline}
      returnFocus={returnFocus}
      className={`modal-content ${className}`.trim()}
      {...(description ? {} : { "aria-describedby": undefined })}
    >
      <div className="dialog-head">
        <RadixDialog.Title tabIndex={-1}>{title}</RadixDialog.Title>
        <DialogCloseButton label={closeLabel} />
      </div>
      {description ? <RadixDialog.Description>{description}</RadixDialog.Description> : null}
      {children}
      {(actions || cancel) && (
        <DialogActions cancel={cancel} cancelLabel={cancelLabel} onCancel={onCancel}>
          {actions}
        </DialogActions>
      )}
    </ModalFrame>
  );
}
