import { useContext, useId, useState, type ReactNode } from "react";
import { intlLocale, t, type MessageId } from "../../i18n";
import { goalBar, type GoalBar } from "../../lib/alert-feed";
import { GOAL_COUNTS, GOAL_TARGET, GOAL_TITLE_LENGTH, type GoalCount } from "../../lib/goals";
import type { GoalLayer } from "../../lib/overlay-layers";
import { Dialog, DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Select, type SelectOption } from "../ui/select";
import type { ActivityFeed } from "./activity-feed";
import { WholeNumberInput, alertsFailure } from "./alerts-settings";
import { ControlApiContext, type ControlApi } from "./control-api";
import { useAlerts } from "./use-alerts";
import type { EditTiming } from "./use-layer-draft";

/**
 * False until the server counts poll votes and new topics for a goal (issue #1043). The list of the things to count
 * then has no `votes` entry, unless the saved goal already counts votes.
 */
export const VOTES_GOAL_READY: boolean = false;

const COUNT_NAMES: Readonly<Record<GoalCount, MessageId>> = {
  subs: "overlay.goal.count.subs",
  follows: "overlay.goal.count.follows",
  bits: "overlay.goal.count.bits",
  kicks: "overlay.goal.count.kicks",
  chatters: "overlay.goal.count.chatters",
  votes: "overlay.goal.count.votes",
};

/** The things that the list offers to count, in the sequence of GOAL_COUNTS, and the saved one. */
export function shownCounts(current: GoalCount, votes: boolean = VOTES_GOAL_READY): readonly GoalCount[] {
  return GOAL_COUNTS.filter((count: GoalCount): boolean => votes || count !== "votes" || count === current);
}

function isGoalCount(value: string): value is GoalCount {
  const counts: readonly string[] = GOAL_COUNTS;
  return counts.includes(value);
}

/**
 * The settings of the goal layer: the title on stream, what the goal counts, and the target. Each change saves as
 * one field of a layer change: the title and the target after a pause in typing, the count at once. Below them, the
 * count of the server with **Start again**, which asks first, because it sets the count to 0.
 *
 * The count comes from `feed`, the owner's activity socket: the server sends it in each `alerts` message. Without a
 * message the count is 0, as on the overlay.
 */
export function GoalSettings({
  goal,
  feed,
  onGoal,
}: Readonly<{
  goal: GoalLayer;
  /** The owner's activity feed, or null while it is closed. */
  feed: ActivityFeed | null;
  onGoal: (patch: Partial<GoalLayer>, when: EditTiming) => void;
}>): ReactNode {
  const api: ControlApi = useContext(ControlApiContext);
  const titleId: string = useId();
  const titleHintId: string = useId();
  const countsId: string = useId();
  const targetId: string = useId();
  const { goal: progress } = useAlerts(feed);
  const [confirming, setConfirming] = useState<boolean>(false);
  const [resetting, setResetting] = useState<boolean>(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [news, setNews] = useState<string>("");
  const bar: GoalBar = goalBar(goal, progress);
  const numbers = new Intl.NumberFormat(intlLocale());
  const count: string = t("overlay.goal.progress", {
    value: numbers.format(bar.value),
    target: numbers.format(bar.target),
  });
  const options: SelectOption[] = shownCounts(goal.counts).map(
    (value: GoalCount): SelectOption => ({ value, label: t(COUNT_NAMES[value]) }),
  );

  async function reset(): Promise<void> {
    if (resetting) return;
    setResetting(true);
    setFailure(null);
    setNews("");
    try {
      await api.alerts({ op: "goalReset" });
      setConfirming(false);
      setNews(t("overlay.goal.resetDone"));
    } catch (error_: unknown) {
      setConfirming(false);
      setFailure(t("overlay.goal.resetFailed", { error: alertsFailure(error_) }));
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="ov-goal-settings" data-goal-settings>
      <div className="ov-goal-fields">
        <div className="ov-props-field ov-goal-title">
          <label className="field-label" htmlFor={titleId}>
            {t("overlay.goal.title")}
          </label>
          <input
            id={titleId}
            maxLength={GOAL_TITLE_LENGTH}
            value={goal.title}
            aria-describedby={titleHintId}
            onChange={(event) => onGoal({ title: event.currentTarget.value }, "idle")}
            data-goal-title-input
          />
          <p className="muted ov-comp-note" id={titleHintId}>
            {t("overlay.goal.titleHint", { n: GOAL_TITLE_LENGTH })}
          </p>
        </div>
        <div className="ov-props-field ov-goal-counts">
          <span className="field-label" id={countsId}>
            {t("overlay.goal.counts")}
          </span>
          <Select
            labelledBy={countsId}
            options={options}
            value={goal.counts}
            onValueChange={(value: string) => {
              if (isGoalCount(value) && value !== goal.counts) onGoal({ counts: value }, "now");
            }}
          />
          <p className="muted ov-comp-note">{t("overlay.goal.countsHint")}</p>
        </div>
        <div className="ov-props-field ov-goal-target">
          <span className="field-label" id={targetId}>
            {t("overlay.goal.target")}
          </span>
          <WholeNumberInput
            value={goal.target}
            limits={GOAL_TARGET}
            labelledBy={targetId}
            onValue={(target: number, when: EditTiming) => onGoal({ target }, when)}
            data-goal-target
          />
        </div>
      </div>
      <div className="ov-goal-progress">
        <progress
          value={Math.min(bar.value, bar.target)}
          max={bar.target}
          aria-label={t("overlay.goal.progressLabel")}
          aria-valuetext={count}
        />
        <span className="ov-goal-progress-text" data-goal-progress>
          {count}
        </span>
        <button
          type="button"
          className="small-button"
          aria-disabled={resetting}
          onClick={() => {
            if (!resetting) setConfirming(true);
          }}
          data-goal-reset
        >
          <Icon name="refresh" size={16} />
          {t("overlay.goal.reset")}
        </button>
      </div>
      {failure && (
        <p className="ov-chars-invalid" role="alert" data-goal-failed>
          {failure}
        </p>
      )}
      <p className="muted ov-comp-note">{t("overlay.goal.oneThing")}</p>
      <p className="sr-only" aria-live="polite" data-goal-news>
        {news}
      </p>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("overlay.goal.resetTitle")}
        description={t("overlay.goal.resetBody")}
        actions={
          <DialogActions>
            <button
              type="button"
              className="danger"
              aria-disabled={resetting}
              onClick={() => void reset()}
              data-goal-reset-confirm
            >
              {t("overlay.goal.reset")}
            </button>
          </DialogActions>
        }
      />
    </div>
  );
}
