import { useId } from "react";
import { Req } from "./Req.jsx";

// Labelled input or textarea, as in the dialogs of the app (create-entry.tsx). The app styles the label,
// the field and the hint inside .modal-content and .settings-page. Use className="field" with
// labelClassName="field-label" for the sheet layout. An error marks the field invalid and shows the text below it.
export function TextField({
  label,
  help,
  error,
  required = false,
  multiline = false,
  rows = 4,
  id,
  className = "",
  labelClassName = "",
  ...rest
}) {
  const auto = useId();
  const fieldId = id || auto;
  const helpId = help ? `${fieldId}-help` : undefined;
  const Tag = multiline ? "textarea" : "input";
  return (
    <>
      <label className={className || undefined} htmlFor={fieldId}>
        <span className={labelClassName || undefined}>
          {label}
          {required && <Req />}
        </span>
        <Tag
          id={fieldId}
          required={required}
          rows={multiline ? rows : undefined}
          aria-describedby={helpId}
          aria-invalid={error ? "true" : undefined}
          {...rest}
        />
        {help && <small id={helpId}>{help}</small>}
      </label>
      {error && typeof error === "string" && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
