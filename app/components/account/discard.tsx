import { useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../../i18n";

// Describe unsaved changes. Focus Keep editing; Escape retains edits.
export function DiscardConfirm({
  changes,
  onKeep,
  onDiscard,
}: Readonly<{ changes: readonly string[]; onKeep: () => void; onDiscard: () => void }>): ReactNode {
  const keep = useRef<HTMLButtonElement | null>(null);
  useEffect(() => keep.current?.focus({ preventScroll: true }), []);
  return (
    <div
      className="discard-confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="discard-title"
      aria-describedby="discard-desc"
    >
      <div className="discard-box">
        <h3 id="discard-title">{t("discard.title")}</h3>
        <div id="discard-desc">
          <p>{t("discard.body")}</p>
          {changes.length > 0 && (
            <>
              <p className="discard-list-label">{t("discard.listLabel")}</p>
              <ul className="discard-list">
                {changes.map((change: string) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" ref={keep} onClick={onKeep}>
            {t("discard.keep")}
          </button>
          <button type="button" className="danger" onClick={onDiscard}>
            {t("discard.discard")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Pass onOpenChange to Sheet and render confirm inside it to guard dirty closure.
export function useDiscardGuard(
  changes: readonly string[],
  close: () => void,
): { onOpenChange: (open: boolean) => void; confirm: ReactNode; requestClose: () => void } {
  const [asking, setAsking] = useState<boolean>(false);
  const requestClose = (): void => {
    if (asking) setAsking(false);
    else if (changes.length > 0) setAsking(true);
    else close();
  };
  return {
    requestClose,
    onOpenChange: (open: boolean) => {
      if (!open) requestClose();
    },
    confirm: asking ? (
      <DiscardConfirm
        changes={changes}
        onKeep={() => setAsking(false)}
        onDiscard={() => {
          setAsking(false);
          close();
        }}
      />
    ) : null,
  };
}
