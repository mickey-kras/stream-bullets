import { Icon } from "../core/Icon.jsx";

export function Banner({ tone = "frozen", children, className = "" }) {
  return (
    <div
      className={`sb-banner ${className}`.trim()}
      role="note"
      data-tone={tone === "suspended" ? "suspended" : undefined}
    >
      <Icon name={tone === "suspended" ? "warning" : "lock"} size={20} />
      <span>{children}</span>
    </div>
  );
}
