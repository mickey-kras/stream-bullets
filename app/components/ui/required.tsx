import type { ReactNode } from "react";
import { t } from "../../i18n";

// Hide visible required-field markers from assistive technology; native required supplies the semantics.
export function RequiredNote(): ReactNode {
  return (
    <p className="req-note" aria-hidden="true">
      <span className="req">*</span> {t("form.required")}
    </p>
  );
}

export function Req(): ReactNode {
  return (
    <span className="req" aria-hidden="true">
      {" "}
      *
    </span>
  );
}
