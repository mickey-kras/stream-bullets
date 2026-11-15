import { useRef, type CSSProperties, type ReactNode } from "react";
import type { ActivityChat } from "../../lib/activity";
import type { ChatRow } from "../../lib/chat-feed";
import {
  DESIGN_H,
  DESIGN_W,
  type ChatLayer as ChatLayerSettings,
  type LayerRect,
  type OverlayLayer,
  type OverlayLayers,
} from "../../lib/overlay-layers";
import type { OverlaySourceRef } from "../../types";
import type { ActivityFeed } from "./activity-feed";
import { ChatLayer } from "./chat-layer";
import { OverlayStage, type OverlayScene } from "./overlay-stage";
import { useChat } from "./use-chat";
import { useDesignScale } from "./use-design-scale";

/** What a feed-driven layer gets. The contract for the characters layer (#664). */
export interface OverlayLayerSlotProps {
  /** The page's activity feed, or null in the editor preview. */
  feed: ActivityFeed | null;
  /** The layer's place in the 1920x1080 design space. Its content is laid out in rect.w x rect.h design pixels. */
  rect: LayerRect;
  /** True on a real overlay with a feed; false in a preview. */
  live: boolean;
}

/** The characters layer. Empty until the playground ships (#664). */
export function CharactersSlot(_props: Readonly<OverlayLayerSlotProps>): ReactNode {
  return null;
}

/**
 * Whether the characters layer reads the activity feed. Off until #664: a socket costs provider quota (YouTube is
 * polled only while one is open), and an empty layer has no use for it.
 */
export const CHARACTERS_USE_FEED = false;

/** Whether a page that renders `only` (null: the composition) needs the activity feed for an enabled layer. */
export function usesActivityFeed(layers: OverlayLayers, only: OverlayLayer | null): boolean {
  const chat: boolean = (only === null || only === "chat") && layers.chat.enabled;
  const characters: boolean =
    CHARACTERS_USE_FEED && (only === null || only === "characters") && layers.characters.enabled;
  return chat || characters;
}

function percent(value: number, total: number): string {
  return `${(value / total) * 100}%`;
}

/**
 * A layer box. In the composition it sits at its rect, in % of the 1920x1080 frame. On its own (a per-layer OBS
 * source) it fills the viewport. Either way its content is rect.w x rect.h design pixels, scaled to the box width.
 */
function LayerBox({
  layer,
  rect,
  alone,
  children,
}: Readonly<{
  layer: Exclude<OverlayLayer, "content">;
  rect: LayerRect;
  alone: boolean;
  children: ReactNode;
}>): ReactNode {
  const box = useRef<HTMLDivElement | null>(null);
  useDesignScale(box, rect.w);
  const place: CSSProperties = alone
    ? { left: 0, top: 0, width: "100%", height: "100%" }
    : {
        left: percent(rect.x, DESIGN_W),
        top: percent(rect.y, DESIGN_H),
        width: percent(rect.w, DESIGN_W),
        height: percent(rect.h, DESIGN_H),
      };
  return (
    <div className="ov-layer" data-layer={layer} style={place} ref={box}>
      <div className="ov-layer-canvas" style={{ width: rect.w, height: rect.h }}>
        {children}
      </div>
    </div>
  );
}

function ChatSlot({
  feed,
  settings,
  samples,
  serverOffset,
}: Readonly<{
  feed: ActivityFeed | null;
  settings: ChatLayerSettings;
  samples?: readonly ActivityChat[];
  serverOffset: number;
}>): ReactNode {
  const rows: ChatRow[] = useChat({ feed, samples, hideCommands: settings.hideCommands, serverOffset });
  return <ChatLayer rows={rows} />;
}

/**
 * The overlay: characters at the bottom, then the on-air content, then chat on top. OBS and the editor preview
 * render this same component. `only` renders one layer alone for a per-layer source; null renders them all.
 */
export function OverlayComposition({
  scene,
  source,
  layers,
  only,
  feed,
  samples,
  serverOffset = 0,
}: Readonly<{
  scene: OverlayScene;
  source: OverlaySourceRef;
  layers: OverlayLayers;
  only: OverlayLayer | null;
  feed: ActivityFeed | null;
  samples?: readonly ActivityChat[];
  serverOffset?: number;
}>): ReactNode {
  const shows = (layer: OverlayLayer): boolean => only === null || only === layer;
  const alone: boolean = only !== null;
  const live: boolean = feed !== null && samples === undefined;
  return (
    <div className="ov-composition" data-overlay-only={only ?? undefined}>
      {shows("characters") && layers.characters.enabled && (
        <LayerBox layer="characters" rect={layers.characters.rect} alone={alone}>
          <CharactersSlot feed={feed} rect={layers.characters.rect} live={live} />
        </LayerBox>
      )}
      {shows("content") && <OverlayStage scene={scene} source={source} />}
      {shows("chat") && layers.chat.enabled && (
        <LayerBox layer="chat" rect={layers.chat.rect} alone={alone}>
          <ChatSlot feed={feed} settings={layers.chat} samples={samples} serverOffset={serverOffset} />
        </LayerBox>
      )}
    </div>
  );
}
