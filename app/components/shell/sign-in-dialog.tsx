import { useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { authClient } from "../../auth-client";
import { t } from "../../i18n";
import { signupPolicy } from "../../signup-policy";
import { legal } from "../../legal";
import { localPath, paths, type Provider } from "../../lib/shell";
import { dialogHref } from "../account/dialog-route";
import { errorMessage } from "../api";
import { Dialog } from "../ui/dialog";
import { Icon, type IconName } from "../ui/icon";

const providerIcon: Record<Provider, IconName> = {
  google: "google",
  tiktok: "tiktok",
  twitch: "twitch",
  instagram: "instagram",
};
export const providerName: Record<Provider, string> = {
  google: "Google",
  tiktok: "TikTok",
  twitch: "Twitch",
  instagram: "Instagram",
};

// Preserve the initiating page and intent through OAuth. New accounts open their profile over that page.
// Failed sign-in carries the destination in ?next= so retries return there.
function useHere(): string {
  const { pathname, search } = useLocation();
  // On the error landing itself, "here" is the page it carries, not /sign-in with its error.
  if (pathname === "/sign-in") return localPath(new URLSearchParams(search).get("next")) ?? "/settings";
  return `${pathname}${search}`;
}

// Open Your profile without losing intent or hash.
function profileOver(path: string): string {
  const url = new URL(path, "https://local.invalid");
  return dialogHref(url, "profile");
}

// Show configured providers, provider restrictions, eligibility consent and errors.
export function SignIn({
  providers,
  callbackURL,
}: Readonly<{
  providers: Provider[];
  callbackURL?: string;
}>): ReactNode {
  const here: string = useHere();
  const [accepted, setAccepted] = useState<boolean>(false);
  const [displayName, setDisplayName] = useState<string>("");
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string>("");
  const returnTo: string = callbackURL ?? here;
  async function signIn(provider: Provider): Promise<void> {
    setError("");
    setPending(provider);
    try {
      // The social endpoint also handles generic OAuth Instagram.
      const result = await authClient.signIn.social({
        provider: provider as "google",
        callbackURL: returnTo,
        errorCallbackURL: `/sign-in?${new URLSearchParams({ next: returnTo }).toString()}`,
        newUserCallbackURL: profileOver(returnTo),
        additionalData: { acceptance: { accepted, ...signupPolicy }, ...(displayName.trim() ? { displayName } : {}) },
      });
      if (result.error)
        throw new Error(t(result.error.code === "INVALID_DISPLAY_NAME" ? "signup.nameCorrection" : "signIn.failed"));
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setPending(null);
    }
  }
  return (
    <div className="sign-in-options">
      {providers.length > 0 && (
        <>
          <label>
            <span>{t("signup.displayName")}</span>
            <input
              name="signup-name"
              value={displayName}
              maxLength={40}
              onChange={(event) => setDisplayName(event.currentTarget.value)}
            />
          </label>
          <label>
            <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.currentTarget.checked)} />
            <span>
              {t("signup.accept", { age: legal.minimumAge })} <Link to={paths.terms}>{t("legal.terms")}</Link>{" "}
              {t("signIn.and")} <Link to={paths.privacy}>{t("legal.privacyPolicy")}</Link>.
            </span>
          </label>
        </>
      )}
      {providers.map((provider: Provider) => {
        const label: string = t("signIn.continueWith", { provider: providerName[provider] });
        let content: ReactNode = pending === provider ? t("signIn.connecting") : label;
        if (provider === "instagram" && pending !== provider)
          content = (
            <span className="two-line">
              <span>{label}</span>
              <small>{t("signIn.instagramNote")}</small>
            </span>
          );
        const button: ReactNode = (
          <button
            type="button"
            className={provider === "instagram" ? "gold sign-in-two-line" : "gold"}
            disabled={pending !== null || !accepted}
            key={provider}
            aria-describedby={provider === "google" ? "hint-google" : undefined}
            onClick={() => {
              void signIn(provider);
            }}
          >
            <Icon name={providerIcon[provider]} size={18} />
            {content}
          </button>
        );
        if (provider !== "google") return button;
        return (
          <div className="sign-in-choice" key={provider}>
            {button}
            <p className="sign-in-hint" id="hint-google">
              {t("signIn.youtubeHint")}
            </p>
          </div>
        );
      })}
      {providers.length === 0 && <output>{t("signIn.off")}</output>}
      <p className="form-error" role="alert">
        {error}
      </p>
      <p className="sign-in-legal">
        {providers.length > 0 ? (
          <>
            {t("signIn.consent", { age: legal.minimumAge })} <Link to={paths.terms}>{t("legal.terms")}</Link>{" "}
            {t("signIn.and")} <Link to={paths.privacy}>{t("legal.privacyPolicy")}</Link>.
          </>
        ) : (
          <>
            {t("signIn.read")} <Link to={paths.terms}>{t("legal.terms")}</Link> {t("signIn.and")}{" "}
            <Link to={paths.privacy}>{t("legal.privacyPolicy")}</Link>.
          </>
        )}
      </p>
    </div>
  );
}

// One OAuth flow signs in or creates an account. reason explains interrupted actions.
export function SignInDialog({
  open,
  onOpenChange,
  providers,
  callbackURL,
  reason,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: Provider[];
  callbackURL?: string;
  reason?: string;
}>): ReactNode {
  const description: string = reason ? t("signIn.descriptionWithReason", { reason }) : t("signIn.description");
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("signIn.title")}
      description={providers.length > 0 ? description : undefined}
    >
      <SignIn providers={providers} callbackURL={callbackURL} />
    </Dialog>
  );
}

export function SignInButton({
  providers,
  className = "header-signin",
}: Readonly<{ providers: Provider[]; className?: string }>): ReactNode {
  const [open, setOpen] = useState<boolean>(false);
  return (
    <>
      <button type="button" className={className} aria-label={t("signIn.trigger")} onClick={() => setOpen(true)}>
        <Icon name="sign-in" size={18} />
        <span className="header-signin-label">{t("signIn.trigger")}</span>
        <span className="header-signin-short" aria-hidden="true">
          {t("signIn.short")}
        </span>
      </button>
      <SignInDialog open={open} onOpenChange={setOpen} providers={providers} />
    </>
  );
}
