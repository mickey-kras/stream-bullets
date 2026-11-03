import { useState, type ReactNode } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { configuredProviders, getViewer } from "../server/auth.server";
import { getOwnStreamer, listStreamers } from "../server/data.server";
import { AccountControls, Avatar, EmptyState, Modal, SignIn } from "../components/common";
import { Station } from "../components/station/station";
import "../components/station/landing.css";
import type { Streamer } from "../types";
import { appContext } from "../env";
import { HttpError, queryParams } from "../server/http.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const app = context.get(appContext);
    const cursor = queryParams(request, ["cursor"]).get("cursor");
    const viewer = await getViewer(request, app);
    const [directory, ownStreamer] = await Promise.all([
      listStreamers(app.env, cursor),
      viewer ? getOwnStreamer(app.env, viewer.id) : Promise.resolve(null),
    ]);
    return { viewer, ...directory, cursor, ownStreamer, providers: configuredProviders(app.env) };
  } catch (error: unknown) {
    if (error instanceof HttpError) throw new Response(error.message, { status: error.status });
    throw error;
  }
}

export default function Home(): ReactNode {
  const { viewer, streamers, nextCursor, cursor, ownStreamer, providers } = useLoaderData<typeof loader>();
  const [signInOpen, setSignInOpen] = useState<boolean>(false);
  return (
    <div className="landing-page">
      <header className="landing-header">
        <Link className="landing-brand" to="/" aria-label="StreamBullets home">
          <span className="landing-bars left" aria-hidden="true">
            <b />
            <b />
            <b />
          </span>
          <span className="landing-word">
            Stream
            <br />
            Bullets
          </span>
          <span className="landing-bars right" aria-hidden="true">
            <b />
            <b />
            <b />
          </span>
        </Link>
        <nav aria-label="Account">
          {viewer ? (
            <AccountControls viewer={viewer} providers={providers} />
          ) : (
            <>
              <button type="button" onClick={() => setSignInOpen(true)}>
                Log in
              </button>
              <button type="button" className="gold" onClick={() => setSignInOpen(true)}>
                Register
              </button>
            </>
          )}
        </nav>
      </header>
      <main className="landing-main" id="main-content">
        {!cursor && (
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
                  <>
                    <button type="button" className="gold" onClick={() => setSignInOpen(true)}>
                      Create account
                    </button>
                    <button type="button" className="landing-sage" onClick={() => setSignInOpen(true)}>
                      Log in
                    </button>
                  </>
                )}
              </div>
              <a className="landing-explore" href="#streamers">
                Explore streamers
              </a>
            </div>
            <p className="landing-topics" aria-label="Topics, polls and discussions">
              Topics <em aria-hidden="true">/</em> Polls <em aria-hidden="true">/</em> Discussions
            </p>
          </section>
        )}
        <section className="landing-directory directory-page" id="streamers" aria-labelledby="streamer-directory-title">
          <h2 id="streamer-directory-title">Pick the next conversation</h2>
          <p>Find your streamer. Suggest topics. Vote. Join the discussion.</p>
          <Link className="button-link gold" to={ownStreamer ? `/@${ownStreamer.handle}` : "/settings"}>
            {ownStreamer ? "Open your community" : "Create a streamer profile"}
          </Link>
          {streamers.length ? (
            <div className="streamer-grid">
              {streamers.map((streamer: Streamer) => (
                <Link className="info-card streamer-card" key={streamer.id} to={`/@${streamer.handle}`}>
                  <Avatar name={streamer.name} url={streamer.avatar} />
                  <div>
                    <h2>{streamer.name}</h2>
                    <p>@{streamer.handle}</p>
                    <p className="streamer-bio">{streamer.about || "Topics, polls, and good conversations."}</p>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState title={cursor ? "No more streamers." : "The mic is ready."}>
              {cursor
                ? "Return to the first page to browse streamer profiles."
                : "There are no public streamer profiles yet. Create one when you are ready to host."}
            </EmptyState>
          )}
          {(cursor || nextCursor) && (
            <nav aria-label="Streamer pages" className="flex gap-4">
              {cursor && (
                <Link className="button-link" to="/">
                  First page
                </Link>
              )}
              {nextCursor && (
                <Link className="button-link" to={`/?cursor=${encodeURIComponent(nextCursor)}`}>
                  Next page
                </Link>
              )}
            </nav>
          )}
        </section>
      </main>
      <Modal
        open={signInOpen}
        onOpenChange={setSignInOpen}
        title="Join the conversation"
        description="Sign in to suggest topics, vote, and comment."
      >
        <SignIn providers={providers} />
      </Modal>
    </div>
  );
}
