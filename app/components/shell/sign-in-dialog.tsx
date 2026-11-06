import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { authClient } from "../../auth-client";
import { t } from "../../i18n";
import { legal } from "../../legal";
import { paths, type Provider } from "../../lib/shell";
import { errorMessage } from "../api";
import { Dialog } from "../ui/dialog";
import { Icon, type IconName } from "../ui/icon";

const providerIcon: Record<Provider, IconName> = { google: "google", twitch: "twitch" };
const providerName: Record<Provider, string> = { google: "Google", twitch: "Twitch" };

/** The provider buttons, the age and terms consent line, and any sign-in error. */
export function SignIn({
  providers,
  callbackURL = paths.settings,
}: Readonly<{
  providers: Provider[];
  callbackURL?: string;
}>): ReactNode {
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string>("");
  async function signIn(provider: Provider): Promise<void> {
    setError("");
    setPending(provider);
    try {
      const result = await authClient.signIn.social({ provider, callbackURL });
      if (result.error) throw new Error(result.error.message || t("signIn.failed"));
    } catch (error_: unknown) {
      setError(errorMessage(error_));
    } finally {
      setPending(null);
    }
  }
  return (
    <div className="sign-in-options">
      {providers.map((provider: Provider) => (
        <button
          type="button"
          className="gold"
          disabled={pending !== null}
          key={provider}
          onClick={() => {
            void signIn(provider);
          }}
        >
          <Icon name={providerIcon[provider]} size={18} />
          {pending === provider
            ? t("signIn.connecting")
            : t("signIn.continueWith", { provider: providerName[provider] })}
        </button>
      ))}
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

/** "Sign in or sign up": one OAuth step creates the account or signs in (approved item 1). */
export function SignInDialog({
  open,
  onOpenChange,
  providers,
  callbackURL,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: Provider[];
  callbackURL?: string;
}>): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("signIn.title")} description={t("signIn.description")}>
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
