import { useEffect, useRef, useState } from "react";
import {
  AccountMenu,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  Select,
  SiteFooter,
  StreamerHeader,
  TextField,
  Toast,
} from "../src/index.js";
import { Landing } from "./Landing.jsx";
import { Directory } from "./Directory.jsx";
import { TopicBoard } from "./TopicBoard.jsx";
import { PollsView } from "./PollsView.jsx";

export function WebsiteApp() {
  const [screen, setScreen] = useState(
    () => window.location.hash.slice(1) || localStorage.getItem("sb-kit-screen") || "topics",
  );
  const [msg, setMsg] = useState(null);
  const [suggest, setSuggest] = useState(false);
  const [menu, setMenu] = useState(false);
  const timer = useRef(undefined);
  // The links of the kit are hash links, so the browser history works.
  useEffect(() => {
    const sync = () => {
      const next = window.location.hash.slice(1) || "topics";
      setScreen(next);
      localStorage.setItem("sb-kit-screen", next);
      setMenu(false);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const go = (s) => {
    window.location.hash = s;
  };
  const toast = (m) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 3200);
  };
  if (screen === "landing") return <Landing go={go} />;
  return (
    <div className="shell sb-grain">
      {screen === "streamers" ? (
        <Directory />
      ) : (
        <>
          <StreamerHeader
            name="Sunny"
            preset={14}
            current={screen}
            live
            ticker="Live now · Can AI run my homelab?"
            own
            onAccount={() => setMenu(!menu)}
            hrefFor={(v) => `#${v === "home" ? "landing" : v === "overlay" ? "topics" : v}`}
            action={<IconButton label="Suggest a topic" icon="plus" onClick={() => setSuggest(true)} />}
          />
          {menu && (
            <div className="menu-pop">
              <AccountMenu
                name="Sunny"
                subtitle="Streamer · @sunny"
                preset={14}
                current="your-page"
                onSelect={(id) => {
                  setMenu(false);
                  if (id === "sign-out") go("landing");
                }}
              />
            </div>
          )}
          {screen === "topics" && <TopicBoard toast={toast} />}
          {screen === "polls" && <PollsView toast={toast} />}
          {!["topics", "polls"].includes(screen) && (
            <main className="page-panel">
              <EmptyState icon={screen} title="Not in this kit">
                This view exists in the product but is not recreated here.
              </EmptyState>
            </main>
          )}
        </>
      )}
      <SiteFooter />
      <Dialog
        open={suggest}
        onOpenChange={setSuggest}
        title="Suggest a topic"
        description="What would make a great conversation?"
        actions={
          <Button
            variant="gold"
            font="display"
            onClick={() => {
              setSuggest(false);
              toast("Topic submitted.");
            }}
          >
            Submit topic
          </Button>
        }
      >
        <TextField label="Title" required placeholder="Can AI run my homelab?" />
        <div className="sb-field">
          <span className="sb-field-label">Category</span>
          <div style={{ marginTop: 8 }}>
            <Select
              label="Category"
              placeholder="Choose a category"
              options={[
                { value: "tech", label: "Tech & setups", icon: "cat-tech" },
                { value: "gaming", label: "Gaming", icon: "cat-gaming" },
                { value: "creative", label: "Creative", icon: "cat-creative" },
                { value: "chat", label: "Just chatting", icon: "cat-chatting" },
              ]}
            />
          </div>
        </div>
        <TextField label="Details" multiline rows={3} />
      </Dialog>
      {msg && <Toast floating message={msg} />}
    </div>
  );
}
