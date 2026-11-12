import { useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { authClient } from "../../auth-client";
import { t } from "../../i18n";
import { legal } from "../../legal";
import { paths, type Provider } from "../../lib/shell";
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

/** Back to the page the person signed in from (the OAuth round trip lands there again). */
function useHere(): string {
  const { pathname, search } = useLocation();
  return `${pathname}${search}`;
}

/**
 * The provider buttons (Google, TikTok, Twitch, Instagram: only those configured), the YouTube hint under
 * Google, Instagram's account-type note on its button, the age and terms consent line, and any error.
 */
export function SignIn({
  providers,
  callbackURL,
}: Readonly<{
  providers: Provider[];
  callbackURL?: string;
}>): ReactNode {
  const here: string = useHere();
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string>("");
  async function signIn(provider: Provider): Promise<void> {
    setError("");
    setPending(provider);
    try {
      // Instagram is a generic OAuth provider: the social sign-in endpoint serves it too.
      const result = await authClient.signIn.social({
        provider: provider as "google",
        callbackURL: callbackURL ?? here,
      });
      if (result.error) throw new Error(t("signIn.failed"));
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setPending(null);
    }
  }
  return (
    <div className="sign-in-options">
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
            disabled={pending !== null}
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

/**
 * "Sign in or sign up": one OAuth step creates the account or signs in (approved items 1 and 6). `reason`
 * ("Sign in to suggest a topic") leads the description when the dialog interrupts an action.
 */
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

/** The header's sign-in control for signed-out visitors: "Sign in / Sign up" (short "Sign in" on phones). */
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
