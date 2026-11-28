import type { ReactNode } from "react";
import { t } from "../../i18n";
import { onAnyOutput, type OverlayLayers } from "../../lib/overlay-layers";
import { paths } from "../../lib/shell";
import type { OverlayData, OverlayState } from "../../types";
import type { OverlayScene } from "../overlay/overlay-stage";
import type { ControlAction } from "../overlay/use-overlay-state";
import { Icon } from "../ui/icon";
import { LivePart, NotOnGrid, placed } from "./live-part";

type Topic = OverlayData["topics"][number];

/** The topics that Live lists: the newest, with the topic of the topic layer always among them. */
export const LIVE_TOPICS = 6;

/** The newest topics, and before them the topic of the topic layer when it is older than those. */
export function liveTopics(topics: readonly Topic[], ref: string | null): Topic[] {
  const newest: Topic[] = topics.slice(0, LIVE_TOPICS);
  const current: Topic | undefined = topics.find((topic: Topic): boolean => topic.id === ref);
  return current && !newest.includes(current) ? [current, ...newest.slice(0, LIVE_TOPICS - 1)] : newest;
}

/**
 * The newest viewer topics. "Feature on stream" shows a topic in the topic layer, at the place that the layer has on
 * the grid. The button is at the end of its row, at the width that the button of the message banner also has.
 */
export function LiveTopics({
  scene,
  state,
  busy,
  run,
}: Readonly<{
  scene: OverlayScene;
  state: OverlayState;
  busy: boolean;
  run: (action: ControlAction) => void;
}>): ReactNode {
  const layers: OverlayLayers = state.layers;
  const ref: string | null = layers.items.topic.ref;
  const onAir: boolean = onAnyOutput(layers, "topic");
  const canShow: boolean = placed(layers, "topic");
  const topics: Topic[] = liveTopics(scene.data.topics, ref);
  return (
    <LivePart name="topics" title={t("tools.live.topics")}>
      {topics.length === 0 ? (
        <p className="muted" data-live-topics-none>
          {t("tools.live.topics.none")}
        </p>
      ) : (
        <ul className="tl-list" data-live-topics>
          {topics.map((topic: Topic) => {
            const featured: boolean = onAir && topic.id === ref;
            return (
              <li key={topic.id} className="tl-row" data-live-topic={topic.id} data-on-air={featured || undefined}>
                <div className="tl-row-text">
                  <span className="tl-title">{topic.title}</span>
                  <span className="muted">{t("tools.live.topics.by", { author: topic.author })}</span>
                </div>
                {featured && (
                  <span className="tl-state" data-on-air>
                    {t("tools.live.onAir")}
                  </span>
                )}
                {canShow && (
                  <button
                    type="button"
                    className="tl-action"
                    disabled={busy}
                    aria-label={t(featured ? "tools.live.topics.takeOffLabel" : "tools.live.topics.featureLabel", {
                      title: topic.title,
                    })}
                    onClick={() =>
                      run({
                        action: "layers",
                        items: { topic: featured ? { enabled: false } : { ref: topic.id, enabled: true } },
                      })
                    }
                  >
                    <Icon name={featured ? "stop" : "megaphone"} size={18} />
                    {t(featured ? "tools.live.takeOff" : "tools.live.topics.feature")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!canShow && topics.length > 0 && <NotOnGrid layer="topic" />}
      <p className="tl-note">
        <a className="text-link" href={`${paths.streamer(scene.handle)}?view=topics`}>
          {t("tools.live.topics.open")}
        </a>
      </p>
    </LivePart>
  );
}
