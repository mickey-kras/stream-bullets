import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName, type IconSize } from "./icon";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  /** The icon-only button's accessible name. It is also the mouse tooltip unless `title` is set. */
  label: string;
  icon: IconName;
  iconSize?: IconSize;
  /** Spins the icon once (refresh) each time this number goes up; 0 means no spin. Focus stays on the button. */
  spin?: number;
}

/**
 * Square icon-only button (approved item 37): the glyph is centred with inline-grid, the target is 40px
 * (44px on phones) and never below 24px. Always named by `label`.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, iconSize = 20, spin = 0, className = "", title, type = "button", ...rest },
  ref,
): ReactNode {
  return (
    <button
      ref={ref}
      type={type}
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      title={title ?? label}
      {...rest}
    >
      <Icon key={spin} name={icon} size={iconSize} className={spin > 0 ? "spin" : ""} />
    </button>
  );
});
