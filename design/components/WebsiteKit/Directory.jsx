import { useState } from "react";
import { Avatar, Icon, SearchField } from "../src/index.js";
import { SB_DATA } from "./data.js";

const showing = (count) => `Showing ${count} ${count === 1 ? "page" : "pages"}`;

// The streamer directory: the main panel of app/routes/streamers.tsx. The kit puts SiteHeader above it.
export function Directory() {
  const [text, setText] = useState("");
  const query = text.trim().replace(/^@/u, "").toLowerCase();
  const list = SB_DATA.streamers.filter((s) => `${s.name} ${s.handle}`.toLowerCase().includes(query));
  return (
    <main className="page-panel streamers-page" id="main-content">
      <div className="page-title">
        <div>
          <span className="eyebrow">Public pages</span>
          <h1>Streamers</h1>
          <p>Find a community. Suggest topics. Vote.</p>
        </div>
      </div>
      {!query && (
        <section className="ideas-strip" aria-labelledby="ideas-strip-title">
          <h2 id="ideas-strip-title">
            <a className="text-link ideas-link" href="#topics">
              <Icon name="idea" size={16} />
              Ideas
            </a>
          </h2>
          <p className="muted">{SB_DATA.official.bio}</p>
        </section>
      )}
      <SearchField
        variant="streamers"
        id="streamer-search"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onSearch={setText}
      />
      <div className="list-toolbar">
        <span className="list-count">{list.length > 0 ? showing(list.length) : ""}</span>
        {list.length === 0 && (
          <a className="text-link" href="#streamers" onClick={() => setText("")}>
            Clear search
          </a>
        )}
      </div>
      <div>
        {list.length > 0 ? (
          <div className="streamer-grid">
            {list.map((streamer) => (
              <a key={streamer.handle} className="info-card streamer-card" href="#topics">
                <Avatar preset={streamer.preset} />
                <div>
                  <h2>{streamer.name}</h2>
                  <p className="muted">@{streamer.handle}</p>
                  <p className="streamer-bio">{streamer.bio || "This streamer has not added an introduction yet."}</p>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <p className="empty">
            <Icon name="search-none" size={20} />
            {`No streamers match “${text.trim()}”.`}
          </p>
        )}
      </div>
    </main>
  );
}
