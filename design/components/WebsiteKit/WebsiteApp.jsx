import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  accountMenuItems,
  Dialog,
  EmptyState,
  Icon,
  RequiredNote,
  Req,
  Select,
  SiteFooter,
  SiteHeader,
  StreamerHeader,
  TextField,
  Toast,
} from "../src/index.js";
import { SB_DATA } from "./data.js";
import { Directory } from "./Directory.jsx";
import { Landing } from "./Landing.jsx";
import { PollsView } from "./PollsView.jsx";
import { TopicBoard } from "./TopicBoard.jsx";

const STREAMER_VIEWS = ["topics", "polls", "schedule", "about", "community"];
const CATEGORIES = [
  { value: "Just chatting", label: "Just chatting", icon: "cat-chatting" },
  { value: "Tech & setups", label: "Tech & setups", icon: "cat-tech" },
  { value: "Gaming", label: "Gaming", icon: "cat-gaming" },
  { value: "Creative", label: "Creative", icon: "cat-creative" },
];

// The kit uses hash links, so the back button of the browser works. App paths become kit screens.
function kitHref(path) {
  if (path === "/") return "#landing";
  if (path === "/streamers") return "#streamers";
  if (path.startsWith("?dialog=")) return `#${path.slice(8)}`;
  if (path.startsWith("/@")) return "#topics";
  return `#${path.replace(/^\//u, "")}`;
}
const streamerHref = (view) => {
  if (view === "home") return "#landing";
  if (view === "page") return "#topics";
  return `#${view}`;
};
const FOOTER_PATHS = {
  streamers: "#streamers",
  privacy: "#privacy",
  terms: "#terms",
  reporting: "#reporting",
  a11y: "#a11y",
  ideas: "#topics",
  ai: "#ai",
  language: "#language",
};
const MENU = accountMenuItems({ streamerHeader: true }).map((row) =>
  row === "divider" ? row : { ...row, href: kitHref(row.href) },
);

function go(screen) {
  window.location.hash = screen;
}

function readScreen() {
  return window.location.hash.slice(1) || "topics";
}

// A screen that the product has and the kit does not copy.
function NotInKit({ screen }) {
  return (
    <main className="page-panel" id="main-content">
      <div className="page-column">
        <EmptyState icon="search-none" title="Not in this kit">
          {`The ${screen} screen is part of the product. This kit does not copy it.`}
        </EmptyState>
      </div>
    </main>
  );
}

// The "Suggest a topic" dialog of app/components/create-entry.tsx. The submit button is in the dialog actions,
// so it names the form with the form attribute.
function SuggestDialog({ open, onOpenChange, onCreate }) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Suggest a topic"
      description="What would make a great conversation?"
      actions={
        <button className="gold" type="submit" form="create-entry">
          Submit topic
        </button>
      }
    >
      <form
        id="create-entry"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate();
        }}
      >
        <RequiredNote />
        <TextField label="Title" name="title" required maxLength={100} />
        <TextField label="Details" name="body" required multiline rows={5} maxLength={2000} />
        <div className="field">
          <span className="field-label" id="topic-category-label">
            Category
            <Req />
          </span>
          <Select
            id="topic-category"
            name="category"
            labelledBy="topic-category-label"
            defaultValue="Just chatting"
            options={CATEGORIES}
          />
        </div>
      </form>
    </Dialog>
  );
}

export function WebsiteApp() {
  const [screen, setScreen] = useState(readScreen);
  const [toast, setToast] = useState(null);
  const [dialog, setDialog] = useState(null);
  const { streamer, viewer } = SB_DATA;
  useEffect(() => {
    const sync = () => {
      setScreen(readScreen());
      document.getElementById("main-content")?.scrollTo?.(0, 0);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const say = (message) => setToast({ message, key: Date.now() });
  const createPoll = () => say("The poll dialog is not part of this kit.");
  const account = {
    name: viewer.name,
    items: MENU,
    onSelect: (id) => {
      if (id === "sign-out") go("landing");
    },
  };

  let page;
  if (screen === "landing") page = <Landing onSignIn={() => go("streamers")} />;
  else if (screen === "streamers")
    page = (
      <>
        <SiteHeader
          current="streamers"
          homeHref="#landing"
          links={[{ id: "streamers", label: "Streamers", icon: "streamers", href: "#streamers" }]}
          avatarPreset={viewer.preset}
          account={account}
        />
        <Directory />
      </>
    );
  else if (!STREAMER_VIEWS.includes(screen))
    page = (
      <>
        <SiteHeader
          current={screen}
          homeHref="#landing"
          links={[{ id: "streamers", label: "Streamers", icon: "streamers", href: "#streamers" }]}
          avatarPreset={viewer.preset}
          account={account}
        />
        <NotInKit screen={screen} />
      </>
    );
  else {
    let view = <NotInKit screen={screen} />;
    if (screen === "topics")
      view = (
        <TopicBoard
          name={streamer.name}
          viewerPreset={viewer.preset}
          toast={say}
          onSuggest={() => setDialog("topic")}
        />
      );
    if (screen === "polls")
      view = <PollsView name={streamer.name} viewerPreset={viewer.preset} toast={say} onCreate={createPoll} />;
    page = (
      <div className="streamer-shell">
        <StreamerHeader
          name={streamer.name}
          handle={streamer.handle}
          preset={streamer.preset}
          current={screen}
          hrefFor={streamerHref}
          avatarPreset={viewer.preset}
          account={account}
        />
        {view}
        {/* Phones: the floating action of the Polls view (floatingAction() in app/routes/streamer.tsx). */}
        {screen === "polls" && (
          <button type="button" className="fab gold" onClick={createPoll}>
            <Icon name="plus" size={20} />
            Create poll
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      {page}
      {createPortal(
        <SiteFooter current={screen} paths={FOOTER_PATHS} onContact={() => go("contact")} />,
        document.body,
      )}
      <SuggestDialog
        open={dialog === "topic"}
        onOpenChange={(open) => setDialog(open ? "topic" : null)}
        onCreate={() => {
          setDialog(null);
          say("Topic submitted.");
        }}
      />
      {toast && (
        <Toast
          key={toast.key}
          floating
          message={toast.message}
          onOpenChange={(open) => {
            if (!open) setToast(null);
          }}
        />
      )}
    </>
  );
}
