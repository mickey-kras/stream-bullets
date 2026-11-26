import { useContext, useState, type ReactNode } from "react";
import { t, tn } from "../../i18n";
import { copyText } from "../../lib/clipboard";
import { onAnyOutput, type ContentSource, type OverlayLayers } from "../../lib/overlay-layers";
import { paths } from "../../lib/shell";
import type { OverlayState } from "../../types";
import { errorMessage } from "../api";
import { ControlApiContext, type ControlApi } from "../overlay/control-api";
import { overlayPoll, qrTarget, type OverlayPoll, type OverlayScene } from "../overlay/overlay-stage";
import type { ControlAction } from "../overlay/use-overlay-state";
import { PollStatus } from "../poll";
import { Icon } from "../ui/icon";
import { useToast } from "../ui/toast";
import { LivePart, NotOnGrid, placed } from "./live-part";

/** What the poll layer shows, also while the layer is off air. */
function pollSource(layers: OverlayLayers): ContentSource {
  const ref: string | null = layers.items.poll.ref;
  return { type: ref === null ? "auto" : "poll", ref };
}

/** True while viewers can vote: the owner did not close the poll and its time is not over. */
function votingOpen(poll: OverlayPoll, now: number): boolean {
  return !poll.revealed && (poll.endsAt === null || poll.endsAt > now);
}

interface PollProps {
  scene: OverlayScene;
  state: OverlayState;
  busy: boolean;
  run: (action: ControlAction) => void;
}

/** The on-air controls of the poll that the poll layer shows. */
function PollActions({ scene, state, busy, run, poll }: Readonly<PollProps & { poll: OverlayPoll }>): ReactNode {
  const toast = useToast();
  const [closing, setClosing] = useState<boolean>(false);
  const layers: OverlayLayers = state.layers;
  const onAir: boolean = onAnyOutput(layers, "poll");
  const link: string | null = qrTarget(scene, pollSource(layers));

  async function copy(url: string): Promise<void> {
    const copied: boolean = await copyText(url);
    toast(t(copied ? "tools.live.poll.copied" : "contact.copyFallback"), copied ? undefined : { tone: "error" });
  }
  const api: ControlApi = useContext(ControlApiContext);
  async function close(): Promise<void> {
    setClosing(true);
    try {
      await api.closePoll(scene.handle, poll.id);
    } catch (error: unknown) {
      toast(errorMessage(error), { tone: "error" });
    } finally {
      setClosing(false);
    }
  }
  return (
    <div className="tl-actions">
      {link && (
        <button type="button" className="small-button" onClick={() => void copy(link)}>
          <Icon name="copy" size={16} />
          {t("tools.live.poll.copyLink")}
        </button>
      )}
      <button
        type="button"
        className="small-button"
        disabled={busy}
        data-live-poll-qr
        onClick={() => run({ action: "layers", items: { poll: { qr: !layers.items.poll.qr } } })}
      >
        {t(layers.items.poll.qr ? "tools.live.poll.hideQr" : "tools.live.poll.showQr")}
      </button>
      <button
        type="button"
        className="small-button"
        disabled={busy}
        data-live-poll-results
        onClick={() => run({ action: "showResults", on: !state.showResults })}
      >
        <Icon name={state.showResults ? "eye-off" : "eye"} size={16} />
        {t(state.showResults ? "tools.live.poll.hide" : "tools.live.poll.reveal")}
      </button>
      {poll.mash === null && votingOpen(poll, scene.now) && (
        <button
          type="button"
          className="small-button"
          disabled={closing}
          data-live-poll-close
          onClick={() => void close()}
        >
          <Icon name="lock" size={16} />
          {t("tools.live.poll.close")}
        </button>
      )}
      <button
        type="button"
        className="small-button"
        disabled={busy}
        data-live-poll-air
        onClick={() => run({ action: "layers", items: { poll: { enabled: !onAir } } })}
      >
        <Icon name={onAir ? "stop" : "live"} size={16} />
        {t(onAir ? "tools.live.takeOff" : "tools.live.putOn")}
      </button>
    </div>
  );
}

/**
 * The poll of the poll layer and its on-air controls. "Take off air" turns the layer off and keeps voting open on
 * the page. "Close voting" ends the vote on the page, which shows the results there. It does not undo.
 */
export function LivePoll(props: Readonly<PollProps>): ReactNode {
  const { scene, state } = props;
  const layers: OverlayLayers = state.layers;
  const poll: OverlayPoll | undefined = overlayPoll(pollSource(layers), scene.polls, scene.now);
  const onAir: boolean = onAnyOutput(layers, "poll");
  if (!poll)
    return (
      <LivePart name="poll" title={t("tools.live.poll")}>
        <p className="muted" data-live-poll-none>
          {t("tools.live.poll.none")}{" "}
          <a className="text-link" href={`${paths.streamer(scene.handle)}?view=polls`}>
            {t("tools.live.poll.open")}
          </a>
        </p>
      </LivePart>
    );
  return (
    <LivePart name="poll" title={t("tools.live.poll")}>
      <p className="tl-title" data-live-poll-title>
        {poll.title}
      </p>
      <div className="tl-meta" data-live-poll-status>
        <span className="tl-state" data-on-air={onAir || undefined}>
          {t(onAir ? "tools.live.onAir" : "tools.live.offAir")}
        </span>
        <PollStatus poll={poll} now={scene.now} />
        <span>{tn("poll.votes", poll.total)}</span>
        <span>{t(state.showResults ? "tools.live.poll.resultsShown" : "tools.live.poll.resultsHidden")}</span>
      </div>
      {placed(layers, "poll") ? <PollActions {...props} poll={poll} /> : <NotOnGrid layer="poll" />}
      <p className="muted tl-note">{t("tools.live.poll.note")}</p>
    </LivePart>
  );
}
