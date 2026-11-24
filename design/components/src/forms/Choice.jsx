import React from "react";

export function Choice({ type = "radio", label, help, className = "", ...rest }) {
  return (
    <label className={`sb-choice ${className}`.trim()}>
      <input type={type} {...rest} />
      <span>{label}{help && <small>{help}</small>}</span>
    </label>
  );
}
