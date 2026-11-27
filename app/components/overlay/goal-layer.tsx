import { memo, type ReactNode } from "react";
import { intlLocale, t } from "../../i18n";
import { goalBar, type GoalBar } from "../../lib/alert-feed";
import type { GoalProgress } from "../../lib/goals";
import type { GoalLayer as GoalSettings } from "../../lib/overlay-layers";
import type { ActivityFeed } from "./activity-feed";
import { FitStage } from "./fit-stage";
import { useAlerts } from "./use-alerts";

/** "17 of 25" in the numbers of the language. */
function progressText(bar: GoalBar): string {
  const numbers = new Intl.NumberFormat(intlLocale());
  return t("overlay.goal.progress", { value: numbers.format(bar.value), target: numbers.format(bar.target) });
}

/**
 * The goal on stream: the title, the count "{value} of {target}", and a bar. The count is 0 before the server sent
 * one. A count above the target shows the real number with a full bar. The title is text of the owner: it renders
 * as text, in its own direction. A goal without a title shows the count and the bar only.
 */
export function GoalCard({
  goal,
  progress,
}: Readonly<{ goal: Pick<GoalSettings, "title" | "counts" | "target">; progress: GoalProgress | null }>): ReactNode {
  const bar: GoalBar = goalBar(goal, progress);
  const count: string = progressText(bar);
  const title: string = goal.title.trim();
  return (
    <article className="ov-card ov-goal" data-overlay-goal={goal.counts} data-goal-full={bar.part >= 1 || undefined}>
      <p className="ov-goal-line">
        {title !== "" && (
          <>
            <bdi data-goal-title>{title}</bdi>
            {" · "}
          </>
        )}
        <span className="ov-goal-count" data-goal-count>
          {count}
        </span>
      </p>
      {/* The bar is full at the target: a count above it does not make the bar longer. */}
      <progress
        className="ov-goal-bar"
        value={Math.min(bar.value, bar.target)}
        max={bar.target}
        aria-label={title === "" ? t("overlay.name.goal") : title}
        aria-valuetext={count}
      />
    </article>
  );
}

/**
 * The goal layer: the goal of the layer settings with the count of the activity feed. It shows whenever the layer is
 * on stream, on each output: the goal counts the events of each platform. A null feed shows the count 0 (the editor
 * preview). Memoised: `goal` is the object of the layers, which stays the same until the layers change.
 */
export const GoalLayer = memo(function GoalLayer({
  feed,
  goal,
}: Readonly<{
  /** The activity feed of the page, or null for none. */
  feed: ActivityFeed | null;
  goal: Pick<GoalSettings, "title" | "counts" | "target">;
}>): ReactNode {
  const { goal: progress } = useAlerts(feed);
  return (
    <FitStage type="goal">
      <GoalCard goal={goal} progress={progress} />
    </FitStage>
  );
});
