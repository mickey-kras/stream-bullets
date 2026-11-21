import { useEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { intlLocale, t, tn } from "../../i18n";
import { MASH_NAME, mashPhaseAt, mashWinner } from "../../lib/mash";
import type { ContentSource } from "../../lib/overlay-layers";
import { paths } from "../../lib/shell";
import type { LiveSnapshot, OverlayData, OverlayPublic } from "../../types";
import { MashBars, MashRing, MashSides, MashWinner } from "../mash/mash-parts";
import { useMashView } from "../mash/use-mash";
import { PollResults, PollStatus } from "../poll";
import type { StreamerView } from "../shell/streamer-header";
import { Avatar } from "../ui/avatar";
import { Icon } from "../ui/icon";
import { QrCode } from "./qr-code";

export type OverlayPoll = LiveSnapshot["polls"][number];

// Shared graphic data for OBS and the editor preview.
export interface OverlayScene {
  name: string;
  handle: string;
  // Host shown in Tap at.
  host: string;
  // The origin of the app, for the QR code links.
  origin: string;
  overlay: Pick<OverlayPublic, "showResults" | "message" | "messageStyle">;
  polls: readonly OverlayPoll[];
  data: OverlayData;
  now: number;
}

function noSubscription(): () => void {
  return (): void => undefined;
}

// Delay local-time rendering until after hydration.
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    (): boolean => true,
    (): boolean => false,
  );
}

// Auto (a poll layer without a ref) chooses the newest open poll of the page owner, then the owner's newest poll. It
// never chooses a viewer poll: the owner picks one in the poll layer. Mash openness follows phase at now; entries
// never receive end/reveal values.
export function overlayPoll(
  source: ContentSource,
  polls: readonly OverlayPoll[],
  now: number,
): OverlayPoll | undefined {
  if (source.type === "poll") return polls.find((poll: OverlayPoll) => poll.id === source.ref);
  if (source.type !== "auto") return undefined;
  const open = (poll: OverlayPoll): boolean =>
    !poll.revealed &&
    (poll.endsAt === null || poll.endsAt > now) &&
    (poll.mash === null || mashPhaseAt(poll.mash, now) !== "finished");
  const own: readonly OverlayPoll[] = polls.filter((poll: OverlayPoll): boolean => poll.byOwner);
  return own.find(open) ?? own[0];
}

type Card = OverlayData["cards"][number];

// A card layer without a ref shows the first card. A deleted ref shows nothing.
function overlayCard(source: ContentSource, cards: readonly Card[]): Card | undefined {
  return source.ref === null ? cards[0] : cards.find((item: Card): boolean => item.id === source.ref);
}

function pageUrl(scene: OverlayScene, view?: StreamerView, entry?: string): string {
  const url = new URL(paths.streamer(scene.handle), scene.origin);
  if (view) url.searchParams.set("view", view);
  if (entry) url.searchParams.set("entry", entry);
  return url.toString();
}

/**
 * The link of the QR code of a content layer: the public page of what the layer shows. Null when the layer shows
 * nothing, and for the message banner, which has no page.
 */
export function qrTarget(scene: OverlayScene, source: ContentSource): string | null {
  switch (source.type) {
    case "auto":
    case "poll": {
      const poll: OverlayPoll | undefined = overlayPoll(source, scene.polls, scene.now);
      return poll ? pageUrl(scene, "polls", poll.id) : null;
    }
    case "topic": {
      const topic = scene.data.topics.find((item): boolean => item.id === source.ref);
      return topic ? pageUrl(scene, "topics", topic.id) : null;
    }
    case "next":
      return scene.data.next ? pageUrl(scene, "schedule") : null;
    case "card":
      return overlayCard(source, scene.data.cards) ? pageUrl(scene, "community") : null;
    case "support":
      return scene.data.support?.url ?? pageUrl(scene);
    case "message":
      return null;
  }
}

/** The content of a card. With a QR code link, the text keeps the left side and the code sits at the right edge. */
function CardBody({ qr, children }: Readonly<{ qr: string | null; children: ReactNode }>): ReactNode {
  if (qr === null) return children;
  return (
    <div className="ov-qr-row">
      <div className="ov-qr-text">{children}</div>
      <QrCode url={qr} />
    </div>
  );
}

/** What each card gets. `qr` is the link of its QR code, or null for no code. */
type CardProps = Readonly<{ scene: OverlayScene; qr: string | null }>;

function MashOverlay({ scene, poll, qr }: CardProps & Readonly<{ poll: OverlayPoll }>): ReactNode {
  const view = useMashView(poll, scene.now);
  if (!view) return null;
  const shown: boolean = scene.overlay.showResults;
  // Hidden results use an empty ring, including finished battles.
  let left: number = view.current === "live" ? view.left : view.durationS;
  if (view.current === "finished") left = 0;
  const top: ReactNode =
    view.current === "finished" && shown ? (
      <MashWinner sides={poll.options} winner={view.winner ?? mashWinner(view.totals)} big />
    ) : (
      <MashRing left={left} duration={view.durationS} />
    );
  return (
    <article className={`poll-card overlay-card mash-overlay phase-${view.current}`} data-overlay-mash={view.current}>
      <CardBody qr={qr}>
        <div className="mash-ov-head">
          <div>
            <span className="eyebrow">
              <Icon name="zap" size={16} />
              {scene.name} · {MASH_NAME}
            </span>
            <h1>{poll.title}</h1>
          </div>
          {top}
        </div>
        {shown ? (
          <MashBars sides={poll.options} totals={view.totals} big />
        ) : (
          <>
            <MashSides sides={poll.options} />
            <p className="ov-hidden-results">{t("overlay.resultsHidden")}</p>
          </>
        )}
        <p className="mash-cta">
          <Icon name="arrow-right" size={24} />
          {t("overlay.tapAt")}{" "}
          <span className="mash-short">
            {scene.host}/@{scene.handle}
          </span>
        </p>
      </CardBody>
    </article>
  );
}

/**
 * Sets the largest font size at which the text of `element` fits its box. The poll question has the height of the QR
 * code, so a short question shows large and a long question shows small. It measures again when the box changes.
 */
function useFitText(text: string): RefObject<HTMLHeadingElement | null> {
  const element = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    const node: HTMLHeadingElement | null = element.current;
    if (!node) return;
    const fit = (): void => {
      let low = 12;
      let high: number = Math.max(low, Math.floor(node.clientHeight * 0.6));
      while (low < high) {
        const size: number = Math.ceil((low + high) / 2);
        node.style.fontSize = `${size}px`;
        if (node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth) low = size;
        else high = size - 1;
      }
      node.style.fontSize = `${low}px`;
    };
    const sizes = new ResizeObserver(fit);
    sizes.observe(node);
    return (): void => sizes.disconnect();
  }, [text]);
  return element;
}

/** Option names longer than this many characters do not fit a bar that shares its row with two others. */
const SHORT_OPTION = 12;

/**
 * The number of option columns for long option names: one row for each of up to three options, else two columns.
 * Undefined for short names: the options then share one row, or two rows of three.
 */
export function optionColumns(options: readonly string[]): 1 | 2 | undefined {
  if (options.every((option: string): boolean => option.length <= SHORT_OPTION)) return undefined;
  return options.length <= 3 ? 1 : 2;
}

/**
 * A poll on stream. Viewers cannot select it, so it is short: the question beside the QR code at the same height,
 * the options across the full width with the live result, and one status line.
 */
function PollOverlay({ scene, poll, qr }: CardProps & Readonly<{ poll: OverlayPoll }>): ReactNode {
  const title = useFitText(poll.title);
  if (poll.kind === "mash" && poll.mash) return <MashOverlay scene={scene} poll={poll} qr={qr} />;
  const hiddenUntilReveal: boolean = poll.kind === "binary" && !poll.revealed;
  return (
    <article
      className="poll-card overlay-card ov-poll"
      data-overlay-poll={poll.id}
      data-option-columns={optionColumns(poll.options)}
    >
      <div className="ov-poll-body">
        <div className="ov-poll-head">
          <h1 ref={title}>{poll.title}</h1>
          {qr !== null && <QrCode url={qr} />}
        </div>
        {scene.overlay.showResults ? (
          <PollResults poll={poll} now={scene.now} />
        ) : (
          <p className="ov-hidden-results">{t("overlay.resultsHidden")}</p>
        )}
        <div className="ov-poll-foot">
          <PollStatus poll={poll} now={scene.now} />
          <p className="overlay-total">
            {tn("poll.votes", poll.total)}
            {hiddenUntilReveal && ` · ${t("overlay.notRevealed")}`}
          </p>
        </div>
      </div>
    </article>
  );
}

function startsIn(startsAt: number, now: number): string {
  const minutes: number = Math.max(0, Math.round((startsAt - now) / 60_000));
  if (minutes < 60) return t("overlay.inMinutes", { n: minutes });
  const hours: number = Math.floor(minutes / 60);
  if (hours < 48) return t("overlay.inHours", { h: hours, m: minutes % 60 });
  return t("overlay.inDays", { n: Math.floor(hours / 24) });
}

function NextStream({ scene, qr }: CardProps): ReactNode {
  const hydrated: boolean = useHydrated();
  const next = scene.data.next;
  if (!next) return null;
  const when: string = hydrated
    ? new Intl.DateTimeFormat(intlLocale(), { weekday: "short", hour: "numeric", minute: "2-digit" }).format(
        next.startsAt,
      )
    : "";
  return (
    <article className="ov-card" data-overlay-source="next">
      <CardBody qr={qr}>
        <span className="eyebrow">
          <Icon name="schedule" size={16} />
          {t("overlay.upNext")}
        </span>
        <h1>{next.title}</h1>
        <p className="ov-meta">
          <Icon name="timer" size={24} />
          {when}
          {hydrated && <span className="ov-pill">{startsIn(next.startsAt, scene.now)}</span>}
        </p>
      </CardBody>
    </article>
  );
}

function CommunityOverlay({ scene, source, qr }: CardProps & Readonly<{ source: ContentSource }>): ReactNode {
  const card: Card | undefined = overlayCard(source, scene.data.cards);
  if (!card) return null;
  let target: string = "";
  if (card.target?.startsWith("tab:")) target = `${scene.host}/@${scene.handle}`;
  else if (card.target) target = card.target.replace(/^https:\/\//, "");
  return (
    <article className="ov-card" data-overlay-source="card">
      <CardBody qr={qr}>
        <span className="eyebrow">
          <Icon name="community" size={16} />
          {t("overlay.community", { name: scene.name })}
        </span>
        <h1>{card.title}</h1>
        <p className="ov-body">{card.body}</p>
        {card.label && (
          <p className="ov-cta">
            {card.label}
            {target && ` · ${target}`}
          </p>
        )}
      </CardBody>
    </article>
  );
}

function SourceContent({ scene, source, qr }: CardProps & Readonly<{ source: ContentSource }>): ReactNode {
  const { data, overlay } = scene;
  if (source.type === "auto" || source.type === "poll") {
    const poll = overlayPoll(source, scene.polls, scene.now);
    return poll ? (
      <PollOverlay scene={scene} poll={poll} qr={qr} />
    ) : (
      <div className="overlay-empty">{t("overlay.waiting")}</div>
    );
  }
  if (source.type === "topic") {
    const topic = data.topics.find((item) => item.id === source.ref);
    if (!topic) return null;
    return (
      <article className="ov-card" data-overlay-source="topic">
        <CardBody qr={qr}>
          <span className="eyebrow">
            <Icon name="topics" size={16} />
            {t("overlay.topicSpotlight")}
          </span>
          <h1>{topic.title}</h1>
          <p className="ov-meta">
            <Avatar url={topic.avatar} preset={topic.avatarPreset} className="avatar-32" />
            <span>
              {t("overlay.suggestedBy")} <strong>{topic.author}</strong>
            </span>
            <span className="ov-likes">
              <Icon name="thumbs-up" size={24} />
              {topic.likes}
            </span>
          </p>
        </CardBody>
      </article>
    );
  }
  if (source.type === "next") return <NextStream scene={scene} qr={qr} />;
  if (source.type === "message")
    return (
      <article className={`ov-card ov-message style-${overlay.messageStyle}`} data-overlay-source="message">
        <h1>
          <Icon name={overlay.messageStyle === "hype" ? "zap" : "megaphone"} size={40} />
          {overlay.message || t("overlay.messagePlaceholder")}
        </h1>
      </article>
    );
  if (source.type === "card") return <CommunityOverlay scene={scene} source={source} qr={qr} />;
  const link = data.support;
  return (
    <article className="ov-card ov-support" data-overlay-source="support">
      <CardBody qr={qr}>
        <h1>
          <Icon name="heart" size={40} />
          {t("overlay.supportStream")} <span>{link ? link.url.replace(/^https:\/\//, "") : t("overlay.addLink")}</span>
        </h1>
      </CardBody>
    </article>
  );
}

// The content of one layer in its grid cell: centred, at the full cell width. `qr` is the QR code setting of the layer.
export function OverlayStage({
  scene,
  source,
  qr,
}: Readonly<{ scene: OverlayScene; source: ContentSource; qr: boolean }>): ReactNode {
  return (
    <div className="ov-stage" data-overlay-type={source.type}>
      <SourceContent scene={scene} source={source} qr={qr ? qrTarget(scene, source) : null} />
    </div>
  );
}
