import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { dialogHref, type AccountDialogName, type DialogState } from "../account/dialog-route";

// Open ?dialog= over this page; history state makes closure navigate back without adding an entry.
export function DialogLink({
  name,
  children,
  label,
  className,
  onClick,
}: Readonly<{
  name: AccountDialogName;
  children: ReactNode;
  label?: string;
  className?: string;
  onClick?: () => void;
}>): ReactNode {
  const location = useLocation();
  return (
    <Link
      to={dialogHref(location, name)}
      state={{ dialogFrom: location.pathname } satisfies DialogState}
      preventScrollReset
      aria-haspopup="dialog"
      aria-label={label}
      className={className}
      onClick={onClick}
    >
      {children}
    </Link>
  );
}
