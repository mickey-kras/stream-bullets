import { t } from "../../i18n";
import type { ActivityMessage } from "../../lib/activity";
import { SAMPLE_CHAT } from "../../lib/chat-feed";
import {
  CHAR_STATES,
  FLAG_NEW,
  PLAYGROUND_VERSION,
  type CharState,
  type CharTuple,
  type PlaygroundFullFrame,
  type RosterEntry,
} from "../../lib/playground/protocol";
import { createTerrain, createWorld, terrainView, type World } from "../../lib/playground/terrain";
import type { OverlaySourceRef } from "../../types";
import type { ActivityFeed } from "./activity-feed";
import type { OverlayScene } from "./overlay-stage";

/**
 * Sample content for the layout editor preview: a layer that is off, or a content cell with nothing on air, shows a
 * sample there. Only the editor reads this file. The OBS pages and the saved layers never get a sample.
 */

/** One state for each sample character. */
const SAMPLE_STATES: readonly CharState[] = ["idle", "walk", "wave", "walk"];

/** One still frame: the first sample chatters on the ground of a characters cell of `cellsW` x `cellsH` cells. */
export function sampleCharactersFrame(cellsW: number, cellsH: number): PlaygroundFullFrame {
  const world: World = createWorld(cellsW, cellsH);
  const roster: RosterEntry[] = SAMPLE_STATES.map(
    (_state: CharState, index: number): RosterEntry => ({
      id: index + 1,
      platform: SAMPLE_CHAT[index].platform,
      name: SAMPLE_CHAT[index].user.displayName,
    }),
  );
  const step: number = (world.xmax - world.xmin) / (roster.length + 1);
  const chars: CharTuple[] = roster.map(
    (entry: RosterEntry, index: number): CharTuple => [
      entry.id,
      Math.round((world.xmin + step * (index + 1)) * 10),
      world.gy * 10,
      CHAR_STATES.indexOf(SAMPLE_STATES[index]),
      0,
      index % 2 === 0 ? 1 : -1,
      // The flag shows the name label.
      FLAG_NEW,
    ],
  );
  return {
    type: "playground",
    v: PLAYGROUND_VERSION,
    full: true,
    tick: 0,
    chars,
    roster,
    bubbles: [{ id: roster[0].id, text: SAMPLE_CHAT[0].text }],
    terrain: terrainView(world, createTerrain(world)),
    mode: { paused: false, test: false },
  };
}

/**
 * A feed that gives the sample frame to each new listener. It opens no socket, so it costs no provider quota. Null
 * for a cell outside the playground size limits.
 */
export function sampleCharactersFeed(cellsW: number, cellsH: number): ActivityFeed | null {
  let frame: PlaygroundFullFrame;
  try {
    frame = sampleCharactersFrame(cellsW, cellsH);
  } catch {
    return null;
  }
  return {
    status: "off",
    subscribe: (listener: (message: ActivityMessage) => void): (() => void) => {
      listener(frame);
      return (): void => undefined;
    },
  };
}

const SAMPLE_TOPIC_ID = "sample-topic";

/** The source of the sample card: a topic spotlight. */
export const SAMPLE_SOURCE: OverlaySourceRef = { type: "topic", ref: SAMPLE_TOPIC_ID };

/** `scene` with the sample topic that SAMPLE_SOURCE shows. */
export function sampleScene(scene: OverlayScene): OverlayScene {
  return {
    ...scene,
    data: {
      ...scene.data,
      topics: [
        {
          id: SAMPLE_TOPIC_ID,
          title: t("overlay.comp.sampleTopic"),
          category: "",
          author: SAMPLE_CHAT[0].user.displayName,
          avatar: null,
          avatarPreset: null,
          likes: 42,
        },
      ],
    },
  };
}
