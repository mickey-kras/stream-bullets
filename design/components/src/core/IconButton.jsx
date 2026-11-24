import React from "react";
import { Icon } from "./Icon.jsx";

export function IconButton({ label, icon, iconSize = 20, variant = "default", title, type = "button", className = "", ...rest }) {
  return (
    <button type={type} className={`sb-icon-btn ${className}`.trim()} data-variant={variant === "bare" ? "bare" : undefined} aria-label={label} title={title ?? label} {...rest}>
      <Icon name={icon} size={iconSize} />
    </button>
  );
}
