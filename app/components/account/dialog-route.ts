import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, type Location } from "react-router";

/** The account dialogs (item 17), Language and Accessibility & display. Each opens as `?dialog=<name>`. */
export const ACCOUNT_DIALOGS = ["profile", "host", "data", "page", "language", "a11y"] as const;
export type AccountDialogName = (typeof ACCOUNT_DIALOGS)[number];

export function isAccountDialog(value: string | null): value is AccountDialogName {
  return (ACCOUNT_DIALOGS as readonly (string | null)[]).includes(value);
}

/** The current URL with `?dialog=` set (or removed with null), keeping every other parameter and the hash. */
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

/** Marks a dialog opened from inside the app, so closing it can step back instead of adding history. */
export interface DialogState {
  dialogFrom?: string;
}

/**
 * The open account dialog and how to close it. Opening pushes a history entry, so the browser's Back closes
 * the dialog; closing an in-app dialog goes back, and closing one that came with the URL replaces it.
 */
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
  // The dialog unmounts with the route change, so focus can land on the page body. Once the route without the
  // dialog has rendered, give focus back to the account menu's avatar button, which the account dialogs open from.
  // An effect, not a timer: the route change can take any time.
  useEffect((): void => {
    if (name !== null || !closing.current) return;
    closing.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    document.querySelector<HTMLElement>(".account-menu-wrap > button.profile")?.focus();
  }, [name]);
  return { name, close };
}
