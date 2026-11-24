import { Icon } from "../core/Icon.jsx";

// A linked topic of a stream, as in app/components/schedule/schedule-feed.tsx (link) and
// app/components/schedule/schedule-form.tsx (toggle button with aria-pressed).
export function TopicChip({ icon, children, href, pressed, onClick, className = "" }) {
  const inner = (
    <>
      {icon && <Icon name={icon} size={18} />}
      {children}
    </>
  );
  if (onClick || pressed !== undefined)
    return (
      <button
        type="button"
        className={`topic-chip toggle ${className}`.trim()}
        aria-pressed={Boolean(pressed)}
        onClick={onClick}
      >
        {inner}
      </button>
    );
  if (href)
    return (
      <a className={`topic-chip ${className}`.trim()} href={href}>
        {inner}
      </a>
    );
  return <span className={`topic-chip ${className}`.trim()}>{inner}</span>;
}

/** The row of topic chips. Use `as="fieldset"` with a `label` for a group of toggles, as in the schedule form. */
export function TopicChips({ as = "div", label = "Linked topics", children, className = "" }) {
  if (as === "fieldset")
    return (
      <fieldset className={`topic-chips ${className}`.trim()} aria-label={label}>
        {children}
      </fieldset>
    );
  return (
    <div className={`topic-chips ${className}`.trim()} aria-label={label}>
      {children}
    </div>
  );
}
