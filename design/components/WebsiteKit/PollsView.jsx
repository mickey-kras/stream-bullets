import { useState } from "react";
import { Comment, Composer, Discussion, Icon, IconButton, PollCard, PollDiscussion, Tabs } from "../src/index.js";
import { SB_DATA } from "./data.js";
import { focusComposer } from "./TopicBoard.jsx";

// The Polls view of a streamer page: app/components/streamer/polls-view.tsx in the page panel of
// app/routes/streamer.tsx. "Discuss" opens one poll with its discussion, as ?entry= does in the app.
export function PollsView({ name, viewerPreset, toast, onCreate }) {
  const [polls, setPolls] = useState(SB_DATA.polls);
  const [openId, setOpenId] = useState(null);
  const [sort, setSort] = useState("newest");
  const [votes, setVotes] = useState({});
  const [spins, setSpins] = useState(0);
  const [reported, setReported] = useState({});
  const selected = polls.find((poll) => poll.id === openId) ?? null;
  const list = sort === "top" ? polls.toSorted((a, b) => total(b) - total(a)) : polls;
  const counts = (poll) => poll.counts.map((count, index) => count + (votes[poll.id] === index ? 1 : 0));
  const post = (text) => {
    if (!text) return;
    const comment = { id: `pc${Date.now()}`, name: SB_DATA.viewer.name, preset: viewerPreset, time: "Just now", text };
    setPolls(polls.map((poll) => (poll.id === openId ? { ...poll, comments: [comment, ...poll.comments] } : poll)));
    toast("Comment posted.");
  };
  return (
    <main className="page-panel polls-page" id="main-content">
      <div className="page-column">
        <div className="page-title">
          <div>
            <span className="eyebrow">Your voice, on air</span>
            <h1>
              <span className="sr-only">{name}: </span>
              Polls
            </h1>
            <p>One question. Everyone has a say.</p>
          </div>
          <button className="gold" type="button" onClick={onCreate}>
            <Icon name="plus" size={18} />
            Create poll
          </button>
        </div>
        <div className="connection-status">
          <output>
            <Icon name="wifi" size={16} />
            Live updates connected
          </output>
          <IconButton label="Refresh polls" icon="refresh" spin={spins} onClick={() => setSpins(spins + 1)} />
        </div>
        <div className={`poll-toolbar${selected ? " is-single" : ""}`}>
          {selected ? (
            <button type="button" className="back" onClick={() => setOpenId(null)}>
              <Icon name="chevron-left" size={16} />
              All polls
            </button>
          ) : (
            <Tabs
              label="Poll sorting"
              value={sort}
              onValueChange={setSort}
              items={[
                { value: "newest", label: "Newest" },
                { value: "top", label: "Top" },
              ]}
            />
          )}
        </div>
        {(selected ? [selected] : list).map((poll) => (
          <PollCard
            key={poll.id}
            id={poll.id}
            title={poll.title}
            author={poll.author}
            authorPreset={poll.authorPreset}
            kind={poll.kind}
            options={poll.options}
            counts={counts(poll)}
            myVote={votes[poll.id] ?? null}
            onVote={(index) => {
              setVotes({ ...votes, [poll.id]: index });
              toast("Your vote is in.");
            }}
            state={poll.state}
            countdown={poll.countdown}
            comments={poll.comments.length}
            onDiscuss={() => setOpenId(poll.id)}
            href="#polls"
          />
        ))}
        {selected && (
          <PollDiscussion
            title={selected.title}
            reported={Boolean(reported[selected.id])}
            onReport={() => {
              setReported({ ...reported, [selected.id]: true });
              toast("Report sent");
            }}
            onDiscuss={() => focusComposer(selected.id)}
          >
            <Discussion id={selected.id} onRefresh={() => toast("Comments are up to date.")}>
              <Composer viewerPreset={viewerPreset} onPost={post} />
              {selected.comments.map((comment) => (
                <Comment
                  key={comment.id}
                  id={comment.id}
                  name={comment.name}
                  preset={comment.preset}
                  time={comment.time}
                >
                  {comment.text}
                </Comment>
              ))}
            </Discussion>
          </PollDiscussion>
        )}
      </div>
    </main>
  );
}

function total(poll) {
  return poll.counts.reduce((sum, count) => sum + count, 0);
}
