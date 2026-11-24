import { Icon } from "../core/Icon.jsx";

// "Back to …" on account, Admin, legal and error pages (app/components/shell/back-link.tsx). The app links
// to the last content page that the reader opened, or to Streamers.
export function BackLink({ name = "Streamers", href = "/streamers", children }) {
  return (
    <a className="back-link" href={href}>
      <Icon name="chevron-left" size={16} />
      {children ?? `Back to ${name}`}
    </a>
  );
}
