import { useCallback, useState } from "react";
import { Select as RadixSelect } from "radix-ui";
import { Icon } from "../core/Icon.jsx";

// Radix select-only combobox, as in app/components/ui/select.tsx.
// Inside a modal <dialog>, the list mounts in that dialog: the page outside it is inert.
export function Select({ options, value, defaultValue, onValueChange, placeholder, label, className = "", style }) {
  const [inner, setInner] = useState(defaultValue);
  const [container, setContainer] = useState(undefined);
  const findDialog = useCallback((el) => setContainer(el?.closest("dialog") ?? undefined), []);
  const current = value ?? inner;
  const selected = options.find((o) => o.value === current);
  const pick = (v) => {
    setInner(v);
    onValueChange?.(v);
  };
  return (
    <div className={`sb-select ${className}`.trim()} style={style} ref={findDialog}>
      <RadixSelect.Root value={current} onValueChange={pick}>
        <RadixSelect.Trigger className="sb-select-trigger" aria-label={label}>
          {selected?.icon && <Icon name={selected.icon} size={20} />}
          <span className="sb-select-value">
            <RadixSelect.Value placeholder={placeholder} />
          </span>
          <RadixSelect.Icon asChild>
            <Icon name="chevron-down" size={16} className="sb-chev" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal container={container}>
          <RadixSelect.Content className="sb-select-list" position="popper" sideOffset={4}>
            <RadixSelect.Viewport>
              {options.map((o) => (
                <RadixSelect.Item key={o.value} value={o.value} className="sb-select-option">
                  {o.icon && <Icon name={o.icon} size={20} />}
                  <RadixSelect.ItemText>
                    <span className="sb-select-label">{o.label}</span>
                  </RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator className="sb-check">
                    <Icon name="check" size={16} />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
}
