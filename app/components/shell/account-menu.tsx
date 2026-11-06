import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { authClient } from "../../auth-client";
import { t, type MessageId } from "../../i18n";
import { paths, useShell, type ShellData } from "../../lib/shell";
import { Avatar } from "../ui/avatar";
import { Icon, type IconName } from "../ui/icon";
import { SignInButton } from "./sign-in-dialog";

interface MenuRow {
  to: string;
  label: MessageId;
  icon: IconName;
  current?: boolean;
}

/**
 * The rows for this person, in the approved order (item 35): own page tools, then account, then Admin, then
 * Streamers (streamer header only). Rows for later phases (Overlay control, Edit your page, Language,
 * Accessibility & display, Suggest an improvement) are added by those phases.
 */
export function accountMenuRows(shell: ShellData, pathname: string, streamerHeader: boolean): MenuRow[][] {
  const groups: MenuRow[][] = [];
  if (shell.ownStreamer)
    groups.push([
      {
        to: paths.streamer(shell.ownStreamer.handle),
        label: "account.yourPage",
        icon: "your-page",
        current: pathname === paths.streamer(shell.ownStreamer.handle),
      },
    ]);
  const account: MenuRow[] = [
    { to: paths.settings, label: "account.yourProfile", icon: "user", current: pathname === paths.settings },
  ];
  if (!shell.ownStreamer)
    account.push({ to: `${paths.settings}#streamer-heading`, label: "account.hostCommunity", icon: "mic" });
  account.push({ to: `${paths.settings}#data-heading`, label: "account.yourData", icon: "data" });
  if (shell.admin)
    account.push({ to: paths.admin, label: "account.admin", icon: "admin", current: pathname.startsWith(paths.admin) });
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
  const { pathname, search, hash } = useLocation();
  const [open, setOpen] = useState<boolean>(false);
  const [signingOut, setSigningOut] = useState<boolean>(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const menuId: string = useId();

  useEffect(() => setOpen(false), [pathname, search, hash]);

  useEffect(() => {
    if (!open) return;
    const first: HTMLElement | null | undefined = panel.current?.querySelector<HTMLElement>("a, button");
    (first ?? panel.current)?.focus({ preventScroll: true });
    const outside = (event: PointerEvent): void => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  if (!shell.viewer) return <SignInButton providers={shell.providers} />;
  const viewer = shell.viewer;

  function close(returnFocus: boolean): void {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }

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

  return (
    <div
      className="account-menu-wrap"
      ref={wrap}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close(true);
        }
      }}
      onBlur={(event) => {
        if (open && event.relatedTarget && !wrap.current?.contains(event.relatedTarget as Node)) close(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className="profile"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t("account.menuFor", { name: viewer.name })}
        onClick={() => setOpen((value: boolean) => !value)}
      >
        <Avatar name={viewer.name} url={viewer.avatar} />
      </button>
      <div className="account-menu" id={menuId} ref={panel} tabIndex={-1} hidden={!open}>
        <div className="account-id">
          <Avatar name={viewer.name} url={viewer.avatar} />
          <div>
            <strong>{viewer.name}</strong>
            <span>{roleLine}</span>
          </div>
        </div>
        <nav aria-label={t("account.nav")}>
          <ul>
            {accountMenuRows(shell, pathname, streamerHeader).map((group: MenuRow[], index: number) => [
              index > 0 && <li key={`divider-${index}`} className="account-menu-divider" aria-hidden="true" />,
              ...group.map((row: MenuRow) => (
                <li key={row.label}>
                  <Link to={row.to} aria-current={row.current ? "page" : undefined}>
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
