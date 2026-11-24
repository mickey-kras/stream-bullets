import { Icon } from "../core/Icon.jsx";

// Moderation notices of a page (app/components/streamer/page-banner.tsx).
const TEXT = {
  frozenViewer: "This page is frozen. Viewing only — no new posts, votes, or polls right now.",
  frozenAdmin: "This page is frozen. Nobody can post or vote. As an administrator you can lift it.",
  suspendedAdmin: "This page is suspended and hidden from the public. You can see it because you're an administrator.",
  frozenOwner: "Your page is frozen. Your content stays visible, but no one can post or vote.",
  suspendedOwner: "Your page is suspended. It's hidden from the public until the suspension is lifted.",
};

// The owner notice in the account menu and the edit dialog.
export function OwnerNotice({ status = "frozen", children }) {
  if (status === "active") return null;
  return (
    <p className={`owner-notice ${status}`}>
      <Icon name={status === "frozen" ? "lock" : "eye-off"} size={16} />
      <span>{children ?? TEXT[status === "frozen" ? "frozenOwner" : "suspendedOwner"]}</span>
    </p>
  );
}

// Frozen pages are read only. Viewers see a note; the owner can appeal; administrators can lift it.
export function Banner({
  tone = "frozen",
  role,
  children,
  appealLabel = "Appeal / contact us",
  onAppeal,
  unfreezeLabel = "Unfreeze",
  onUnfreeze,
  moderationLabel = "Open moderation",
  moderationHref = "/admin?view=pages",
}) {
  const frozen = tone === "frozen";
  const who = role ?? (frozen ? "viewer" : "owner");
  const icon = <Icon name={frozen ? "lock" : "eye-off"} size={18} />;
  if (who === "viewer")
    return (
      <p className="page-banner frozen" id="page-banner">
        {icon}
        {children ?? TEXT.frozenViewer}
      </p>
    );
  const className = `page-banner ${frozen ? "frozen " : ""}suspended`;
  if (who === "admin")
    return (
      <div className={className} id="page-banner">
        {icon}
        <span>{children ?? TEXT[frozen ? "frozenAdmin" : "suspendedAdmin"]}</span>
        <div className="banner-actions">
          {frozen && (
            <button type="button" className="text-button banner-link" onClick={onUnfreeze}>
              <Icon name="reset" size={16} />
              {unfreezeLabel}
            </button>
          )}
          <a className="text-link banner-link" href={moderationHref}>
            <Icon name="shield-check" size={16} />
            {moderationLabel}
          </a>
        </div>
      </div>
    );
  return (
    <div className={className} id="page-banner">
      {icon}
      <span>{children ?? TEXT[frozen ? "frozenOwner" : "suspendedOwner"]}</span>
      <button type="button" className="text-button banner-link" onClick={onAppeal}>
        <Icon name="mail" size={16} />
        {appealLabel}
      </button>
    </div>
  );
}
