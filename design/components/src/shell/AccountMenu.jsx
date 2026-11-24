import React from "react";
import { Icon } from "../core/Icon.jsx";
import { Avatar } from "../core/Avatar.jsx";

const DEFAULT_ITEMS = [
  { id: "your-page", label: "Your page", icon: "your-page" },
  { id: "edit", label: "Edit your page", icon: "pencil" },
  { id: "overlay", label: "Overlay control", icon: "overlay" },
  { id: "profile", label: "Your profile", icon: "user" },
  { id: "data", label: "Your data", icon: "data" },
  "divider",
  { id: "sign-out", label: "Sign out", icon: "sign-out" },
];

export function AccountMenu({ name, role = "Viewer", preset = 1, items = DEFAULT_ITEMS, current, onSelect, className = "" }) {
  return (
    <div className={`sb-menu ${className}`.trim()} role="menu" aria-label={`Account menu for ${name}`}>
      <div className="sb-menu-id"><Avatar preset={preset} size={44} /><div><strong>{name}</strong><span>{role}</span></div></div>
      <ul>
        {items.map((it, i) => it === "divider"
          ? <li key={i} className="sb-menu-divider" role="separator" />
          : <li key={it.id}><button type="button" role="menuitem" className="sb-menu-item" aria-current={current === it.id ? "page" : undefined} onClick={() => onSelect && onSelect(it.id)}><Icon name={it.icon} size={18} />{it.label}</button></li>)}
      </ul>
    </div>
  );
}
