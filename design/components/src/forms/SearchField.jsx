import { Icon } from "../core/Icon.jsx";

export function SearchField({ label = "Search topics", placeholder = "Search topics…", className = "", ...rest }) {
  return (
    <label className={`sb-search ${className}`.trim()}>
      <Icon name="search" size={20} />
      <span className="sr-only">{label}</span>
      <input type="search" placeholder={placeholder} {...rest} />
    </label>
  );
}
