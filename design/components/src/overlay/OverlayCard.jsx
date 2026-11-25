import { memo, useEffect, useRef, useState } from "react";
import { renderSVG } from "uqr";
// Pure modules of the app: the design-pixel scale of a layer and the largest-remainder shares of a poll.
import { useDesignScale } from "../../../../app/components/overlay/use-design-scale.ts";
import { largestRemainder } from "../../../../app/lib/percent.ts";
import { Avatar } from "../core/Avatar.jsx";
import { Icon } from "../core/Icon.jsx";

/** The layers without the fit box and the stage of a content layer. */
const PLAIN_LAYERS = new Set(["chat", "characters", "camera"]);
const number = new Intl.NumberFormat("en");
const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 0 });

function votes(count) {
  return `${number.format(count)} ${count === 1 ? "vote" : "votes"}`;
}

/* ---------- Layers: app/components/overlay/overlay-composition.tsx ---------- */

/** The layers of the overlay, at the size of the positioned parent (the design canvas `.ov-scaler`). */
export function OverlayComposition({ only, children }) {
  return (
    <div className="ov-composition" data-overlay-only={only ?? undefined}>
      {children}
    </div>
  );
}

/** Scales the content of a cell down to fit inside the cell (`--ov-fit`, never above 1). */
function useFitScale(box) {
  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const measure = () => {
      const stage = element.firstElementChild;
      const content = stage?.firstElementChild;
      if (!stage || !content) return;
      const outer = stage.getBoundingClientRect();
      const inner = content.getBoundingClientRect();
      const byWidth = inner.width > 0 ? outer.width / inner.width : 1;
      const byHeight = inner.height > 0 ? outer.height / inner.height : 1;
      element.style.setProperty("--ov-fit", String(Math.min(1, byWidth, byHeight)));
    };
    const sizes = new ResizeObserver(measure);
    const watch = () => {
      sizes.disconnect();
      sizes.observe(element);
      const content = element.firstElementChild?.firstElementChild;
      if (content) sizes.observe(content);
      measure();
    };
    const changes = new MutationObserver(watch);
    changes.observe(element, { childList: true, subtree: true, characterData: true });
    watch();
    return () => {
      sizes.disconnect();
      changes.disconnect();
    };
  }, [box]);
}

const share = (value, total) => `${(value / total) * 100}%`;

/** The content of one layer in its grid cell: centred, at the full cell width. */
export function OverlayStage({ type = "poll", children }) {
  return (
    <div className="ov-stage" data-overlay-type={type}>
      {children}
    </div>
  );
}

function ContentCell({ type, children }) {
  const box = useRef(null);
  useFitScale(box);
  return (
    <div className="ov-fit" ref={box}>
      <OverlayStage type={type}>{children}</OverlayStage>
    </div>
  );
}

/**
 * A layer box at its cell. `rect` is in design pixels (a cell is 60 × 60), `frame` is the design size of the
 * composition. The content is laid out in rect.w × rect.h design pixels and scales to the box width. A content
 * layer (not chat, characters, or camera) wraps its children in the fit box and the stage. `alone` fills the parent, as a
 * per-layer OBS source does.
 */
export function OverlayLayer({
  layer = "poll",
  type,
  rect,
  frame = { w: 1920, h: 1080 },
  alone = false,
  backgroundOpacity,
  children,
}) {
  const box = useRef(null);
  useDesignScale(box, rect.w, alone ? rect.h : undefined);
  const place = alone
    ? { left: 0, top: 0, width: "100%", height: "100%" }
    : {
        left: share(rect.x, frame.w),
        top: share(rect.y, frame.h),
        width: share(rect.w, frame.w),
        height: share(rect.h, frame.h),
      };
  const content = !PLAIN_LAYERS.has(layer);
  const opacity = backgroundOpacity ?? (content ? 100 : undefined);
  const style = opacity === undefined ? place : { ...place, "--ov-bg": String(opacity / 100) };
  return (
    <div className="ov-layer" data-layer={layer} data-alone={alone || undefined} style={style} ref={box}>
      <div className="ov-layer-canvas" style={{ width: rect.w, height: rect.h }}>
        {content ? <ContentCell type={type ?? layer}>{children}</ContentCell> : children}
      </div>
    </div>
  );
}

/* ---------- Camera frame: CameraFrame in app/components/overlay/overlay-composition.tsx ---------- */

/** The camera frame: a frame with a clear window. `hint` is the text in the window of the editor preview. */
export function OverlayCamera({ hint }) {
  const text = hint ? <p className="ov-camera-hint">{hint}</p> : null;
  return <div className="ov-camera">{text}</div>;
}

/* ---------- QR code: app/components/overlay/qr-code.tsx ---------- */

const QR_MIN = 96;

function qrSide(cardWidth, cardHeight) {
  const widest = Math.max(QR_MIN, Math.round(cardWidth * 0.3));
  return Math.min(widest, Math.max(QR_MIN, Math.round(cardHeight * 0.22)));
}

/** The QR code of a card: dark modules on a light plate, sized from its card. */
export const OverlayQr = memo(function OverlayQr({ url, label = "QR code: open on your phone" }) {
  const plate = useRef(null);
  const [side, setSide] = useState(QR_MIN);
  useEffect(() => {
    const card = plate.current?.closest("article");
    if (!card) return undefined;
    let frame = 0;
    const sizes = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setSide(qrSide(card.offsetWidth, card.offsetHeight)));
    });
    sizes.observe(card);
    return () => {
      sizes.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  const svg = renderSVG(url, { border: 2, pixelSize: 1, whiteColor: "#f7edcf", blackColor: "#0b2228" });
  return (
    <img
      className="ov-qr"
      src={`data:image/svg+xml,${encodeURIComponent(svg)}`}
      alt={label}
      style={{ width: side, height: side }}
      ref={plate}
      data-overlay-qr={url}
    />
  );
});

/** With a QR code link, the text keeps the left side and the code sits at the right edge. */
function CardBody({ qr, children }) {
  if (!qr) return children;
  return (
    <div className="ov-qr-row">
      <div className="ov-qr-text">{children}</div>
      <OverlayQr url={qr} />
    </div>
  );
}

/* ---------- Cards: SourceContent of app/components/overlay/overlay-stage.tsx ---------- */

/**
 * The on-air cards of the content layers: topic spotlight, up next, message banner, community card and support
 * banner. `qr` is the link of the QR code, or null for no code (the message banner has none).
 */
export function OverlayCard({
  kind = "topic",
  eyebrow,
  title,
  author,
  authorPreset = 14,
  authorSrc,
  likes = 0,
  when,
  startsIn,
  streamer = "Sunny",
  body,
  cta,
  ctaTarget,
  link,
  messageStyle = "info",
  qr = null,
}) {
  if (kind === "message")
    return (
      <article className={`ov-card ov-message style-${messageStyle}`} data-overlay-source="message">
        <h1>
          <Icon name={messageStyle === "hype" ? "zap" : "megaphone"} size={40} />
          {title || "Your message"}
        </h1>
      </article>
    );
  if (kind === "support")
    return (
      <article className="ov-card ov-support" data-overlay-source="support">
        <CardBody qr={qr}>
          <h1>
            <Icon name="heart" size={40} />
            {title || "Support the stream:"} <span>{link ? link.replace(/^https:\/\//, "") : "add a link"}</span>
          </h1>
        </CardBody>
      </article>
    );
  const card = {
    next: ["schedule", "Up next"],
    card: ["community", `${streamer}’s community`],
    topic: ["topics", "Topic spotlight"],
  };
  const [icon, label] = card[kind] ?? card.topic;
  return (
    <article className="ov-card" data-overlay-source={card[kind] ? kind : "topic"}>
      <CardBody qr={qr}>
        <span className="eyebrow">
          <Icon name={icon} size={16} />
          {eyebrow ?? label}
        </span>
        <h1>{title}</h1>
        {kind === "next" && (
          <p className="ov-meta">
            <Icon name="timer" size={24} />
            {when}
            {startsIn && <span className="ov-pill">{startsIn}</span>}
          </p>
        )}
        {kind === "card" && (
          <>
            <p className="ov-body">{body}</p>
            {cta && (
              <p className="ov-cta">
                {cta}
                {ctaTarget && ` · ${ctaTarget.replace(/^https:\/\//, "")}`}
              </p>
            )}
          </>
        )}
        {!card[kind] || kind === "topic" ? (
          <p className="ov-meta">
            <Avatar url={authorSrc} preset={authorPreset} size={32} />
            <span>
              Suggested by <strong>{author}</strong>
            </span>
            <span className="ov-likes">
              <Icon name="thumbs-up" size={24} />
              {likes}
            </span>
          </p>
        ) : null}
      </CardBody>
    </article>
  );
}

/* ---------- Poll on stream: PollOverlay of overlay-stage.tsx with PollResults and PollStatus of poll.tsx ---------- */

/** Sets the largest font size at which the text of the heading fits its box. */
function useFitText(text) {
  const element = useRef(null);
  useEffect(() => {
    const node = element.current;
    if (!node) return undefined;
    const fit = () => {
      let low = 12;
      let high = Math.max(low, Math.floor(node.clientHeight * 0.6));
      while (low < high) {
        const size = Math.ceil((low + high) / 2);
        node.style.fontSize = `${size}px`;
        if (node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth) low = size;
        else high = size - 1;
      }
      node.style.fontSize = `${low}px`;
    };
    const sizes = new ResizeObserver(fit);
    sizes.observe(node);
    return () => sizes.disconnect();
  }, [text]);
  return element;
}

/** Option names longer than this many characters do not fit a bar that shares its row with two others. */
const SHORT_OPTION = 12;

function optionColumns(options) {
  if (options.every((option) => option.length <= SHORT_OPTION)) return undefined;
  return options.length <= 3 ? 1 : 2;
}

function timeLeft(seconds) {
  if (seconds < 60) return `${seconds} s left`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

function Results({ options, counts, kind }) {
  const shares = largestRemainder(counts ?? []);
  return (
    <div className={kind === "binary" ? "poll-choices binary-votes" : "poll-choices"}>
      {options.map((option, index) => {
        const count = counts?.[index];
        const share = shares[index] ?? 0;
        return (
          <div className="poll-option" key={`${index}:${option}`}>
            <span className="opt-track">
              {count !== undefined && <span className="fill" style={{ width: `${share}%` }} />}
              <span className="opt-label">{option}</span>
            </span>
            {count !== undefined && (
              <span className="option-score">
                <small>{votes(count)}</small>
                <span className="opt-pct">{percent.format(share / 100)}</span>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Status({ kind, revealed, secondsLeft }) {
  let badge = (
    <>
      <span className="live-dot" />
      <span>Voting live</span>
    </>
  );
  if (revealed)
    badge =
      kind === "binary" ? (
        <>
          <Icon name="eye" size={16} />
          <span>Results revealed</span>
        </>
      ) : (
        <>
          <Icon name="lock" size={16} />
          <span>Ended by host</span>
        </>
      );
  else if (secondsLeft === 0)
    badge = (
      <>
        <Icon name="lock" size={16} />
        <span>Voting closed</span>
      </>
    );
  let countdown;
  if (revealed) countdown = "Final";
  else if (secondsLeft === null || secondsLeft === undefined) countdown = "No time limit";
  else if (secondsLeft === 0) countdown = "Time is up";
  else
    countdown = (
      <>
        <Icon name="timer" size={16} />
        {timeLeft(secondsLeft)}
      </>
    );
  return (
    <div className="poll-topline">
      <span className="poll-badge">{badge}</span>
      <span className="poll-countdown">{countdown}</span>
    </div>
  );
}

/**
 * A poll on stream. It fills its cell: the question beside the QR code at the same height, the options across the
 * full width with the live result, and one status line. Put it in an OverlayLayer, which gives it the cell size.
 * `counts` undefined hides the bars (a yes/no poll before the reveal). `secondsLeft` null means no time limit.
 */
export function OverlayPoll({
  id = "poll",
  title,
  options,
  counts,
  total,
  kind = "choice",
  revealed = false,
  secondsLeft = null,
  showResults = true,
  qr = null,
}) {
  const heading = useFitText(title);
  const sum = total ?? (counts ?? []).reduce((a, b) => a + b, 0);
  const hiddenUntilReveal = kind === "binary" && !revealed;
  return (
    <article
      className="poll-card overlay-card ov-poll"
      data-overlay-poll={id}
      data-option-columns={optionColumns(options)}
    >
      <div className="ov-poll-body">
        <div className="ov-poll-head">
          <h1 ref={heading}>{title}</h1>
          {qr && <OverlayQr url={qr} />}
        </div>
        {showResults ? (
          <Results options={options} counts={counts} kind={kind} />
        ) : (
          <p className="ov-hidden-results">Results hidden</p>
        )}
        <div className="ov-poll-foot">
          <Status kind={kind} revealed={revealed} secondsLeft={secondsLeft} />
          <p className="overlay-total">
            {votes(sum)}
            {hiddenUntilReveal && " · Results not yet revealed"}
          </p>
        </div>
      </div>
    </article>
  );
}

/* ---------- Mash Battle on stream: MashOverlay of overlay-stage.tsx with the parts of mash/mash-parts.tsx ---------- */

const MASH_COLORS = ["mash-a", "mash-b", "mash-c", "mash-d"];
const sideStyle = (side) => ({ "--c": `var(--${MASH_COLORS[side] ?? MASH_COLORS[0]})` });

/** The index of the side with the most taps, or -1 for a draw (tied leaders or no taps). */
function mashWinner(totals) {
  const top = Math.max(0, ...totals);
  const leaders = totals.filter((total) => total === top);
  return top === 0 || leaders.length > 1 ? -1 : totals.indexOf(top);
}

function MashBars({ sides, totals }) {
  const shares = largestRemainder(totals);
  return (
    <div className="mash-bars big" data-mash-bars="">
      <div className="mash-split" aria-hidden="true">
        {sides.map((side, index) => (
          <span
            key={`${index}:${side}`}
            className={`mash-seg pat-${index}`}
            style={{ ...sideStyle(index), flexGrow: Math.max(1, totals[index] ?? 0) }}
          >
            <span className="seg-num">{index + 1}</span>
          </span>
        ))}
      </div>
      <ul className="mash-totals" aria-label="Totals">
        {sides.map((side, index) => (
          <li key={`${index}:${side}`} className="mash-side-total" style={sideStyle(index)}>
            <span className={`mash-swatch pat-${index}`} aria-hidden="true" />
            <span className="mash-label">{side}</span>
            <span className="sr-only">: </span>
            <strong data-mash-total={index}>{number.format(totals[index] ?? 0)}</strong>
            <span className="sr-only"> taps, </span>
            <span className="mash-pct" data-mash-pct={index}>
              {percent.format((shares[index] ?? 0) / 100)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MashSides({ sides }) {
  return (
    <div className="mash-bars big">
      <ul className="mash-totals" aria-label="Sides">
        {sides.map((side, index) => (
          <li key={`${index}:${side}`} className="mash-side-total" style={sideStyle(index)}>
            <span className={`mash-swatch pat-${index}`} aria-hidden="true" />
            <span className="mash-label">{side}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MashRing({ left, duration }) {
  return (
    <span className="mash-ring" style={{ "--p": (left / duration) * 100 }} data-mash-ring="">
      <span data-mash-left="">{left}</span>
      <small>sec</small>
      <span className="sr-only"> left</span>
    </span>
  );
}

function MashWinner({ sides, winner }) {
  const draw = winner === -1;
  return (
    <div className="mash-winner big" style={sideStyle(draw ? 0 : winner)}>
      <span className="mash-burst" aria-hidden="true">
        {Array.from({ length: draw ? 0 : 18 }, (_, index) => (
          <i key={index} style={{ "--i": index }} />
        ))}
      </span>
      <p>{draw ? "Final" : "Winner"}</p>
      <strong>{draw ? "Draw" : sides[winner]}</strong>
    </div>
  );
}

/**
 * A Mash Battle on stream: the ring with the seconds left (the winner when it is finished), the tug-of-war bar and
 * the totals of each side, and the "Tap at" link to the page.
 */
export function OverlayMash({
  streamer = "Sunny",
  title,
  sides,
  totals,
  phase = "live",
  left,
  duration = 30,
  winner,
  showResults = true,
  host = "streambullets.com",
  handle = "sunny",
  qr = null,
}) {
  let ring = phase === "live" ? (left ?? duration) : duration;
  if (phase === "finished") ring = 0;
  const top =
    phase === "finished" && showResults ? (
      <MashWinner sides={sides} winner={winner ?? mashWinner(totals)} />
    ) : (
      <MashRing left={ring} duration={duration} />
    );
  return (
    <article className={`poll-card overlay-card mash-overlay phase-${phase}`} data-overlay-mash={phase}>
      <CardBody qr={qr}>
        <div className="mash-ov-head">
          <div>
            <span className="eyebrow">
              <Icon name="zap" size={16} />
              {streamer} · Mash Battle
            </span>
            <h1>{title}</h1>
          </div>
          {top}
        </div>
        {showResults ? (
          <MashBars sides={sides} totals={totals} />
        ) : (
          <>
            <MashSides sides={sides} />
            <p className="ov-hidden-results">Results hidden</p>
          </>
        )}
        <p className="mash-cta">
          <Icon name="arrow-right" size={24} />
          Tap at{" "}
          <span className="mash-short">
            {host}/@{handle}
          </span>
        </p>
      </CardBody>
    </article>
  );
}
