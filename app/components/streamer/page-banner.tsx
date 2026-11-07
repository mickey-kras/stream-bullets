import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { t } from "../../i18n";
import { ownerNotice } from "../../lib/moderation";
import { paths } from "../../lib/shell";
import type { StreamerStatus } from "../../types";
import { ContactDialog } from "../shell/contact-dialog";
import { Icon } from "../ui/icon";

/**
 * The owner's notice for a frozen or suspended page outside the page itself (R13): in the account menu and the
 * Edit your page dialog, so the owner learns about it wherever they are. Renders nothing for an active page.
 */
export function OwnerNotice({
  status,
  reason,
}: Readonly<{ status: StreamerStatus; reason: string | null }>): ReactNode {
  if (status === "active") return null;
  return (
    <p className={`owner-notice ${status}`}>
      <Icon name={status === "frozen" ? "lock" : "eye-off"} size={16} />
      <span>{ownerNotice(status, reason)}</span>
    </p>
  );
}

/**
 * The frozen or suspended notice above a moderated page (item 25). Viewers of a frozen page learn it is read-only.
 * The owner sees the reason and a way to appeal; admins see that they can lift it.
 */
export function PageBanner({
  status,
  reason,
  role,
}: Readonly<{ status: StreamerStatus; reason: string | null; role: "owner" | "admin" | "viewer" }>): ReactNode {
  const [contact, setContact] = useState<boolean>(false);
  if (status === "active") return null;
  const frozen = status === "frozen";
  const icon = <Icon name={frozen ? "lock" : "eye-off"} size={18} />;
  if (role === "viewer")
    return (
      <p className="page-banner frozen" id="page-banner">
        {icon}
        {t("moderation.frozenViewer")}
      </p>
    );
  if (role === "admin")
    return (
      <div className={`page-banner ${frozen ? "frozen " : ""}suspended`} id="page-banner">
        {icon}
        <span>{t(frozen ? "moderation.frozenAdmin" : "moderation.suspendedAdmin")}</span>
        <Link className="text-link banner-link" to={paths.admin}>
          <Icon name="shield-check" size={16} />
          {t("moderation.openModeration")}
        </Link>
      </div>
    );
  return (
    <div className={`page-banner ${frozen ? "frozen " : ""}suspended`} id="page-banner">
      {icon}
      <span>{ownerNotice(status, reason)}</span>
      <button type="button" className="text-button banner-link" onClick={() => setContact(true)}>
        <Icon name="mail" size={16} />
        {t("moderation.appeal")}
      </button>
      <ContactDialog open={contact} onOpenChange={setContact} />
    </div>
  );
}
