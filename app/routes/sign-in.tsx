import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { ReactNode } from "react";
import { appContext } from "../env";
import { configuredProviders } from "../server/auth.server";
import { SignIn } from "../components/shell/sign-in-dialog";
import { BackLink } from "../components/shell/back-link";
import { SiteHeader } from "../components/shell/site-header";
import { t, type MessageId } from "../i18n";
import { contactEmails } from "../legal";
import { localPath } from "../lib/shell";
import type { Provider } from "../types";

const errors: Readonly<Record<string, MessageId>> = {
  account_not_linked: "signup.sameEmail",
  account_already_linked_to_different_user: "signup.owned",
  INVALID_DISPLAY_NAME: "signup.nameCorrection",
  ELIGIBILITY_REQUIRED: "signup.eligibility",
  reauth_required: "loginMethods.reauthenticate",
  unable_to_link_account: "loginMethods.failed",
};

export function meta() {
  return [{ title: `${t("signIn.title")} · StreamBullets` }, { name: "robots", content: "noindex" }];
}

/** The OAuth error landing. `?next=` is the page the person signed in from; the retry returns there. */
export function loader({ request, context }: LoaderFunctionArgs): {
  providers: Provider[];
  error: MessageId | null;
  next: string;
} {
  const params: URLSearchParams = new URL(request.url).searchParams;
  const error: string | null = params.get("error");
  return {
    providers: configuredProviders(context.get(appContext).env),
    error: error ? (errors[error] ?? "signIn.failed") : null,
    next: localPath(params.get("next")) ?? "/settings",
  };
}

export default function SignInPage(): ReactNode {
  const { providers, error, next } = useLoaderData<typeof loader>();
  return (
    <>
      <SiteHeader />
      <main className="page-panel settings-page" id="main-content">
        <div className="page-column">
          <BackLink />
          <h1>{t("signIn.title")}</h1>
          {error && <p role="alert">{t(error)}</p>}
          <SignIn providers={providers} callbackURL={next} />
          <a href={`mailto:${contactEmails.support}`}>{contactEmails.support}</a>
        </div>
      </main>
    </>
  );
}
