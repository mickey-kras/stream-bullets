import { useCallback, useState } from "react";
import { Select as RadixSelect } from "radix-ui";
import { Icon } from "../core/Icon.jsx";

// Radix select-only combobox, as in app/components/ui/select.tsx. Give label or labelledBy for its name.
// name adds a hidden form input. Inside a modal <dialog>, the list mounts in that dialog: the page outside
// it is inert.
export function Select({
  id,
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  label,
  labelledBy,
  placeholder,
  required = false,
  disabled = false,
  className = "",
}) {
  const [inner, setInner] = useState(defaultValue);
  const [container, setContainer] = useState();
  const findDialog = useCallback((el) => setContainer(el?.closest("dialog") ?? undefined), []);
  const current = value ?? inner;
  const selected = options.find((option) => option.value === current);
  const labelIds = labelledBy ? [labelledBy, id].filter(Boolean).join(" ") : undefined;
  return (
    <div className={`cselect ${className}`.trim()} ref={findDialog}>
      <RadixSelect.Root
        value={current}
        onValueChange={(next) => {
          setInner(next);
          onValueChange?.(next);
        }}
        name={name}
        required={required}
        disabled={disabled}
      >
        <RadixSelect.Trigger
          id={id}
          className="cselect-trigger"
          aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelIds}
        >
          {selected?.icon && (
            <span className="cselect-icon" aria-hidden="true">
              <Icon name={selected.icon} size={20} />
            </span>
          )}
          <span className="cselect-value">
            <RadixSelect.Value placeholder={placeholder} />
          </span>
          <RadixSelect.Icon asChild>
            <Icon name="chevron-down" size={16} className="ico-chevron" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal container={container}>
          <RadixSelect.Content className="cselect-list cselect-popper" position="popper" sideOffset={4}>
            <RadixSelect.Viewport>
              {options.map((option) => (
                <RadixSelect.Item key={option.value} value={option.value} className="cselect-option">
                  {option.icon && (
                    <span className="cselect-icon" aria-hidden="true">
                      <Icon name={option.icon} size={20} />
                    </span>
                  )}
                  <RadixSelect.ItemText>
                    <span className="cselect-label">{option.label}</span>
                  </RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator className="cselect-check">
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
