import type { ReactNode } from "react";
import { t } from "../../i18n";

/**
 * Required fields carry a visible "*" and each form explains it once (mockup m2, round 3). The native `required`
 * attribute already tells assistive technology, so both markers are hidden from it.
 */
export function RequiredNote(): ReactNode {
  return (
    <p className="req-note" aria-hidden="true">
      <span className="req">*</span> {t("form.required")}
    </p>
  );
}

/** The "*" after a required field's label. */
export function Req(): ReactNode {
  return (
    <span className="req" aria-hidden="true">
      {" "}
      *
    </span>
  );
}
