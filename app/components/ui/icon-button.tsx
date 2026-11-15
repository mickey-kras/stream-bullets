import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName, type IconSize } from "./icon";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  // Accessible name; also the tooltip unless title overrides it.
  label: string;
  icon: IconName;
  iconSize?: IconSize;
  // Increasing value restarts the icon spin without moving focus; zero disables it.
  spin?: number;
}

// Named icon button: 40px target, 44px on phones, never below 24px.
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
