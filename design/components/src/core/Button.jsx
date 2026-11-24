import { Icon } from "./Icon.jsx";

export function Button({
  variant = "default",
  size = "md",
  font = "body",
  icon,
  iconEnd,
  landing = false,
  pressed,
  type = "button",
  className = "",
  children,
  ...rest
}) {
  return (
    <button
      type={type}
      className={`sb-btn ${className}`.trim()}
      data-variant={variant === "default" ? undefined : variant}
      data-size={size === "md" ? undefined : size}
      data-font={font === "display" ? "display" : undefined}
      data-landing={landing || undefined}
      aria-pressed={pressed}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 16 : 18} />}
      {children}
      {iconEnd && <Icon name={iconEnd} size={size === "sm" ? 16 : 18} />}
    </button>
  );
}
