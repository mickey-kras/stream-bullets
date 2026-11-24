function PollsView({ toast }) {
  const { PollCard, Button, EmptyState } = window.StreamBulletsDesignSystem_e1d9fa;
  const [vote, setVote] = React.useState(null);
  const [state, setState] = React.useState("live");
  const [react, setReact] = React.useState(0);
  const base = [48, 31, 9];
  const counts = base.map((c, i) => c + (vote === i ? 1 : 0));
  return (
    <main className="page-panel polls">
      <div className="page-title"><div><h1>Polls</h1><p className="muted">Vote on what happens next on stream.</p></div><Button variant="gold" font="display" icon="plus">New poll</Button></div>
      <PollCard title="Should we explore more local AI on stream?" author="Sunny" authorPreset={14} options={["Yes, more local AI", "A mix of both", "Stick to cloud tools"]}
        counts={counts} myVote={vote} onVote={(i) => { setVote(i); toast("Your vote is in."); }} state={state} countdown={state === "live" ? "2 min left" : undefined}
        owner onReveal={() => setState("revealed")} likes={1 + (react === 1 ? 1 : 0)} dislikes={react === -1 ? 1 : 0} reaction={react} onReact={setReact} comments={1} onDiscuss={() => toast("Discussion opened.")} />
      <PollCard title="Retro night: which era?" author="PixelLuna" authorPreset={2} kind="binary" options={["8-bit", "16-bit"]} state="closed" counts={[22, 35]} likes={4} comments={3} />
    </main>
  );
}
window.PollsView = PollsView;
