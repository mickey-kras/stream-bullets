import { createContext, useContext, useRef, type ReactNode } from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { t } from "../../i18n";
import { IconButton } from "./icon-button";

// Focus the title on open; restore the opener on close, including after rerenders.
export function useReturnFocus(): {
  onOpenAutoFocus: (event: Event) => void;
  onCloseAutoFocus: (event: Event) => void;
} {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (event: Event) => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const title: HTMLElement | null =
        event.target instanceof HTMLElement ? event.target.querySelector<HTMLElement>("h2[tabindex='-1']") : null;
      if (!title) return;
      event.preventDefault();
      title.focus();
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      const target: HTMLElement | null = opener.current;
      // Hidden account-menu opener falls back to the avatar button.
      const visible: boolean = Boolean(target?.isConnected && target.getClientRects().length > 0);
      const fallback: HTMLElement | null = document.querySelector<HTMLElement>(".account-menu-wrap > button.profile");
      (visible ? target : fallback)?.focus();
    },
  };
}

// Sheet footer docks below its scrolling body.
export const SheetActionsContext = createContext<boolean>(false);

// Close target: 40px; 44px on phones.
export function DialogCloseButton(): ReactNode {
  return (
    <RadixDialog.Close asChild>
      <IconButton className="modal-close" label={t("dialog.close")} title={t("dialog.closeTitle")} icon="close" />
    </RadixDialog.Close>
  );
}

// Sticky actions: Cancel first, primary last. cancel=false hides Cancel; onCancel runs before closing.
export function DialogActions({
  children,
  cancel = true,
  cancelLabel,
  onCancel,
  className = "",
}: Readonly<{
  children?: ReactNode;
  cancel?: boolean;
  cancelLabel?: string;
  onCancel?: () => void;
  className?: string;
}>): ReactNode {
  const docked: boolean = useContext(SheetActionsContext);
  return (
    <div className={`modal-actions sticky-actions${docked ? " sheet-actions" : ""} ${className}`.trim()}>
      {cancel && (
        <RadixDialog.Close asChild>
          <button type="button" onClick={onCancel}>
            {cancelLabel ?? t("dialog.cancel")}
          </button>
        </RadixDialog.Close>
      )}
      {children}
    </div>
  );
}

// Radix modal with optional description/footer. Restore focus on close; Escape, close button and backdrop
// dismiss it.
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  className = "",
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}>): ReactNode {
  const focus = useReturnFocus();
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="modal-backdrop sheet-backdrop" />
        <RadixDialog.Content
          className={`modal-content ${className}`.trim()}
          {...(description ? {} : { "aria-describedby": undefined })}
          {...focus}
        >
          <div className="dialog-head">
            <RadixDialog.Title tabIndex={-1}>{title}</RadixDialog.Title>
            <DialogCloseButton />
          </div>
          {description ? <RadixDialog.Description>{description}</RadixDialog.Description> : null}
          {children}
          {actions}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
