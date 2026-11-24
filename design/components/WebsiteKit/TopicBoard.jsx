import { useState } from "react";
import { Comment, Composer, Discussion, Icon, SearchField, Tabs, TopicDetail, TopicRow } from "../src/index.js";
import { SB_DATA } from "./data.js";

const plural = (count, one, other) => `${count} ${count === 1 ? one : other}`;

// The resizable divider of app/components/streamer/topic-board.tsx: a range input between the list and the detail.
function Splitter({ value, onChange }) {
  return (
    <input
      type="range"
      min={25}
      max={65}
      step="any"
      value={value}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
      onDoubleClick={() => onChange(40)}
      id="splitter"
      aria-label="Resize the list"
      aria-controls="topics detail"
    />
  );
}

// "Open discussion" on phones gives the discussion the full screen. The kit moves focus to the comment field.
export function focusComposer(id) {
  const field = document.getElementById(`discussion-${id}`)?.closest(".discussion")?.querySelector("[data-composer]");
  field?.focus();
}

// The Topics view of a streamer page: app/components/streamer/topic-board.tsx with the topic and its discussion
// (entry-detail.tsx, discussion.tsx) in the detail panel.
export function TopicBoard({ name, viewerPreset, toast, onSuggest }) {
  const [topics, setTopics] = useState(SB_DATA.topics);
  const [selectedId, setSelectedId] = useState(topics[0].id);
  // On phones the list and the detail take turns: the detail shows after a row is opened.
  const [opened, setOpened] = useState(false);
  const [sort, setSort] = useState("top");
  const [query, setQuery] = useState("");
  const [split, setSplit] = useState(40);
  const [reactions, setReactions] = useState({});
  const [reported, setReported] = useState({});

  let list = topics.filter((topic) => topic.title.toLowerCase().includes(query.toLowerCase()));
  if (sort === "newest") list = list.toReversed();
  const selected = topics.find((topic) => topic.id === selectedId) ?? topics[0];
  const reaction = reactions[selected.id] ?? 0;
  const score = (topic) => ({
    likes: topic.likes + (reactions[topic.id] === 1 ? 1 : 0),
    dislikes: topic.dislikes + (reactions[topic.id] === -1 ? 1 : 0),
  });
  const post = (text) => {
    if (!text) return;
    const comment = { id: `c${Date.now()}`, name: SB_DATA.viewer.name, preset: viewerPreset, time: "Just now", text };
    setTopics(
      topics.map((topic) => (topic.id === selected.id ? { ...topic, comments: [comment, ...topic.comments] } : topic)),
    );
    toast("Comment posted.");
  };

  return (
    <main
      id="main-content"
      className={`topic-workspace${opened ? " has-selection" : ""}`}
      style={{ "--split": `${split}%` }}
    >
      <section className="browse" aria-label="Browse topics">
        <div className="intro">
          <h1>
            <span className="sr-only">{name}: </span>
            Pick the next conversation
          </h1>
          <p>{name} · Suggest topics. Vote. Chat.</p>
        </div>
        <SearchField variant="topics" id="topic-search" onSearch={setQuery} />
        <div className="list-toolbar">
          <Tabs
            label="Topic sorting"
            value={sort}
            onValueChange={setSort}
            items={[
              { value: "top", label: "Top" },
              { value: "newest", label: "New" },
            ]}
          />
          <span className="list-count">{plural(list.length, "topic", "topics")}</span>
          <button
            type="button"
            id="suggest"
            className="suggest-topic gold"
            aria-label="Suggest a topic"
            title="Suggest a topic"
            onClick={onSuggest}
          >
            <Icon name="plus" size={18} />
            <span>Suggest a topic</span>
          </button>
        </div>
        <div className="topic-scroll-root">
          <section id="topics" aria-label="Topics" data-radix-scroll-area-viewport="" style={{ overflowY: "auto" }}>
            {/* The content box that the Radix scroll viewport puts around the rows. */}
            <div style={{ minWidth: "100%", display: "table" }}>
              {list.map((topic) => (
                <TopicRow
                  key={topic.id}
                  id={topic.id}
                  title={topic.title}
                  category={topic.category}
                  {...score(topic)}
                  comments={topic.comments.length}
                  selected={topic.id === selected.id}
                  onClick={() => {
                    setSelectedId(topic.id);
                    setOpened(true);
                  }}
                />
              ))}
            </div>
          </section>
        </div>
      </section>
      <Splitter value={split} onChange={(next) => setSplit(Math.max(25, Math.min(65, next)))} />
      <div className="detail-scroll-root">
        <TopicDetail
          key={selected.id}
          category={selected.category}
          title={selected.title}
          author={selected.author}
          authorPreset={selected.authorPreset}
          description={selected.description ?? selected.body}
          {...score(selected)}
          reaction={reaction}
          onReact={(value) => setReactions({ ...reactions, [selected.id]: value })}
          backLabel="All topics"
          onBack={() => setOpened(false)}
          onDiscuss={() => focusComposer(selected.id)}
          reported={Boolean(reported[selected.id])}
          onReport={() => {
            setReported({ ...reported, [selected.id]: true });
            toast("Report sent");
          }}
        >
          <Discussion id={selected.id} onRefresh={() => toast("Comments are up to date.")}>
            <Composer viewerPreset={viewerPreset} onPost={post} />
            {selected.comments.map((comment) => (
              <Comment key={comment.id} id={comment.id} name={comment.name} preset={comment.preset} time={comment.time}>
                {comment.text}
              </Comment>
            ))}
          </Discussion>
        </TopicDetail>
      </div>
    </main>
  );
}
