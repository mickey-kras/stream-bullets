import { Icon } from "../core/Icon.jsx";

// The empty state of a list or view (app/components/common.tsx).
export function EmptyState({ title, icon, children, action }) {
  return (
    <div className={action ? "empty-state has-cta" : "empty-state"}>
      {icon && <Icon name={icon} size={40} />}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action && <p className="empty-cta">{action}</p>}
    </div>
  );
}
