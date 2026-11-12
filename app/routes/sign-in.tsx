import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { ReactNode } from "react";
import { appContext } from "../env";
import { configuredProviders } from "../server/auth.server";
import { SignIn } from "../components/shell/sign-in-dialog";
import { t, type MessageId } from "../i18n";
import { contactEmails } from "../legal";
import type { Provider } from "../types";

const errors: Readonly<Record<string, MessageId>> = {
  account_not_linked: "signup.sameEmail",
  account_already_linked_to_different_user: "signup.owned",
  INVALID_DISPLAY_NAME: "signup.nameCorrection",
  ELIGIBILITY_REQUIRED: "signup.eligibility",
  reauth_required: "loginMethods.reauthenticate",
};

export function loader({ request, context }: LoaderFunctionArgs): { providers: Provider[]; error: MessageId | null } {
  const error: string | null = new URL(request.url).searchParams.get("error");
  return {
    providers: configuredProviders(context.get(appContext).env),
    error: error ? (errors[error] ?? "signIn.failed") : null,
  };
}

export default function SignInPage(): ReactNode {
  const { providers, error } = useLoaderData<typeof loader>();
  return (
    <main className="page">
      <h1>{t("signIn.title")}</h1>
      {error && <p role="alert">{t(error)}</p>}
      <SignIn providers={providers} callbackURL="/settings" />
      <a href={`mailto:${contactEmails.support}`}>{contactEmails.support}</a>
    </main>
  );
}
