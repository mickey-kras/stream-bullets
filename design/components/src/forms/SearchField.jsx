import { useId } from "react";
import { Icon } from "../core/Icon.jsx";

const DEFAULTS = {
  topics: { label: "Search topics", placeholder: "Search topics…", maxLength: 100 },
  streamers: { label: "Search streamers", placeholder: "Search by name or @handle…", maxLength: 60 },
};

// The search icon and the Search button of the directory search (SearchAdornments in directory-search.tsx).
function SearchAdornments({ label, buttonLabel }) {
  return (
    <>
      <span className="search-lead" aria-hidden="true">
        <Icon name="search" size={18} />
      </span>
      <button type="submit" className="search-button">
        <Icon name="search" size={18} />
        <span className="search-text" aria-hidden="true">
          {buttonLabel}
        </span>
        <span className="sr-only">{label}</span>
      </button>
    </>
  );
}

// Search form with a Search submit button.
// variant "topics": the topic board search (topic-board.tsx).
// variant "streamers": the streamer directory search (directory-search.tsx), in a <search> landmark.
// onSearch gets the trimmed query when the person submits the form.
export function SearchField({
  variant = "topics",
  label,
  placeholder,
  buttonLabel = "Search",
  maxLength,
  id,
  onSearch,
  className = "",
  ...rest
}) {
  const auto = useId();
  const inputId = id || auto;
  const d = DEFAULTS[variant] ?? DEFAULTS.topics;
  const name = label ?? d.label;
  function submit(event) {
    event.preventDefault();
    const query = new FormData(event.currentTarget).get("query");
    onSearch?.(typeof query === "string" ? query.trim() : "");
  }
  const input = (
    <>
      <label className="sr-only" htmlFor={inputId}>
        {name}
      </label>
      <input
        id={inputId}
        name="query"
        type="search"
        maxLength={maxLength ?? d.maxLength}
        placeholder={placeholder ?? d.placeholder}
        {...rest}
      />
    </>
  );
  if (variant === "streamers")
    return (
      <search className={`search directory-search nf-search ${className}`.trim()}>
        <form onSubmit={submit}>
          {input}
          <SearchAdornments label={name} buttonLabel={buttonLabel} />
        </form>
      </search>
    );
  return (
    <form className={`search ${className}`.trim()} onSubmit={submit}>
      {input}
      <button type="submit" className="search-button" aria-label={name}>
        <Icon name="search" size={18} />
        <span className="search-text">{buttonLabel}</span>
      </button>
    </form>
  );
}
