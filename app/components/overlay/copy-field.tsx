import type { ReactNode } from "react";
import { t } from "../../i18n";
import { copyText } from "../../lib/clipboard";
import { IconButton } from "../ui/icon-button";
import { useToast } from "../ui/toast";

/** A private link in a field that the owner cannot change, with a button that copies it. */
export function CopyField({
  value,
  label,
  copyLabel,
  dock = false,
}: Readonly<{
  value: string;
  label: string;
  copyLabel: string;
  /** True for the link of the OBS dock: it is not an overlay URL. */
  dock?: boolean;
}>): ReactNode {
  const toast = useToast();
  async function copy(): Promise<void> {
    toast((await copyText(value)) ? t("overlay.copied") : t("contact.copyFallback"));
  }
  return (
    <div className="contact-address">
      <input
        className="contact-email ov-url-field"
        type="text"
        readOnly
        value={value}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        data-ov-url={dock ? undefined : ""}
        data-ov-dock-url={dock ? "" : undefined}
      />
      <IconButton label={copyLabel} icon="copy" iconSize={18} onClick={() => void copy()} />
    </div>
  );
}
