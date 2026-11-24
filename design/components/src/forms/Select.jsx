import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Select({ options, value, defaultValue, onValueChange, placeholder, label, className = "", style }) {
  const [inner, setInner] = React.useState(defaultValue);
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  const current = value ?? inner;
  const selected = options.find((o) => o.value === current);
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const pick = (v) => { setInner(v); onValueChange && onValueChange(v); setOpen(false); };
  return (
    <div className={`sb-select ${className}`.trim()} ref={ref} style={style}>
      <button type="button" className="sb-select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={label} data-placeholder={selected ? undefined : ""} onClick={() => setOpen(!open)}>
        {selected && selected.icon && <Icon name={selected.icon} size={20} />}
        <span className="sb-select-value">{selected ? selected.label : placeholder}</span>
        <Icon name="chevron-down" size={16} className="sb-chev" />
      </button>
      {open && (
        <ul className="sb-select-list" role="listbox">
          {options.map((o) => (
            <li key={o.value} role="option" aria-selected={o.value === current} className="sb-select-option" onClick={() => pick(o.value)}>
              {o.icon && <Icon name={o.icon} size={20} />}
              <span className="sb-select-label">{o.label}</span>
              <Icon name="check" size={16} className="sb-check" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
