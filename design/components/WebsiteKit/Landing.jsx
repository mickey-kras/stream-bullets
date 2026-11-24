import { Button, Logo } from "../src/index.js";

export function Landing({ go }) {
  return (
    <div className="lp">
      <header className="lp-head">
        <Logo height={72} />
        <nav>
          <Button variant="ghost" font="display" onClick={() => go("streamers")}>
            Streamers
          </Button>
          <Button landing variant="gold" onClick={() => go("streamers")}>
            Sign in
          </Button>
        </nav>
      </header>
      <img className="lp-station" src="/_blob/36c2158ea840e29094802fe4ecc4c0ef" alt="" />
      <div className="lp-copy">
        <h1>
          Your voice,
          <br />
          on air.
        </h1>
        <p>Suggest topics. Vote. Shape the stream.</p>
        <div className="lp-actions">
          <Button landing variant="gold" onClick={() => go("streamers")}>
            Get started
          </Button>
          <Button landing onClick={() => go("streamers")}>
            Browse streamers
          </Button>
        </div>
      </div>
      <div className="lp-topics">
        <span>Topics</span>
        <em>·</em>
        <span>Polls</span>
        <em>·</em>
        <span>Discussions</span>
      </div>
    </div>
  );
}
