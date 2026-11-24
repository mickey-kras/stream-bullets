import { Icon } from "../core/Icon.jsx";

export function TopicChip({ icon, children, pressed, onClick, className = "" }) {
  const inner = (
    <>
      {icon && <Icon name={icon} size={18} />}
      {children}
    </>
  );
  if (onClick || pressed !== undefined)
    return (
      <button type="button" className={`sb-chip ${className}`.trim()} aria-pressed={pressed} onClick={onClick}>
        {inner}
      </button>
    );
  return <span className={`sb-chip ${className}`.trim()}>{inner}</span>;
}
