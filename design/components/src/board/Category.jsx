import { Icon } from "../core/Icon.jsx";

export function Category({ icon = "cat-tech", children, className = "" }) {
  return (
    <span className={`sb-category ${className}`.trim()}>
      <Icon name={icon} size={24} />
      {children}
    </span>
  );
}
