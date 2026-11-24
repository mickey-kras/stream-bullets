import { useEffect, useState } from "react";
import { OverlayCard, OverlayPoll } from "../src/index.js";

export function Content({ source }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setT((n) => n + 1), 1500);
    return () => clearInterval(i);
  }, []);
  if (source === "poll") {
    const counts = [61 + t * 2, 27 + t, 12 + Math.floor(t / 2)];
    return (
      <OverlayPoll
        streamer="Sunny"
        title="Which game deserves a second chance?"
        options={["Mass Effect: Andromeda", "No Man's Sky", "Cyberpunk 2077"]}
        counts={counts}
        countdown="1 min left"
      />
    );
  }
  if (source === "topic")
    return <OverlayCard kind="topic" title="Can AI run my homelab?" author="TechNomad" authorPreset={0} likes={142} />;
  if (source === "next")
    return <OverlayCard kind="next" title="Building a quiet streaming PC" when="Fri 8:00 PM" startsIn="in 45 min" />;
  if (source === "message") return <OverlayCard kind="message" messageStyle="hype" title="Raid incoming. Say hi!" />;
  if (source === "support")
    return (
      <OverlayCard
        kind="support"
        title={
          <>
            Support the stream: <span style={{ color: "var(--gold)" }}>ko-fi.com/sunny</span>
          </>
        }
      />
    );
  return null;
}
