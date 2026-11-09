import { useState, type ReactNode } from "react";
import { Select as RadixSelect } from "radix-ui";
import { Icon, type IconName } from "./icon";

export interface SelectOption {
  /** Must not be empty (Radix reserves "" for "no value"). */
  value: string;
  label: string;
  icon?: IconName;
}

/**
 * Custom select on Radix Select (a select-only combobox with a listbox): the category picker with icons, comment
 * sort, poll duration and report reasons all use it (approved item 19). Give it a visible label through
 * `labelledBy` (the label element's id) or an `aria-label` through `label`. `name` adds a hidden native input so it
 * works inside a plain <form>.
 */
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
}: Readonly<{
  id?: string;
  options: readonly SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  label?: string;
  labelledBy?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}>): ReactNode {
  const [inner, setInner] = useState<string | undefined>(defaultValue);
  const current: string | undefined = value ?? inner;
  const selected: SelectOption | undefined = options.find((option: SelectOption) => option.value === current);
  const labelIds: string | undefined = labelledBy ? [labelledBy, id].filter(Boolean).join(" ") : undefined;
  return (
    <div className={`cselect ${className}`.trim()}>
      <RadixSelect.Root
        value={current}
        onValueChange={(next: string) => {
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
        <RadixSelect.Portal>
          <RadixSelect.Content className="cselect-list cselect-popper" position="popper" sideOffset={4}>
            <RadixSelect.Viewport>
              {options.map((option: SelectOption) => (
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
