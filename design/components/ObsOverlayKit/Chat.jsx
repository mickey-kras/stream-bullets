import { useEffect, useState } from "react";
import { ChatLayer } from "../src/index.js";

// SAMPLE_CHAT of app/lib/chat-feed.ts: the sample messages of the Overlay control preview.
const POOL = [
  {
    platform: "twitch",
    name: "RustBucket",
    badges: ["Subscriber"],
    text: "Wasteland radio is live. Grab a seat by the fire!",
  },
  { platform: "youtube", name: "Ngozi Okafor", text: "Greetings from Lagos 👋🏾 the dust storm look is wild" },
  { platform: "kick", name: "Zoë_Ünter", text: "Wer hat noch Wasser übrig? 💧" },
  { platform: "twitch", name: "scav_kid", text: "that boss had no chance Kappa GG" },
  { platform: "youtube", name: "ليلى", text: "مرحبا من القاهرة! البث رائع" },
  { platform: "twitch", name: "山田太郎", text: "こんにちは！ 👩‍🚀🚀 family run: 👨‍👩‍👧‍👦" },
  {
    platform: "youtube",
    name: "Long Haul Trucker",
    text: "Okay so I have been driving the convoy route for six hours straight, and I still think this is the best stream on the whole frequency.",
  },
  { platform: "kick", name: "Mad Maxine", text: "V8! 🔥🔥🔥" },
];
const MAX_ROWS = 12;

/** The merged chat: a new message each 2.4 s slides in. A moderator removes each ninth message. */
export function Chat({ opacity, test }) {
  const [rows, setRows] = useState(() => POOL.slice(0, 4).map((row, index) => ({ ...row, id: `s${index}` })));
  useEffect(() => {
    let count = 4;
    const timer = setInterval(() => {
      const row =
        count % 9 === 7 ? { platform: "twitch", name: "spam_bot_42", removed: true } : POOL[count % POOL.length];
      setRows((current) => [
        ...current.slice(1 - MAX_ROWS).map((item) => ({ ...item, enter: false })),
        { ...row, id: `m${count}`, enter: true },
      ]);
      count += 1;
    }, 2400);
    return () => clearInterval(timer);
  }, []);
  return <ChatLayer rows={rows} backgroundOpacity={opacity} test={test} />;
}
