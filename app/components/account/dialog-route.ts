import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, type Location } from "react-router";

// Account, language and display dialogs use ?dialog=<name>.
export const ACCOUNT_DIALOGS = ["profile", "host", "data", "page", "language", "a11y"] as const;
export type AccountDialogName = (typeof ACCOUNT_DIALOGS)[number];

export function isAccountDialog(value: string | null): value is AccountDialogName {
  return (ACCOUNT_DIALOGS as readonly (string | null)[]).includes(value);
}

// Set/remove dialog while preserving other parameters and hash.
export function dialogHref(
  location: Pick<Location, "pathname" | "search" | "hash">,
  name: AccountDialogName | null,
): string {
  const params = new URLSearchParams(location.search);
  if (name) params.set("dialog", name);
  else params.delete("dialog");
  const search: string = params.toString();
  const query: string = search ? "?" + search : "";
  return `${location.pathname}${query}${location.hash}`;
}

// Mark in-app dialogs so closure navigates back.
export interface DialogState {
  dialogFrom?: string;
  languageOpener?: "account";
}

// Preserve Back navigation: app-opened dialogs pop history; direct dialog URLs use replacement.
export function useAccountDialog(): { name: AccountDialogName | null; close: () => void } {
  const location = useLocation();
  const navigate = useNavigate();
  const value: string | null = new URLSearchParams(location.search).get("dialog");
  const name: AccountDialogName | null = isAccountDialog(value) ? value : null;
  const fromApp: boolean = Boolean((location.state as DialogState | null)?.dialogFrom);
  const closing = useRef<boolean>(false);
  const close = useCallback((): void => {
    closing.current = true;
    if (fromApp) navigate(-1);
    else navigate(dialogHref(location, null), { replace: true, preventScrollReset: true });
  }, [fromApp, location, navigate]);
  // Restore avatar focus after route rendering, not a timer: unmount can otherwise leave focus on body.
  useEffect((): void => {
    if (name !== null || !closing.current) return;
    closing.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    document.querySelector<HTMLElement>(".account-menu-wrap > button.profile")?.focus();
  }, [name]);
  return { name, close };
}
