import { useState } from "react";
import { OverlayComposition, OverlayLayer } from "../src/index.js";
import { Chat } from "./Chat.jsx";
import { Content } from "./Content.jsx";
import { Stage } from "./Stage.jsx";

const CELL = 120;
const FRAME = { w: 1920, h: 1080 };
const SOURCES = [
  ["poll", "Poll"],
  ["mash", "Mash Battle"],
  ["topic", "Topic"],
  ["next", "Up next"],
  ["message", "Message banner"],
  ["card", "Community card"],
  ["support", "Support banner"],
  ["hidden", "Nothing"],
];
const BACKGROUNDS = [
  ["checker", "Transparent"],
  ["game", "Sample game"],
];
// The cells of the layers, in columns and rows of the 16 × 9 grid.
const CHAT_CELL = { c: 0, r: 2, w: 4, h: 7 };
const POLL_CELL = { c: 5, r: 0, w: 11, h: 6 };
const CARD_CELL = { c: 5, r: 6, w: 11, h: 3 };

const pixels = (cell) => ({ x: cell.c * CELL, y: cell.r * CELL, w: cell.w * CELL, h: cell.h * CELL });

/** One row of toggle buttons, as the Overlay control bar draws them. */
function Segments({ legend, items, value, onValue }) {
  return (
    <fieldset className="ov-seg-field">
      <legend className="sr-only">{legend}</legend>
      <div className="seg">
        {items.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={value === key} onClick={() => onValue(key)}>
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * A short copy of the Overlay control preview: pick the content on air, the preview background, the chat layer and
 * its message background. The stage renders the same layer markup as the OBS page.
 */
export function OverlayApp() {
  const [source, setSource] = useState("poll");
  const [background, setBackground] = useState("checker");
  const [chat, setChat] = useState("on");
  const [test, setTest] = useState("off");
  const [opacity, setOpacity] = useState(100);
  const [qr, setQr] = useState("on");
  const big = source === "poll" || source === "mash";
  const layer = source === "mash" ? "poll" : source;
  return (
    <div className="ov-kit">
      <div className="ov-comp-bar">
        <Segments legend="On air" items={SOURCES} value={source} onValue={setSource} />
        <Segments legend="Preview background" items={BACKGROUNDS} value={background} onValue={setBackground} />
      </div>
      <div className="ov-comp-bar">
        <Segments
          legend="Chat"
          items={[
            ["on", "Chat on"],
            ["off", "Chat off"],
          ]}
          value={chat}
          onValue={setChat}
        />
        <Segments
          legend="Chat test"
          items={[
            ["off", "No test"],
            ["on", "Chat test"],
          ]}
          value={test}
          onValue={setTest}
        />
        <Segments
          legend="QR code"
          items={[
            ["on", "QR code"],
            ["off", "No QR code"],
          ]}
          value={qr}
          onValue={setQr}
        />
        <div className="ov-comp-range">
          <label htmlFor="ov-kit-background">Message background</label>
          <input
            id="ov-kit-background"
            type="range"
            min="0"
            max="100"
            step="5"
            value={opacity}
            aria-valuetext={`${opacity}%`}
            onChange={(event) => setOpacity(event.currentTarget.valueAsNumber)}
          />
          <span className="ov-comp-range-value" aria-hidden="true">
            {opacity}%
          </span>
        </div>
      </div>
      <Stage background={background}>
        <OverlayComposition>
          {source !== "hidden" && (
            <OverlayLayer layer={layer} type={layer} rect={pixels(big ? POLL_CELL : CARD_CELL)} frame={FRAME}>
              <Content source={source} qr={qr === "on"} />
            </OverlayLayer>
          )}
          {chat === "on" && (
            <OverlayLayer layer="chat" rect={pixels(CHAT_CELL)} frame={FRAME}>
              <Chat opacity={opacity} test={test === "on"} />
            </OverlayLayer>
          )}
        </OverlayComposition>
      </Stage>
    </div>
  );
}
