import { Icon } from "./Icon.jsx";

// The class that each variant puts on the global button of app/styles (base.css, components.css).
// "secondary" is the outlined landing button: it needs the .landing-actions container of the landing page.
const VARIANTS = {
  default: "",
  gold: "gold",
  danger: "danger",
  small: "small-button",
  text: "text-button",
  link: "link-button",
  secondary: "secondary",
};

// A native button with the classes of the app. Icons sit before or after the text.
export function Button({
  variant = "default",
  icon,
  iconEnd,
  iconSize,
  pressed,
  type = "button",
  className = "",
  children,
  ...rest
}) {
  const size = iconSize ?? (variant === "small" ? 16 : 18);
  return (
    <button
      type={type}
      className={`${VARIANTS[variant] ?? ""} ${className}`.trim() || undefined}
      aria-pressed={pressed}
      {...rest}
    >
      {icon && <Icon name={icon} size={size} />}
      {children}
      {iconEnd && <Icon name={iconEnd} size={size} />}
    </button>
  );
}
