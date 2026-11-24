// Radio or checkbox row with an optional hint, as in the preferences dialog and the moderation sheet.
// The app styles .choice inside .modal-content and .pref-group.
export function Choice({ type = "radio", label, help, className = "", ...rest }) {
  return (
    <label className={`choice ${className}`.trim()}>
      <input type={type} {...rest} />
      <span>
        {label}
        {help && <small>{help}</small>}
      </span>
    </label>
  );
}
