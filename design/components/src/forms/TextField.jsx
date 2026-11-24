import { useId } from "react";
import { Req } from "./Req.jsx";

export function TextField({
  label,
  help,
  error,
  required = false,
  multiline = false,
  rows = 4,
  id,
  className = "",
  ...rest
}) {
  const auto = useId();
  const fid = id || auto;
  const Tag = multiline ? "textarea" : "input";
  return (
    <label className={`sb-field ${className}`.trim()} htmlFor={fid}>
      <span className="sb-field-label">
        {label}
        {required && <Req />}
      </span>
      <Tag
        id={fid}
        className="sb-input"
        required={required}
        rows={multiline ? rows : undefined}
        aria-invalid={error ? "true" : undefined}
        {...rest}
      />
      {error ? <small className="sb-error">{error}</small> : help ? <small>{help}</small> : null}
    </label>
  );
}
