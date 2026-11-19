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

// Shared graphic data for OBS and control monitors.
export interface OverlayScene {
  name: string;
  handle: string;
  // Host shown in Tap at.
  host: string;
  overlay: Pick<OverlayPublic, "position" | "size" | "showResults" | "message" | "messageStyle">;
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

// Auto chooses the newest open poll of the page owner, then the owner's newest poll. It never chooses a viewer poll:
// the owner picks one with "A specific poll". Mash openness follows phase at now; entries never receive end/reveal
// values.
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
  const own: readonly OverlayPoll[] = polls.filter((poll: OverlayPoll): boolean => poll.byOwner);
  return own.find(open) ?? own[0];
}

function MashOverlay({ scene, poll }: Readonly<{ scene: OverlayScene; poll: OverlayPoll }>): ReactNode {
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

// Refresh Up next at its stream's start; null for other sources.
export function upNextStart(source: OverlaySourceRef, data: Pick<OverlayData, "next">): number | null {
  return source.type === "next" ? (data.next?.startsAt ?? null) : null;
}

// False when the stage stays empty: Hidden, or a topic, stream or card that is not there.
export function showsContent(source: OverlaySourceRef, data: Pick<OverlayData, "topics" | "cards" | "next">): boolean {
  if (source.type === "hidden") return false;
  if (source.type === "topic") return data.topics.some((item) => item.id === source.ref);
  if (source.type === "next") return data.next !== null;
  if (source.type === "card")
    return source.ref === null ? data.cards.length > 0 : data.cards.some((item) => item.id === source.ref);
  return true;
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
  // Missing ref selects first card; deleted refs show nothing.
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

// 1920x1080 stage. Polls/battles fill it; other sources use presets. Hidden is transparent and empty. In a grid cell
// (`fit`) the content is centred and the position setting does not apply.
export function OverlayStage({
  scene,
  source,
  className = "",
  fit = false,
}: Readonly<{ scene: OverlayScene; source: OverlaySourceRef; className?: string; fit?: boolean }>): ReactNode {
  const full: boolean = source.type === "auto" || source.type === "poll";
  let position: string = full ? "full" : scene.overlay.position;
  if (fit) position = "fit";
  const classes: string = `ov-stage pos-${position} size-${scene.overlay.size} ${className}`;
  return (
    <div className={classes.trim()} data-overlay-type={source.type}>
      <SourceContent scene={scene} source={source} />
    </div>
  );
}
