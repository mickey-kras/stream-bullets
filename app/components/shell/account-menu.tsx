import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, type Location } from "react-router";
import { authClient } from "../../auth-client";
import { t, type MessageId } from "../../i18n";
import { paths, useShell, type ShellData } from "../../lib/shell";
import { dialogHref, type AccountDialogName, type DialogState } from "../account/dialog-route";
import { OwnerNotice } from "../streamer/page-banner";
import { Avatar } from "../ui/avatar";
import { Icon, type IconName } from "../ui/icon";
import { SignInButton } from "./sign-in-dialog";

interface MenuRow {
  to: string;
  label: MessageId;
  icon: IconName;
  current?: boolean;
  /** Opens an account dialog over this page (history state marks it, so closing steps back). */
  dialog?: AccountDialogName;
}

/**
 * The rows for this person, in the approved order (item 35): own page tools, then account, then Admin, then
 * Streamers (streamer header only). Your profile, Host a community, Your data and Edit your page open dialogs
 * over the current page (item 17). Suggest an improvement opens the official Ideas board with its dialog (item 46).
 * Language and Accessibility & display open their dialogs too.
 */
export function accountMenuRows(
  shell: ShellData,
  location: Pick<Location, "pathname" | "search" | "hash">,
  streamerHeader: boolean,
): MenuRow[][] {
  const { pathname } = location;
  const dialog = (name: AccountDialogName, label: MessageId, icon: IconName): MenuRow => ({
    to: dialogHref(location, name),
    label,
    icon,
    dialog: name,
  });
  const groups: MenuRow[][] = [];
  if (shell.ownStreamer)
    groups.push([
      {
        to: paths.streamer(shell.ownStreamer.handle),
        label: "account.yourPage",
        icon: "your-page",
        current: pathname === paths.streamer(shell.ownStreamer.handle),
      },
      {
        to: paths.overlayControl,
        label: "account.overlayControl",
        icon: "overlay",
        current: pathname === paths.overlayControl,
      },
      dialog("page", "account.editPage", "pencil"),
    ]);
  const account: MenuRow[] = [dialog("profile", "account.yourProfile", "user")];
  if (!shell.ownStreamer) account.push(dialog("host", "account.hostCommunity", "mic"));
  account.push(
    dialog("data", "account.yourData", "data"),
    dialog("language", "language.title", "globe"),
    dialog("a11y", "prefs.title", "eye"),
  );
  if (shell.admin)
    account.push({ to: paths.admin, label: "account.admin", icon: "admin", current: pathname.startsWith(paths.admin) });
  account.push({ to: paths.ideas, label: "ideas.suggest", icon: "idea" });
  if (streamerHeader) account.push({ to: paths.streamers, label: "nav.streamers", icon: "streamers" });
  groups.push(account);
  return groups;
}

/**
 * The account control on the right of every header. Signed out: "Sign in / Sign up". Signed in: the avatar is a
 * disclosure button (not a menu button) for a popover list of links. Opening moves focus to the first link;
 * Escape, a click outside, focus leaving, a route change or the avatar close it, and Escape returns focus.
 */
export function AccountMenu({ streamerHeader = false }: Readonly<{ streamerHeader?: boolean }>): ReactNode {
  const shell: ShellData = useShell();
  const here = useLocation();
  const { pathname, search, hash } = here;
  // The menu remembers the location it opened at, so a route change closes it without an effect.
  const location = `${pathname}${search}${hash}`;
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open: boolean = openAt === location;
  const [signingOut, setSigningOut] = useState<boolean>(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const menuId: string = useId();

  useEffect(() => {
    const root: HTMLDivElement | null = wrap.current;
    if (!open || !root) return;
    const first: HTMLElement | null | undefined = panel.current?.querySelector<HTMLElement>("a, button");
    (first ?? panel.current)?.focus({ preventScroll: true });
    const outside = (event: PointerEvent): void => {
      if (!root.contains(event.target as Node)) setOpenAt(null);
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpenAt(null);
      button.current?.focus();
    };
    const leave = (event: FocusEvent): void => {
      if (event.relatedTarget && !root.contains(event.relatedTarget as Node)) setOpenAt(null);
    };
    document.addEventListener("pointerdown", outside);
    root.addEventListener("keydown", onEscape);
    root.addEventListener("focusout", leave);
    return () => {
      document.removeEventListener("pointerdown", outside);
      root.removeEventListener("keydown", onEscape);
      root.removeEventListener("focusout", leave);
    };
  }, [open]);

  if (!shell.viewer) return <SignInButton providers={shell.providers} />;
  const viewer = shell.viewer;

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      globalThis.location.assign(paths.home);
    }
  }

  let roleLine: string = t("account.roleViewer");
  if (shell.ownStreamer) roleLine = t("account.roleStreamer", { handle: shell.ownStreamer.handle });
  if (shell.admin) roleLine = t("account.roleAdmin");
  const moderated: boolean = Boolean(shell.ownStreamer && shell.ownStreamer.status !== "active");

  return (
    <div className="account-menu-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="profile"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t(moderated ? "account.menuForNotice" : "account.menuFor", { name: viewer.name })}
        onClick={() => setOpenAt((value: string | null) => (value === location ? null : location))}
      >
        <Avatar name={viewer.name} url={viewer.avatar} preset={viewer.avatarPreset} />
        {moderated && <span className="notice-dot" aria-hidden="true" />}
      </button>
      <div className="account-menu" id={menuId} ref={panel} tabIndex={-1} hidden={!open}>
        <div className="account-id">
          <Avatar name={viewer.name} url={viewer.avatar} preset={viewer.avatarPreset} />
          <div>
            <strong>{viewer.name}</strong>
            <span>{roleLine}</span>
          </div>
        </div>
        {shell.ownStreamer && (
          <OwnerNotice
            status={shell.ownStreamer.status}
            reason={shell.ownStreamer.statusReason}
            changedAt={shell.ownStreamer.statusChangedAt}
          />
        )}
        <nav aria-label={t("account.nav")}>
          <ul>
            {accountMenuRows(shell, here, streamerHeader).map((group: MenuRow[], index: number) => [
              index > 0 && <li key={`divider-${index}`} className="account-menu-divider" aria-hidden="true" />,
              ...group.map((row: MenuRow) => (
                <li key={row.label}>
                  <Link
                    to={row.to}
                    aria-current={row.current ? "page" : undefined}
                    aria-haspopup={row.dialog ? "dialog" : undefined}
                    state={row.dialog ? ({ dialogFrom: pathname } satisfies DialogState) : undefined}
                    preventScrollReset={Boolean(row.dialog)}
                    onClick={() => setOpenAt(null)}
                  >
                    <span className="icon-muted">
                      <Icon name={row.icon} size={18} />
                    </span>
                    {t(row.label)}
                  </Link>
                </li>
              )),
            ])}
            <li className="account-menu-divider" aria-hidden="true" />
            <li>
              <button
                type="button"
                className="account-menu-signout"
                disabled={signingOut}
                onClick={() => {
                  void signOut();
                }}
              >
                <span className="icon-muted">
                  <Icon name="sign-out" size={18} />
                </span>
                {signingOut ? t("account.signingOut") : t("account.signOut")}
              </button>
            </li>
          </ul>
        </nav>
      </div>
    </div>
  );
}
