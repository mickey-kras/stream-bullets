import type { ReactNode } from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { t } from "../../i18n";
import { DialogCloseButton, SheetActionsContext, useReturnFocus } from "./dialog";
import { Icon } from "./icon";

// Long-content dialog with sticky title/footer and scrolling body. Fullscreen on phones; short keeps a
// centered card.
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
  // Screen-reader description, usually repeated visibly in the body.
  description?: string;
  children?: ReactNode;
  // Pinned footer buttons need form="<form id>" to submit the body form.
  actions?: ReactNode;

  onBack?: () => void;
  short?: boolean;
  // Stable data-sheet hook for styles/tests.
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
            <RadixDialog.Title tabIndex={-1}>{title}</RadixDialog.Title>
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
