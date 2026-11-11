import { useCallback, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, type MetaArgs } from "react-router";
import { directoryHref, SIGN_INTENTS, type Intent } from "../lib/directory";
import { paths, shellFromMatches, useShell } from "../lib/shell";
import { siteJsonLd } from "../lib/structured-data";
import { t } from "../i18n";
import { dialogHref, type DialogState } from "../components/account/dialog-route";
import { AccountMenu } from "../components/shell/account-menu";
import { SignInDialog } from "../components/shell/sign-in-dialog";
import { Icon, type IconName } from "../components/ui/icon";
import { Station } from "../components/station/station";
import "../components/station/landing.css";

const signIcon: Record<Intent, IconName> = { suggest: "plus", vote: "polls", discuss: "comment" };
const signLabel: Record<Intent, "landing.suggest" | "landing.vote" | "landing.discuss"> = {
  suggest: "landing.suggest",
  vote: "landing.vote",
  discuss: "landing.discuss",
};

export function meta({ matches }: MetaArgs) {
  const origin: string = shellFromMatches(matches)?.origin ?? "";
  return [
    { title: t("meta.homeTitle") },
    { name: "description", content: t("meta.homeDescription") },
    { "script:ld+json": siteJsonLd(origin) },
  ];
}

export default function Home(): ReactNode {
  const shell = useShell();
  const location = useLocation();
  const navigate = useNavigate();
  const [signInOpen, setSignInOpen] = useState<boolean>(false);
  // A sign on the station (item 4): it flips, then the Streamers list opens with that intent.
  const openSign = useCallback(
    (index: number): void => {
      const intent: Intent | undefined = SIGN_INTENTS[index];
      if (intent) navigate(directoryHref(intent));
    },
    [navigate],
  );
  const browse = (className: string): ReactNode => (
    <Link className={`button-link ${className}`} to={paths.streamers}>
      {t("landing.browse")}
      <Icon name="arrow-right" size={18} />
    </Link>
  );
  return (
    <div className="landing-page">
      <header className="landing-header">
        <Link className="landing-brand" to={paths.home} aria-label={t("nav.home")}>
          <img className="landing-logo" src="/assets/stream-bullets.svg" alt="" width="305" height="84" />
          <img className="landing-icon" src="/assets/stream-bullets-icon.svg" alt="" width="128" height="136" />
        </Link>
        <nav aria-label={t("account.nav")}>
          {shell.viewer ? (
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
          <Station onSign={openSign} />
          <div className="landing-shade" aria-hidden="true" />
          <div className="landing-copy">
            <h1 id="landing-title">
              <span className="title-line">{t("landing.title1")}</span>{" "}
              <span className="title-line">{t("landing.title2")}</span>
            </h1>
            <p>{t("landing.tagline")}</p>
            <p>{t("landing.streamerBenefits")}</p>
            <div className="landing-actions">
              {shell.ownStreamer ? (
                <>
                  <Link className="button-link gold" to={paths.streamer(shell.ownStreamer.handle)}>
                    <Icon name="your-page" size={18} />
                    {t("nav.yourPage")}
                  </Link>
                  {browse("secondary")}
                </>
              ) : (
                <>
                  {browse("gold")}
                  <Link
                    className="button-link secondary"
                    to={dialogHref(location, "host")}
                    state={{ dialogFrom: location.pathname } satisfies DialogState}
                    preventScrollReset
                  >
                    <Icon name="mic" size={18} />
                    {t("landing.joinStreamer")}
                  </Link>
                </>
              )}
            </div>
            {/* The station's signs as plain links, for keyboards, screen readers and anyone without WebGL. */}
            <ul className="landing-start" aria-label={t("landing.getStarted")}>
              {SIGN_INTENTS.map((intent: Intent) => (
                <li key={intent}>
                  <Link to={directoryHref(intent)}>
                    <Icon name={signIcon[intent]} size={16} />
                    {t(signLabel[intent])}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <p className="landing-topics">
            <span className="sr-only">{t("landing.topicsLabel")}</span>
            <span aria-hidden="true">
              {t("streamer.nav.topics")} <em>/</em> {t("streamer.nav.polls")} <em>/</em> {t("landing.discussions")}
            </span>
          </p>
        </section>
      </main>
      <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} providers={shell.providers} />
    </div>
  );
}
