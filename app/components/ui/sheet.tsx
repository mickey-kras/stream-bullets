import type { ReactNode } from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { t } from "../../i18n";
import { DialogCloseButton, SheetActionsContext, useReturnFocus } from "./dialog";
import { Icon } from "./icon";

/**
 * Sheet: a dialog for longer content (account dialogs, Contact, Edit your page). A sticky title bar with an
 * optional Back step and the × button, a scrolling body, and a footer pinned under it. On phones it fills the
 * screen; `short` keeps a centred card for brief content.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  onBack,
  short = false,
  name,
  className = "",
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Screen-reader description; the body's first paragraph usually says the same thing visibly. */
  description?: string;
  children?: ReactNode;
  /** The pinned footer, usually a <DialogActions>. A submit button there needs `form="<form id>"`. */
  actions?: ReactNode;
  /** Shows "‹ Back" before the title for a multi-step sheet. */
  onBack?: () => void;
  short?: boolean;
  /** Stable hook for styles and tests (data-sheet). */
  name?: string;
  className?: string;
}>): ReactNode {
  const focus = useReturnFocus();
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="modal-backdrop sheet-backdrop" />
        <RadixDialog.Content
          className={`modal-content sheet${short ? " is-short" : ""} ${className}`.trim()}
          data-sheet={name}
          {...(description ? {} : { "aria-describedby": undefined })}
          {...focus}
        >
          <div className="sheet-head">
            {onBack && (
              <button type="button" className="back-step" onClick={onBack}>
                <Icon name="chevron-left" size={18} />
                {t("dialog.back")}
              </button>
            )}
            <RadixDialog.Title>{title}</RadixDialog.Title>
            <DialogCloseButton />
          </div>
          {description ? <RadixDialog.Description className="sr-only">{description}</RadixDialog.Description> : null}
          <div className="sheet-body">{children}</div>
          <SheetActionsContext.Provider value={true}>{actions}</SheetActionsContext.Provider>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
