import { useEffect, useState } from "react";
import { OverlayCard, OverlayMash, OverlayPoll } from "../src/index.js";

const PAGE = "https://streambullets.com/@sunny";

/** A counter that goes up by one each `ms`. */
function useTick(ms) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return tick;
}

function LivePoll({ qr }) {
  const tick = useTick(1500);
  return (
    <OverlayPoll
      title="Should we explore more local AI on stream?"
      options={["Yes, more local AI", "A mix of both", "Stick to cloud tools"]}
      counts={[48 + tick * 2, 31 + tick, 9 + Math.floor(tick / 2)]}
      secondsLeft={Math.max(0, 3720 - Math.floor(tick * 1.5))}
      qr={qr ? `${PAGE}?view=polls&entry=demo` : null}
    />
  );
}

/** A 30 s battle, then 6 s of the winner, then again. */
function LiveMash({ qr }) {
  const tick = useTick(1000) % 36;
  const left = Math.max(0, 30 - tick);
  return (
    <OverlayMash
      title="Which boss first?"
      sides={["Malenia", "Radahn", "Fire Giant"]}
      totals={[tick * 3, tick * 4, tick]}
      phase={left > 0 ? "live" : "finished"}
      left={left}
      duration={30}
      qr={qr ? `${PAGE}?view=polls&entry=battle` : null}
    />
  );
}

/** The content of a content layer, by its source. */
export function Content({ source, qr }) {
  if (source === "poll") return <LivePoll qr={qr} />;
  if (source === "mash") return <LiveMash qr={qr} />;
  if (source === "topic")
    return (
      <OverlayCard
        kind="topic"
        title="Can AI run my homelab?"
        author="TechNomad"
        authorPreset={0}
        likes={142}
        qr={qr ? `${PAGE}?view=topics&entry=homelab` : null}
      />
    );
  if (source === "next")
    return (
      <OverlayCard
        kind="next"
        title="Building a quiet streaming PC"
        when="Fri 8:00 PM"
        startsIn="in 45 min"
        qr={qr ? `${PAGE}?view=schedule` : null}
      />
    );
  if (source === "message") return <OverlayCard kind="message" messageStyle="hype" title="Raid incoming. Say hi!" />;
  if (source === "card")
    return (
      <OverlayCard
        kind="card"
        title="Join the Discord"
        body="Clips, schedule changes and the homelab build log."
        cta="Join us"
        ctaTarget="https://discord.gg/sunny"
        qr={qr ? `${PAGE}?view=community` : null}
      />
    );
  if (source === "support")
    return <OverlayCard kind="support" link="https://ko-fi.com/sunny" qr={qr ? "https://ko-fi.com/sunny" : null} />;
  return null;
}
