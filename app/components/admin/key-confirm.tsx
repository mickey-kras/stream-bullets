import { useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { Icon } from "../ui/icon";
import { ceremonyError, confirmWithKey, webAuthnAvailable } from "./webauthn";

/** What to do when keys are lost. Recovery is operator-only (SECURITY.md). */
export function LostKeys(): ReactNode {
  return (
    <details className="key-lost">
      <summary>{t("keys.lostTitle")}</summary>
      <p>{t("keys.lostBody")}</p>
    </details>
  );
}

/**
 * "Confirm it's you": one WebAuthn assertion with a registered security key. On success the server stamps this
 * session, and `onConfirmed` runs (reload the data, or retry the action that asked for it).
 */
export function KeyConfirm({
  onConfirmed,
  inDialog = false,
  label,
}: Readonly<{
  onConfirmed: () => Promise<void> | void;
  inDialog?: boolean;
  /** The button text; "Use security key" by default. */
  label?: string;
}>): ReactNode {
  const [phase, setPhase] = useState<"idle" | "waiting">("idle");
  const [error, setError] = useState<string>("");

  async function confirm(): Promise<void> {
    if (phase === "waiting") return;
    if (!webAuthnAvailable()) {
      setError(t("keys.unsupported"));
      return;
    }
    setPhase("waiting");
    setError("");
    try {
      await confirmWithKey();
      await onConfirmed();
    } catch (error_: unknown) {
      setError(ceremonyError(error_));
    } finally {
      setPhase("idle");
    }
  }

  return (
    <div className={`key-gate ${inDialog ? "in-dialog" : "info-card"}`}>
      <span className="key-badge">
        <Icon name="shield-check" size={40} />
      </span>
      {!inDialog && <h2 id="gate-title">{t("keys.confirmTitle")}</h2>}
      <p className="key-hint">{t("keys.hint")}</p>
      {phase === "waiting" ? (
        <output className="key-wait">
          <span className="key-pulse">
            <Icon name="key" size={40} />
          </span>
          {t("keys.waiting")}
        </output>
      ) : (
        <>
          <p className="form-error key-error" role="alert">
            {error && <Icon name="error" size={18} />}
            {error}
          </p>
          <div className="key-actions">
            <button
              type="button"
              className="gold"
              onClick={() => {
                void confirm();
              }}
            >
              <Icon name="key" size={20} />
              {error ? t("keys.tryAgain") : (label ?? t("keys.use"))}
            </button>
          </div>
        </>
      )}
      <LostKeys />
      <p className="muted key-foot">{t("keys.foot")}</p>
    </div>
  );
}
