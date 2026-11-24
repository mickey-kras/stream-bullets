function Directory({ go }) {
  const { SiteHeader, SearchField, Avatar, LivePill } = window.StreamBulletsDesignSystem_e1d9fa;
  const [q, setQ] = React.useState("");
  const list = window.SB_DATA.streamers.filter((s) => (s.name + s.handle).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <SiteHeader current="streamers" onNavigate={(id) => go(id === "home" ? "landing" : "streamers")} links={[{ id: "streamers", label: "Streamers", icon: "streamers" }, { id: "your-page", label: "Your page", icon: "your-page" }]} />
      <main className="page-panel">
        <h1>Streamers</h1>
        <p className="muted">Find a community. Suggest topics. Vote.</p>
        <SearchField label="Search streamers" placeholder="Search by name or @handle…" value={q} onChange={(e) => setQ(e.target.value)} style={{}} />
        <p className="count">Showing {list.length} pages</p>
        <div className="streamer-grid">
          {list.map((s) => (
            <a key={s.handle} href="#" className="streamer-card" onClick={(e) => { e.preventDefault(); go("topics"); }}>
              <Avatar preset={s.preset} size={60} />
              <div><h2>{s.name}{s.live && <LivePill />}{s.official && <span className="official">Official</span>}</h2><p className="handle">@{s.handle}</p><p className="bio">{s.bio}</p></div>
            </a>
          ))}
        </div>
      </main>
    </>
  );
}
window.Directory = Directory;
