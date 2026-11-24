function OverlayApp() {
  const { Tabs, Button, Choice } = window.StreamBulletsDesignSystem_e1d9fa;
  const [source, setSource] = React.useState(localStorage.getItem("sb-ov-source") || "poll");
  const [bg, setBg] = React.useState("checker");
  const [chat, setChat] = React.useState(true);
  const [opacity, setOpacity] = React.useState(100);
  const take = (s) => { setSource(s); localStorage.setItem("sb-ov-source", s); };
  const full = source === "poll";
  return (
    <div className="ov-page">
      <Stage background={bg}>
        {chat && <div className="ov-layer" style={{ left: 0, top: 0, width: 600, height: 840 }}><Chat opacity={opacity} /></div>}
        <div className="ov-layer ov-content" data-full={full || undefined} style={chat ? { left: 720, top: 0, width: 1200, height: 1080 } : { left: 0, top: 0, width: 1920, height: 1080 }}>
          <Content source={source} />
        </div>
      </Stage>
      <div className="ov-controls">
        <div><span className="sb-eyebrow">On air</span><Tabs label="On air" value={source} onValueChange={take} items={[{ value: "poll", label: "Poll" }, { value: "topic", label: "Topic" }, { value: "next", label: "Up next" }, { value: "message", label: "Message" }, { value: "support", label: "Support" }, { value: "hidden", label: "Hidden" }]} /></div>
        <div><span className="sb-eyebrow">Preview background</span><Tabs label="Preview background" value={bg} onValueChange={setBg} items={[{ value: "checker", label: "Transparent" }, { value: "game", label: "Sample game" }]} /></div>
        <div className="ov-chat-ctl"><Choice type="checkbox" label="Show chat on stream" checked={chat} onChange={(e) => setChat(e.target.checked)} />
          <label className="ov-range">Message background {opacity}%<input type="range" min="0" max="100" step="5" value={opacity} onChange={(e) => setOpacity(+e.target.value)} /></label></div>
      </div>
    </div>
  );
}
window.OverlayApp = OverlayApp;
if (window.__SB_KIT === "overlay") ReactDOM.createRoot(document.getElementById("root")).render(<OverlayApp />);
