import { Icon } from "../core/Icon.jsx";

export function EmptyState({ title, icon, children, action, className = "" }) {
  return (
    <div className={`sb-empty ${className}`.trim()}>
      {icon && <Icon name={icon} size={40} />}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action && <div className="sb-empty-cta">{action}</div>}
    </div>
  );
}
