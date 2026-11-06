import { useState, type ReactNode } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { configuredProviders } from "../server/auth.server";
import { getOwnStreamer } from "../server/data.server";
import { requestViewer } from "../lib/shell.server";
import { paths } from "../lib/shell";
import { t } from "../i18n";
import { AccountMenu } from "../components/shell/account-menu";
import { SignInDialog } from "../components/shell/sign-in-dialog";
import { Icon } from "../components/ui/icon";
import { Station } from "../components/station/station";
import "../components/station/landing.css";
import { appContext } from "../env";
import { HttpError } from "../server/http.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const app = context.get(appContext);
    const viewer = await requestViewer(request, app);
    const ownStreamer = viewer ? await getOwnStreamer(app.env, viewer.id) : null;
    return { viewer, ownStreamer, providers: configuredProviders(app.env) };
  } catch (error: unknown) {
    if (error instanceof HttpError) throw new Response(error.message, { status: error.status });
    throw error;
  }
}

export default function Home(): ReactNode {
  const { viewer, ownStreamer, providers } = useLoaderData<typeof loader>();
  const [signInOpen, setSignInOpen] = useState<boolean>(false);
  return (
    <div className="landing-page">
      <header className="landing-header">
        <Link className="landing-brand" to={paths.home} aria-label={t("nav.home")}>
          <img className="landing-logo" src="/assets/stream-bullets.svg" alt="" width="305" height="84" />
          <img className="landing-icon" src="/assets/stream-bullets-icon.svg" alt="" width="128" height="136" />
        </Link>
        <nav aria-label={t("account.nav")}>
          {viewer ? (
            <AccountMenu />
          ) : (
            <button type="button" onClick={() => setSignInOpen(true)}>
              <Icon name="sign-in" size={18} />
              {t("signIn.trigger")}
            </button>
          )}
        </nav>
      </header>
      <main className="landing-main" id="main-content">
        <section className="landing-hero" aria-labelledby="landing-title">
          <Station />
          <div className="landing-shade" aria-hidden="true" />
          <div className="landing-copy">
            <h1 id="landing-title">
              YOUR VOICE,
              <br />
              ON AIR.
            </h1>
            <p>Suggest topics. Vote. Shape the stream.</p>
            <div className="landing-actions">
              {viewer ? (
                <Link className="button-link gold" to={ownStreamer ? `/@${ownStreamer.handle}` : "/settings"}>
                  {ownStreamer ? "Open your community" : "Create a streamer profile"}
                </Link>
              ) : (
                <button type="button" className="gold" onClick={() => setSignInOpen(true)}>
                  <Icon name="sign-in" size={18} />
                  {t("signIn.trigger")}
                </button>
              )}
            </div>
          </div>
          <p className="landing-topics" aria-label="Topics, polls and discussions">
            Topics <em aria-hidden="true">/</em> Polls <em aria-hidden="true">/</em> Discussions
          </p>
        </section>
      </main>
      <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} providers={providers} />
    </div>
  );
}
