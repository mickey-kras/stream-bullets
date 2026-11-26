import { useEffect, type ReactNode } from "react";
import { t } from "../../i18n";
import { announce } from "../a11y/announcer";
import { Icon } from "../ui/icon";

/**
 * The note that live updates are away. Changes still save and reach OBS after the reconnect. `reconnect` is set
 * when the page stopped retrying.
 */
export function ConnectionNote({
  connected,
  reconnect,
}: Readonly<{ connected: boolean; reconnect?: () => void }>): ReactNode {
  const offline: boolean = reconnect !== undefined;
  useEffect(() => {
    if (!connected) announce(t(offline ? "overlay.offline" : "overlay.disconnected"));
  }, [connected, offline]);
  if (connected) return null;
  return (
    <p className="ov-conn">
      <Icon name="wifi-off" size={18} />
      <span>
        <strong>{t(offline ? "overlay.offline" : "overlay.disconnected")}</strong> {t("overlay.disconnectedBody")}
      </span>
      {reconnect && (
        <button type="button" onClick={reconnect}>
          {t("overlay.reconnect")}
        </button>
      )}
    </p>
  );
}
