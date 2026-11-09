import { useSyncExternalStore, type ReactNode } from "react";
import { intlLocale, t, tn } from "../../i18n";
import { MASH_NAME, mashPhaseAt, mashWinner } from "../../lib/mash";
import type { LiveSnapshot, OverlayData, OverlayPublic, OverlaySourceRef } from "../../types";
import { MashBars, MashRing, MashSides, MashWinner } from "../mash/mash-parts";
import { useMashView } from "../mash/use-mash";
import { PollResults, PollStatus } from "../poll";
import { Avatar } from "../ui/avatar";
import { Icon } from "../ui/icon";

export type OverlayPoll = LiveSnapshot["polls"][number];

/** What one overlay graphic needs. The OBS page and the control page monitors share it. */
export interface OverlayScene {
  name: string;
  handle: string;
  /** The host the "Tap at" line shows, such as streambullets.com. */
  host: string;
  overlay: Pick<OverlayPublic, "position" | "size" | "showResults" | "message" | "messageStyle">;
  polls: readonly OverlayPoll[];
  data: OverlayData;
  now: number;
}

function noSubscription(): () => void {
  return (): void => undefined;
}

/** False during the server render and hydration, so times render in the viewer's own time zone only. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    (): boolean => true,
    (): boolean => false,
  );
}

/**
 * The poll a poll source shows: Auto picks the newest open poll, else the newest poll. A Mash Battle is open until
 * its phase at `now` is finished; its entry never gets an end time or a reveal.
 */
export function overlayPoll(
  source: OverlaySourceRef,
  polls: readonly OverlayPoll[],
  now: number,
): OverlayPoll | undefined {
  if (source.type === "poll") return polls.find((poll: OverlayPoll) => poll.id === source.ref);
  if (source.type !== "auto") return undefined;
  const open = (poll: OverlayPoll): boolean =>
    !poll.revealed &&
    (poll.endsAt === null || poll.endsAt > now) &&
    (poll.mash === null || mashPhaseAt(poll.mash, now) !== "finished");
  return polls.find(open) ?? polls[0];
}

function MashOverlay({ scene, poll }: Readonly<{ scene: OverlayScene; poll: OverlayPoll }>): ReactNode {
  const view = useMashView(poll, scene.now);
  if (!view) return null;
  const shown: boolean = scene.overlay.showResults;
  // With results hidden, a finished battle shows an empty ring instead of its winner.
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
    </article>
  );
}

function PollOverlay({ scene, poll }: Readonly<{ scene: OverlayScene; poll: OverlayPoll }>): ReactNode {
  if (poll.kind === "mash" && poll.mash) return <MashOverlay scene={scene} poll={poll} />;
  const hiddenUntilReveal: boolean = poll.kind === "binary" && !poll.revealed;
  return (
    <article className="poll-card overlay-card" data-overlay-poll={poll.id}>
      <span className="eyebrow">{t("overlay.livePoll", { name: scene.name })}</span>
      <PollStatus poll={poll} now={scene.now} />
      <h1>{poll.title}</h1>
      {scene.overlay.showResults ? (
        <PollResults poll={poll} now={scene.now} />
      ) : (
        <p className="ov-hidden-results">{t("overlay.resultsHidden")}</p>
      )}
      <p className="overlay-total">
        {tn("poll.votes", poll.total)}
        {hiddenUntilReveal && ` · ${t("overlay.notRevealed")}`}
      </p>
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

/** When the Up next source needs new data: the start of the stream it shows. Null for other sources. */
export function upNextStart(source: OverlaySourceRef, data: Pick<OverlayData, "next">): number | null {
  return source.type === "next" ? (data.next?.startsAt ?? null) : null;
}

function NextStream({ scene }: Readonly<{ scene: OverlayScene }>): ReactNode {
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
    </article>
  );
}

function CommunityOverlay({ scene, source }: Readonly<{ scene: OverlayScene; source: OverlaySourceRef }>): ReactNode {
  // No ref means the first card; a ref to a removed card shows nothing rather than another card.
  const card = source.ref === null ? scene.data.cards[0] : scene.data.cards.find((item) => item.id === source.ref);
  if (!card) return null;
  let target: string = "";
  if (card.target?.startsWith("tab:")) target = `${scene.host}/@${scene.handle}`;
  else if (card.target) target = card.target.replace(/^https:\/\//, "");
  return (
    <article className="ov-card" data-overlay-source="card">
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
    </article>
  );
}

function SourceContent({ scene, source }: Readonly<{ scene: OverlayScene; source: OverlaySourceRef }>): ReactNode {
  const { data, overlay } = scene;
  if (source.type === "auto" || source.type === "poll") {
    const poll = overlayPoll(source, scene.polls, scene.now);
    return poll ? (
      <PollOverlay scene={scene} poll={poll} />
    ) : (
      <div className="overlay-empty">{t("overlay.waiting")}</div>
    );
  }
  if (source.type === "topic") {
    const topic = data.topics.find((item) => item.id === source.ref);
    if (!topic) return null;
    return (
      <article className="ov-card" data-overlay-source="topic">
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
      </article>
    );
  }
  if (source.type === "next") return <NextStream scene={scene} />;
  if (source.type === "message")
    return (
      <article className={`ov-card ov-message style-${overlay.messageStyle}`} data-overlay-source="message">
        <h1>
          <Icon name={overlay.messageStyle === "hype" ? "zap" : "megaphone"} size={40} />
          {overlay.message || t("overlay.messagePlaceholder")}
        </h1>
      </article>
    );
  if (source.type === "card") return <CommunityOverlay scene={scene} source={source} />;
  if (source.type === "support") {
    const link = data.support;
    return (
      <article className="ov-card ov-support" data-overlay-source="support">
        <h1>
          <Icon name="heart" size={40} />
          {t("overlay.supportStream")} <span>{link ? link.url.replace(/^https:\/\//, "") : t("overlay.addLink")}</span>
        </h1>
      </article>
    );
  }
  return null;
}

/**
 * One overlay graphic on a 1920 by 1080 stage: polls and Mash Battles fill the stage, the other
 * sources sit where the position preset puts them. "Hidden" renders an empty, transparent stage.
 */
export function OverlayStage({
  scene,
  source,
  className = "",
}: Readonly<{ scene: OverlayScene; source: OverlaySourceRef; className?: string }>): ReactNode {
  const full: boolean = source.type === "auto" || source.type === "poll";
  const classes: string = `ov-stage pos-${full ? "full" : scene.overlay.position} size-${scene.overlay.size} ${className}`;
  return (
    <div className={classes.trim()} data-overlay-type={source.type}>
      <SourceContent scene={scene} source={source} />
    </div>
  );
}
