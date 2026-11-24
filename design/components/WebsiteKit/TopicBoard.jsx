function TopicBoard({ toast }) {
  const NS = window.StreamBulletsDesignSystem_e1d9fa;
  const { SearchField, Tabs, TopicRow, TopicDetail, Discussion, Comment, Composer } = NS;
  const D = window.SB_DATA;
  const [sel, setSel] = React.useState(1);
  const [sort, setSort] = React.useState("top");
  const [q, setQ] = React.useState("");
  const [votes, setVotes] = React.useState({});
  const [comments, setComments] = React.useState(D.comments);
  const [draft, setDraft] = React.useState("");
  let topics = D.topics.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()));
  if (sort === "new") topics = [...topics].reverse();
  const t = D.topics.find((x) => x.id === sel);
  const r = votes[sel] || 0;
  return (
    <main className="board">
      <section className="browse">
        <div className="intro"><h1>Pick the next conversation</h1><p>Sunny · Suggest topics. Vote. Chat.</p></div>
        <SearchField value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="list-toolbar"><Tabs label="Topic sorting" value={sort} onValueChange={setSort} items={[{ value: "top", label: "Top" }, { value: "new", label: "New" }]} /><span className="count">{topics.length} topics</span></div>
        <div className="topics">{topics.map((x) => <TopicRow key={x.id} title={x.title} icon={x.icon} likes={x.likes + (votes[x.id] === 1 ? 1 : 0)} dislikes={x.dislikes + (votes[x.id] === -1 ? 1 : 0)} comments={x.comments} selected={x.id === sel} onClick={() => setSel(x.id)} />)}</div>
      </section>
      <TopicDetail category={t.cat} categoryIcon={t.icon} number={"Topic 00" + t.id} title={t.title} author={t.author} authorPreset={t.authorPreset} description={t.body}
        likes={t.likes + (r === 1 ? 1 : 0)} dislikes={t.dislikes + (r === -1 ? 1 : 0)} reaction={r} onReact={(v) => setVotes({ ...votes, [sel]: v })}>
        <Discussion count={t.comments + comments.length - 2}>
          {comments.map((c, i) => <Comment key={i} name={c.name} role={c.role} preset={c.preset} likes={c.likes} time={c.time}>{c.text}</Comment>)}
          <Composer value={draft} onChange={(e) => setDraft(e.target.value)} onPost={() => { if (!draft.trim()) return; setComments([...comments, { name: "You", preset: 1, likes: 0, text: draft, time: "Just now" }]); setDraft(""); toast("Comment posted."); }} />
        </Discussion>
      </TopicDetail>
    </main>
  );
}
window.TopicBoard = TopicBoard;
