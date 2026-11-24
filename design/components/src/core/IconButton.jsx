import { Icon } from "./Icon.jsx";

// Named icon button (app/components/ui/icon-button.tsx): 40px target, 44px on phones.
// label is the accessible name and the tooltip unless title overrides it.
// A larger spin value plays the spin animation of the icon again; 0 turns it off.
export function IconButton({ label, icon, iconSize = 20, spin = 0, title, type = "button", className = "", ...rest }) {
  return (
    <button
      type={type}
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      title={title ?? label}
      {...rest}
    >
      <Icon key={spin} name={icon} size={iconSize} className={spin > 0 ? "spin" : ""} />
    </button>
  );
}
