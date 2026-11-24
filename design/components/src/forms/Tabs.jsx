import { useState } from "react";

// Segmented toggle of the app (the Top/New sort of the topic board): a fieldset of pressed buttons.
// The active button has the active class and aria-pressed. sort-switch removes the fieldset frame.
export function Tabs({ items, value, defaultValue, onValueChange, label, className = "sort-switch" }) {
  const [inner, setInner] = useState(defaultValue ?? items[0]?.value);
  const current = value ?? inner;
  return (
    <fieldset className={`tabs ${className}`.trim()}>
      <legend className="sr-only">{label}</legend>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          className={item.value === current ? "active" : ""}
          aria-pressed={item.value === current}
          onClick={() => {
            setInner(item.value);
            onValueChange?.(item.value);
          }}
        >
          {item.label}
        </button>
      ))}
    </fieldset>
  );
}
