import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, type Location } from "react-router";
import { detached } from "../../lib/detached";

// Account, language, display and notification dialogs use ?dialog=<name>.
export const ACCOUNT_DIALOGS = ["profile", "host", "data", "page", "language", "a11y", "notifications"] as const;
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

// The profile dialog over `path` for a new account. A dialog that `path` opens, such as the host application of the
// landing page, waits in `?resume=` and opens when the profile closes.
export function profileFirst(path: string): string {
  const url = new URL(path, "https://local.invalid");
  const pending: string | null = url.searchParams.get("dialog");
  if (pending !== "profile" && isAccountDialog(pending)) url.searchParams.set("resume", pending);
  return dialogHref(url, "profile");
}

// Where a dialog goes when it closes: the dialog that waits in `?resume=`, or no dialog.
export function closedDialogHref(location: Pick<Location, "pathname" | "search" | "hash">): string {
  const params = new URLSearchParams(location.search);
  const resume: string | null = params.get("resume");
  params.delete("resume");
  const rest = { pathname: location.pathname, search: params.toString(), hash: location.hash };
  return dialogHref(rest, isAccountDialog(resume) && resume !== params.get("dialog") ? resume : null);
}

// The control that receives focus after a language change: the account avatar, header button or footer link.
export type LanguageOpener = "account" | "header" | "footer";

// Mark in-app dialogs so closure navigates back.
export interface DialogState {
  dialogFrom?: string;
  languageOpener?: LanguageOpener;
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
    const resume: boolean = isAccountDialog(new URLSearchParams(location.search).get("resume"));
    closing.current = !resume;
    if (fromApp && !resume) detached(navigate(-1));
    else detached(navigate(closedDialogHref(location), { replace: true, preventScrollReset: true }));
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
