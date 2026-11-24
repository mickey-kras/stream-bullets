import { Icon, Logo } from "../src/index.js";

// The station poster of each width (app/public/assets). The build turns these upload ids into file paths.
const POSTER = "/_blob/36c2158ea840e29094802fe4ecc4c0ef";
const POSTER_PHONE = "/_blob/16f4630fd22b33cd5ab57b51009ea64e";

const STARTS = [
  { id: "suggest", icon: "plus", label: "Suggest a topic" },
  { id: "vote", icon: "polls", label: "Vote in a poll" },
  { id: "discuss", icon: "comment", label: "Discuss the stream" },
];

// The landing page: app/routes/home.tsx for a signed-out reader. The 3D station of the app is WebGL; the kit
// shows its poster, the frame that the app shows until the station loads.
export function Landing({ onSignIn }) {
  return (
    <div className="landing-page">
      <header className="landing-header">
        <a className="landing-brand" href="#landing" aria-label="StreamBullets home">
          <Logo kind="full" className="landing-logo" />
          <Logo kind="icon" className="landing-icon" />
        </a>
        <nav aria-label="Account">
          <button type="button" onClick={onSignIn}>
            <Icon name="sign-in" size={18} />
            Sign in / Sign up
          </button>
        </nav>
      </header>
      <main className="landing-main" id="main-content">
        <section className="landing-hero" aria-labelledby="landing-title">
          <section className="landing-station" aria-label="Interactive broadcast station" data-status="loading">
            <picture>
              <source media="(max-width: 700px)" srcSet={POSTER_PHONE} width={487} height={557} />
              <img className="station-poster" src={POSTER} alt="" width="1024" height="1024" fetchpriority="high" />
            </picture>
            <div className="landing-canvas" />
          </section>
          <div className="landing-shade" aria-hidden="true" />
          <div className="landing-copy">
            <h1 id="landing-title">
              <span className="title-line">YOUR VOICE,</span> <span className="title-line">ON AIR.</span>
            </h1>
            <p>Suggest topics. Vote. Shape the stream.</p>
            <p>
              Collect topics from your viewers, run audience polls, and show your Twitch, YouTube and Kick chat in one
              OBS overlay.
            </p>
            <div className="landing-actions">
              <a className="button-link gold" href="#streamers">
                Browse streamers
                <Icon name="arrow-right" size={18} />
              </a>
              <a className="button-link secondary" href="#topics">
                <Icon name="mic" size={18} />
                Join as a streamer
              </a>
            </div>
            <ul className="landing-start" aria-label="Get started">
              {STARTS.map((start) => (
                <li key={start.id}>
                  <a href="#streamers">
                    <Icon name={start.icon} size={16} />
                    {start.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <p className="landing-topics">
            <span className="sr-only">Topics, polls and discussions</span>
            <span aria-hidden="true">
              Topics <em>/</em> Polls <em>/</em> Discussions
            </span>
          </p>
        </section>
      </main>
    </div>
  );
}
