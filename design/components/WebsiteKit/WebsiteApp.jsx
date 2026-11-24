function WebsiteApp() {
  const NS = window.StreamBulletsDesignSystem_e1d9fa;
  const { StreamerHeader, SiteFooter, Toast, Dialog, Button, IconButton, TextField, Select, AccountMenu, EmptyState } = NS;
  const saved = localStorage.getItem("sb-kit-screen") || "topics";
  const [screen, setScreen] = React.useState(saved);
  const [msg, setMsg] = React.useState(null);
  const [suggest, setSuggest] = React.useState(false);
  const [menu, setMenu] = React.useState(false);
  const go = (s) => { setScreen(s); localStorage.setItem("sb-kit-screen", s); setMenu(false); };
  const toast = (m) => { setMsg(m); clearTimeout(window.__t); window.__t = setTimeout(() => setMsg(null), 3200); };
  const streamerScreens = ["topics", "polls", "schedule", "about", "community"];
  if (screen === "landing") return <Landing go={go} />;
  return (
    <div className="shell sb-grain">
      {screen === "streamers" ? <Directory go={go} /> : (
        <>
          <StreamerHeader name="Sunny" preset={14} current={screen} live ticker="Live now · Can AI run my homelab?" own onAccount={() => setMenu(!menu)}
            onNavigate={(v) => go(v === "home" ? "landing" : v === "overlay" ? "topics" : v)} action={<IconButton label="Suggest a topic" icon="plus" onClick={() => setSuggest(true)} />} />
          {menu && <div className="menu-pop"><AccountMenu name="Sunny" role="Streamer · @sunny" preset={14} current="your-page" onSelect={(id) => { setMenu(false); if (id === "sign-out") go("landing"); }} /></div>}
          {screen === "topics" && <TopicBoard toast={toast} />}
          {screen === "polls" && <PollsView toast={toast} />}
          {!["topics", "polls"].includes(screen) && <main className="page-panel"><EmptyState icon={screen} title="Not in this kit">This view exists in the product but is not recreated here.</EmptyState></main>}
        </>
      )}
      <SiteFooter />
      <Dialog open={suggest} onOpenChange={setSuggest} title="Suggest a topic" description="What would make a great conversation?"
        actions={<Button variant="gold" font="display" onClick={() => { setSuggest(false); toast("Topic submitted."); }}>Submit topic</Button>}>
        <TextField label="Title" required placeholder="Can AI run my homelab?" />
        <label className="sb-field"><span className="sb-field-label">Category</span><div style={{ marginTop: 8 }}><Select placeholder="Choose a category" options={[{ value: "tech", label: "Tech & setups", icon: "cat-tech" }, { value: "gaming", label: "Gaming", icon: "cat-gaming" }, { value: "creative", label: "Creative", icon: "cat-creative" }, { value: "chat", label: "Just chatting", icon: "cat-chatting" }]} /></div></label>
        <TextField label="Details" multiline rows={3} />
      </Dialog>
      {msg && <Toast floating message={msg} />}
    </div>
  );
}
window.WebsiteApp = WebsiteApp;
if (window.__SB_KIT === "website") ReactDOM.createRoot(document.getElementById("root")).render(<WebsiteApp />);
