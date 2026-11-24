import { useEffect, useId, useRef, useState } from "react";
import { Avatar } from "../core/Avatar.jsx";
import { Icon } from "../core/Icon.jsx";
import { OwnerNotice } from "../feedback/Banner.jsx";

// The inbox button left of the avatar (app/components/notifications.tsx). It opens the notifications dialog.
export function NotificationLink({ unread = 0, error = "", label = "Notifications", onClick }) {
  const name = unread > 0 ? `Unread notifications: ${unread}` : label;
  return (
    <button
      type="button"
      className="notification-nav"
      aria-haspopup="dialog"
      aria-label={name}
      title={error || name}
      onClick={onClick}
    >
      <Icon name={error ? "warning" : "requests"} size={20} />
      {unread > 0 && (
        <span className="notification-badge" aria-hidden="true">
          {unread}
        </span>
      )}
      {error && <span className="sr-only">{error}</span>}
    </button>
  );
}

// The header control for signed-out readers (app/components/shell/sign-in-dialog.tsx).
export function SignInButton({
  label = "Sign in / Sign up",
  shortLabel = "Sign in",
  className = "header-signin",
  onClick,
}) {
  return (
    <button type="button" className={className} aria-label={label} onClick={onClick}>
      <Icon name="sign-in" size={18} />
      <span className="header-signin-label">{label}</span>
      <span className="header-signin-short" aria-hidden="true">
        {shortLabel}
      </span>
    </button>
  );
}

// The rows of the menu, as accountMenuRows() in app/components/shell/account-menu.tsx orders them:
// own-page tools, account, Admin, then Streamers on streamer headers. "divider" separates the groups.
export function accountMenuItems({ handle, admin = false, streamerHeader = false, current } = {}) {
  const dialog = (id, label, icon) => ({ id, label, icon, href: `?dialog=${id}`, dialog: true });
  const items = [];
  if (handle)
    items.push(
      { id: "your-page", label: "Your page", icon: "your-page", href: `/@${handle}` },
      { id: "overlay", label: "Overlay control", icon: "overlay", href: "/overlay-control" },
      dialog("page", "Edit your page", "pencil"),
      "divider",
    );
  items.push(dialog("profile", "Your profile", "user"));
  if (!handle) items.push(dialog("host", "Host a community", "mic"));
  items.push(
    dialog("data", "Your data", "data"),
    dialog("language", "Language", "globe"),
    dialog("a11y", "Accessibility & display", "eye"),
  );
  if (admin) items.push({ id: "admin", label: "Admin", icon: "admin", href: "/admin" });
  items.push({ id: "ideas", label: "Suggest an improvement", icon: "idea", href: "/@streambullets?intent=suggest" });
  if (streamerHeader) items.push({ id: "streamers", label: "Streamers", icon: "streamers", href: "/streamers" });
  return current
    ? items.map((item) => (item !== "divider" && item.id === current ? { ...item, current: true } : item))
    : items;
}

function roleLine(handle, admin) {
  if (admin) return "Administrator";
  return handle ? `Streamer · @${handle}` : "Viewer";
}

// Notifications button, avatar button and the account menu panel. The panel is in the header: the app CSS
// places it under the header edge. Escape, an outside click or a row click closes it.
export function AccountMenu({
  name = "Sunny",
  handle,
  admin = false,
  subtitle,
  preset = 14,
  avatar,
  items,
  current,
  streamerHeader = false,
  notice,
  noticeText,
  unread = 0,
  notifications = true,
  onNotifications,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  onSelect,
  signingOut = false,
}) {
  const [inner, setInner] = useState(defaultOpen);
  const open = openProp ?? inner;
  const wrap = useRef(null);
  const button = useRef(null);
  const panel = useRef(null);
  const opened = useRef(false);
  const menuId = useId();
  const setOpen = (next) => {
    opened.current = next;
    setInner(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    const root = wrap.current;
    if (!open || !root) return undefined;
    if (opened.current) {
      opened.current = false;
      panel.current?.querySelector("a, button")?.focus({ preventScroll: true });
    }
    const outside = (event) => {
      if (!root.contains(event.target)) setOpen(false);
    };
    const onEscape = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    root.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      root.removeEventListener("keydown", onEscape);
    };
  });

  const rows = items ?? accountMenuItems({ handle, admin, streamerHeader, current });
  const moderated = Boolean(notice && notice !== "active");
  return (
    <>
      {notifications && <NotificationLink unread={unread} onClick={onNotifications} />}
      <div className="account-menu-wrap" ref={wrap}>
        <button
          ref={button}
          type="button"
          className="profile"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={moderated ? `Account menu for ${name}. Your page needs attention.` : `Account menu for ${name}`}
          onClick={() => setOpen(!open)}
        >
          <Avatar preset={preset} url={avatar} />
          {moderated && <span className="notice-dot" aria-hidden="true" />}
        </button>
        <div className="account-menu" id={menuId} ref={panel} tabIndex={-1} hidden={!open}>
          <div className="account-id">
            <Avatar preset={preset} url={avatar} />
            <div>
              <strong>{name}</strong>
              <span>{subtitle ?? roleLine(handle, admin)}</span>
            </div>
          </div>
          {moderated && <OwnerNotice status={notice}>{noticeText}</OwnerNotice>}
          <nav aria-label="Account">
            <ul>
              {rows.map((row, index) =>
                row === "divider" ? (
                  <li
                    key={`divider-${rows[index + 1]?.id ?? index}`}
                    className="account-menu-divider"
                    aria-hidden="true"
                  />
                ) : (
                  <li key={row.id}>
                    <a
                      href={row.href}
                      aria-current={row.current || current === row.id ? "page" : undefined}
                      aria-haspopup={row.dialog ? "dialog" : undefined}
                      onClick={() => {
                        setOpen(false);
                        onSelect?.(row.id);
                      }}
                    >
                      <span className="icon-muted">
                        <Icon name={row.icon} size={18} />
                      </span>
                      {row.label}
                    </a>
                  </li>
                ),
              )}
              <li className="account-menu-divider" aria-hidden="true" />
              <li>
                <button
                  type="button"
                  className="account-menu-signout"
                  disabled={signingOut}
                  onClick={() => onSelect?.("sign-out")}
                >
                  <span className="icon-muted">
                    <Icon name="sign-out" size={18} />
                  </span>
                  {signingOut ? "Signing out…" : "Sign out"}
                </button>
              </li>
            </ul>
          </nav>
        </div>
      </div>
    </>
  );
}
