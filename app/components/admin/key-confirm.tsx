import { useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { Icon } from "../ui/icon";
import { ceremonyError, confirmWithKey, webAuthnAvailable } from "./webauthn";

// Operator-only lost-key recovery; see SECURITY.md.
export function LostKeys(): ReactNode {
  return (
    <details className="key-lost">
      <summary>{t("keys.lostTitle")}</summary>
      <p>{t("keys.lostBody")}</p>
    </details>
  );
}

// WebAuthn assertion stamps this session; onConfirmed reloads data or retries the action.
export function KeyConfirm({
  onConfirmed,
  inDialog = false,
  pageHeading = false,
  label,
}: Readonly<{
  onConfirmed: () => Promise<void> | void;
  inDialog?: boolean;
  // Gate title is the page h1.
  pageHeading?: boolean;
  // Default: Use security key.
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
      {!inDialog &&
        (pageHeading ? (
          <h1 id="gate-title">{t("keys.confirmTitle")}</h1>
        ) : (
          <h2 id="gate-title">{t("keys.confirmTitle")}</h2>
        ))}
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
