import { useEffect, useState } from "react";
import { ChatLayer } from "../src/index.js";

const POOL = [
  { platform: "twitch", name: "PixelLuna", badges: ["SUB"], text: "that build is so clean" },
  { platform: "kick", name: "grizzly_gg", text: "how loud are the fans at full load?" },
  {
    platform: "youtube",
    name: "TechNomad",
    badges: ["MOD"],
    text: "ran a 7B model on a mini PC last week, fine for small tasks",
  },
  { platform: "twitch", name: "orbit", text: "voting Mass Effect, it got good later" },
  { platform: "youtube", name: "Мария", text: "Привет из Киева! 👋" },
  { platform: "kick", name: "a_very_long_username_indeed", text: "first time here, love the station look" },
  { platform: "twitch", name: "ねこ", text: "こんばんは！" },
  { platform: "youtube", name: "Hannah", text: "No Man's Sky deserves it" },
];
export function Chat({ opacity }) {
  const [rows, setRows] = useState(() => POOL.slice(0, 4).map((r, i) => ({ ...r, id: "s" + i })));
  useEffect(() => {
    let n = 4;
    const i = setInterval(() => {
      const base = POOL[n % POOL.length];
      const row = n % 9 === 7 ? { platform: "twitch", name: "spam_bot_42", removed: true } : base;
      setRows((rs) => [...rs.slice(-11).map((r) => ({ ...r, enter: false })), { ...row, id: "m" + n, enter: true }]);
      n++;
    }, 2400);
    return () => clearInterval(i);
  }, []);
  return <ChatLayer rows={rows} backgroundOpacity={opacity} />;
}
