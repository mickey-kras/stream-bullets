import { useState } from "react";

export function Tabs({ items, value, defaultValue, onValueChange, label, className = "" }) {
  const [inner, setInner] = useState(defaultValue ?? (items[0] && items[0].value));
  const current = value ?? inner;
  return (
    <fieldset className={`sb-tabs ${className}`.trim()}>
      <legend className="sr-only">{label}</legend>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          aria-pressed={it.value === current}
          onClick={() => {
            setInner(it.value);
            onValueChange?.(it.value);
          }}
        >
          {it.label}
        </button>
      ))}
    </fieldset>
  );
}
