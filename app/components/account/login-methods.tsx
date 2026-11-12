import { useEffect, useState, type ReactNode } from "react";
import { authClient } from "../../auth-client";
import { useShell } from "../../lib/shell";
import { t } from "../../i18n";
import { providerName } from "../shell/sign-in-dialog";
import { SignIn } from "../shell/sign-in-dialog";
import type { Provider } from "../../types";

interface LoginAccount {
  id: string;
  providerId: string;
}

export function LoginMethods({ blocked }: Readonly<{ blocked: boolean }>): ReactNode {
  const configured: Provider[] = useShell().providers;
  const [accounts, setAccounts] = useState<LoginAccount[]>([]);
  const [error, setError] = useState<string>("");
  const [pending, setPending] = useState<boolean>(true);
  const [reauth, setReauth] = useState<boolean>(false);
  useEffect(() => {
    let active: boolean = true;
    authClient.listAccounts().then(
      (result) => {
        if (!active) return;
        if (result.error) setError(t("loginMethods.failed"));
        else setAccounts(result.data ?? []);
        setPending(false);
      },
      () => {
        if (active) {
          setError(t("loginMethods.failed"));
          setPending(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);
  async function change(provider: Provider, accountId?: string): Promise<void> {
    if (blocked) return;
    setPending(true);
    setError("");
    try {
      const result: Awaited<ReturnType<typeof authClient.unlinkAccount> | ReturnType<typeof authClient.linkSocial>> =
        accountId
          ? await authClient.unlinkAccount({ accountId })
          : await authClient.linkSocial({
              provider: provider as "google",
              callbackURL: "/settings",
              errorCallbackURL: "/sign-in",
            });
      if (result.error) {
        setReauth(result.error.code === "REAUTH_REQUIRED");
        setError(result.error.code === "REAUTH_REQUIRED" ? t("loginMethods.reauthenticate") : t("loginMethods.failed"));
      } else if (accountId) setAccounts((current) => current.filter((account) => account.id !== accountId));
    } catch {
      setError(t("loginMethods.failed"));
    } finally {
      setPending(false);
    }
  }
  const usableAccounts: LoginAccount[] = accounts.filter((account) =>
    configured.some((provider) => provider === account.providerId),
  );
  const providers: Provider[] = configured.filter((provider) =>
    usableAccounts.some((account) => account.providerId === provider),
  );
  return (
    <section aria-label={t("loginMethods.title")}>
      <h2>{t("loginMethods.title")}</h2>
      <p>{t("loginMethods.explanation")}</p>
      {blocked && <p>{t("loginMethods.unsaved")}</p>}
      {configured.map((provider: Provider) => {
        const linked: LoginAccount[] = accounts.filter((account) => account.providerId === provider);
        return (
          <div key={provider}>
            {linked.map((account) => (
              <button
                type="button"
                key={account.id}
                disabled={pending || blocked || usableAccounts.length < 2}
                onClick={() => void change(provider, account.id)}
              >
                {t("loginMethods.unlink", { provider: providerName[provider] })}
              </button>
            ))}
            {linked.length === 0 && (
              <button type="button" disabled={pending || blocked} onClick={() => void change(provider)}>
                {t("loginMethods.link", { provider: providerName[provider] })}
              </button>
            )}
          </div>
        );
      })}
      <p>{t("loginMethods.last")}</p>
      <p role="alert">{error}</p>
      {reauth && !blocked && <SignIn providers={providers} callbackURL="/settings" />}
    </section>
  );
}
