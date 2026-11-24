import { Icon } from "../core/Icon.jsx";

// The category plate of a topic, as in app/components/streamer/entry-detail.tsx and app/components/topic-icon.tsx.
const CATEGORY_ICONS = {
  "Tech & setups": "cat-tech",
  Gaming: "cat-gaming",
  Creative: "cat-creative",
  "Just chatting": "cat-chatting",
};

/** The icon of a stored topic category. Unknown categories show the Tech icon, as in the app. */
export function categoryIcon(category) {
  return CATEGORY_ICONS[category] ?? "cat-tech";
}

export function Category({ icon, category = "Tech & setups", children, className = "" }) {
  return (
    <span className={`category ${className}`.trim()}>
      <Icon name={icon ?? categoryIcon(category)} size={24} />
      {children ?? category}
    </span>
  );
}
