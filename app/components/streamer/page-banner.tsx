import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { t } from "../../i18n";
import { paths } from "../../lib/shell";
import type { StreamerStatus } from "../../types";
import { ContactDialog } from "../shell/contact-dialog";
import { Icon } from "../ui/icon";

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
      <span>
        {t(frozen ? "moderation.frozenOwner" : "moderation.suspendedOwner")}
        {reason && ` ${t("moderation.reason", { reason })}`}
      </span>
      <button type="button" className="text-button banner-link" onClick={() => setContact(true)}>
        <Icon name="mail" size={16} />
        {t("moderation.appeal")}
      </button>
      <ContactDialog open={contact} onOpenChange={setContact} />
    </div>
  );
}
