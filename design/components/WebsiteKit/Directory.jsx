import { useState } from "react";
import { Avatar, LivePill, SearchField, SiteHeader } from "../src/index.js";
import { SB_DATA } from "./data.js";

export function Directory() {
  const [q, setQ] = useState("");
  const list = SB_DATA.streamers.filter((s) => (s.name + s.handle).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <SiteHeader
        current="streamers"
        homeHref="#landing"
        links={[
          { id: "streamers", label: "Streamers", icon: "streamers", href: "#streamers" },
          { id: "your-page", label: "Your page", icon: "your-page", href: "#topics" },
        ]}
      />
      <main className="page-panel">
        <h1>Streamers</h1>
        <p className="muted">Find a community. Suggest topics. Vote.</p>
        <SearchField
          label="Search streamers"
          placeholder="Search by name or @handle…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{}}
        />
        <p className="count">Showing {list.length} pages</p>
        <div className="streamer-grid">
          {list.map((s) => (
            <a key={s.handle} href="#topics" className="streamer-card">
              <Avatar preset={s.preset} size={60} />
              <div>
                <h2>
                  {s.name}
                  {s.live && <LivePill />}
                  {s.official && <span className="official">Official</span>}
                </h2>
                <p className="handle">@{s.handle}</p>
                <p className="bio">{s.bio}</p>
              </div>
            </a>
          ))}
        </div>
      </main>
    </>
  );
}
