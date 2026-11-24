import React from "react";

export function Tabs({ items, value, defaultValue, onValueChange, label, className = "" }) {
  const [inner, setInner] = React.useState(defaultValue ?? (items[0] && items[0].value));
  const current = value ?? inner;
  return (
    <div className={`sb-tabs ${className}`.trim()} role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.value} type="button" aria-pressed={it.value === current} onClick={() => { setInner(it.value); onValueChange && onValueChange(it.value); }}>
          {it.label}
        </button>
      ))}
    </div>
  );
}
