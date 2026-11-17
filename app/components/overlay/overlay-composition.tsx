import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { t } from "../../i18n";
import type { ActivityChat } from "../../lib/activity";
import { chatTestLeft } from "../../lib/chat-test";
import type { ChatView } from "../../lib/fading-rows";
import {
  CELL_PX,
  frameSize,
  layerPixels,
  type LayerRect,
  type OverlayLayer,
  type OverlayLayers,
  type Orientation,
} from "../../lib/overlay-layers";
import type { OverlaySourceRef } from "../../types";
import type { ActivityFeed } from "./activity-feed";
import { CharactersLayer } from "./characters/characters-layer";
import { usePlaygroundSource } from "./characters/use-playground";
import { ChatLayer } from "./chat-layer";
import { OverlayStage, type OverlayScene } from "./overlay-stage";
import { useChat } from "./use-chat";
import { useDesignScale } from "./use-design-scale";

/** What a feed-driven layer gets. */
export interface OverlayLayerSlotProps {
  /** The feed with the playground frames, or null for none. */
  feed: ActivityFeed | null;
  /** The layer's cell in design pixels. Its content is laid out in rect.w x rect.h design pixels. */
  rect: LayerRect;
}

/**
 * Whether the characters layer can render (the playground, #664). The one switch for everything that depends on it:
 * while false the layer reads no activity feed (a socket costs provider quota; YouTube is polled only while one is
 * open), its per-layer source opens no live-room socket, its "Show on stream" control stays disabled and its OBS URL
 * is not offered.
 */
export const CHARACTERS_READY: boolean = true;

/** A failed characters layer stays empty on stream; the browser console (the OBS log) gets a fixed event. */
function charactersFailed(error: Error): void {
  console.error("characters_layer_failed", { cause: error.name });
}

/** The characters layer: the playground of the feed's frames. */
export function CharactersSlot({ feed, rect }: Readonly<OverlayLayerSlotProps>): ReactNode {
  const source = usePlaygroundSource(feed);
  return (
    <CharactersLayer
      columns={rect.w / CELL_PX}
      rows={rect.h / CELL_PX}
      source={source}
      badges={{ test: t("overlay.characters.badgeTest"), paused: t("overlay.characters.badgePaused") }}
      onError={charactersFailed}
    />
  );
}

/** Whether a page that renders `only` (null: the composition) shows the characters layer, so its feed needs frames. */
export function usesCharacters(layers: OverlayLayers, only: OverlayLayer | null): boolean {
  return CHARACTERS_READY && (only === null || only === "characters") && layers.characters.enabled;
}

/** Whether a page that renders `only` (null: the composition) needs the activity feed for an enabled layer. */
export function usesActivityFeed(layers: OverlayLayers, only: OverlayLayer | null): boolean {
  const chat: boolean = (only === null || only === "chat") && layers.chat.enabled;
  return chat || usesCharacters(layers, only);
}

/**
 * Whether a composition (all layers, `only` null) lays out in the design canvas of the selected orientation, like
 * the editor preview. It does when it shows a feed layer or the content has a cell: those layers sit at cells, so
 * the content must use the same space. Otherwise the content keeps its responsive layout, so existing OBS scenes do
 * not change.
 */
export function usesDesignCanvas(layers: OverlayLayers, only: OverlayLayer | null): boolean {
  const content: boolean = layers.cells[layers.orientation].content !== null;
  return only === null && (layers.chat.enabled || (CHARACTERS_READY && layers.characters.enabled) || content);
}

/** The class of the layer boxes; their `data-layer` attribute names the layer. */
export const LAYER_CLASS = "ov-layer";
/** The on-air content stage in a composition, when the content has no cell. */
export const CONTENT_SELECTOR = ".ov-composition > .ov-stage";

/** The box of one layer in a composition. */
export function layerSelector(layer: OverlayLayer): string {
  return `.ov-composition > .${LAYER_CLASS}[data-layer="${layer}"]`;
}

/** The style of a scaler for a frame: its design size and the size of 1vw in it. */
export function frameStyle(orientation: Orientation): CSSProperties {
  const { w, h } = frameSize(orientation);
  return { width: w, height: h, "--vw": `${w / 100}px` } as CSSProperties;
}

/**
 * The design canvas for an OBS composition: the same `.ov-scaler` markup as the editor preview, in the frame of the
 * selected orientation, scaled to fit the viewport. At the frame's aspect ratio the scale is viewport width / frame
 * width, as in the preview. At another aspect ratio the whole canvas stays in view and the free space is at the
 * right or bottom.
 *
 * With `on` false the two boxes have no class, so the content keeps its responsive layout. The boxes stay in the
 * page either way: turning the canvas on or off changes classes only, so the content below never remounts (no
 * flash, no replayed animations).
 */
export function DesignCanvas({
  on,
  orientation,
  children,
}: Readonly<{ on: boolean; orientation: Orientation; children: ReactNode }>): ReactNode {
  const frame = useRef<HTMLDivElement | null>(null);
  const { w, h } = frameSize(orientation);
  // Off, the frame is not measured: it may have no height, and the content keeps its own layout.
  useDesignScale(frame, w, h, on);
  return (
    <div className={on ? "ov-design" : undefined} ref={frame}>
      <div className={on ? "ov-scaler" : undefined} style={on ? frameStyle(orientation) : undefined}>
        {children}
      </div>
    </div>
  );
}

function percent(value: number, total: number): string {
  return `${(value / total) * 100}%`;
}

/**
 * A layer box. Its content is rect.w x rect.h design pixels. In the composition the box sits at its cell, in % of
 * the frame, and the content scales to the box width. On its own (a per-layer OBS source) the box fills the
 * viewport and the content scales to fit inside it ("contain"), anchored to the bottom-right corner: the OBS source
 * size may not match the layer's aspect ratio, and chat grows from the bottom (newest row last), so the newest rows
 * stay visible and in place. The free space is left and above.
 */
function LayerBox({
  layer,
  rect,
  frame,
  alone,
  children,
}: Readonly<{
  layer: OverlayLayer;
  rect: LayerRect;
  frame: { w: number; h: number };
  alone: boolean;
  children: ReactNode;
}>): ReactNode {
  const box = useRef<HTMLDivElement | null>(null);
  useDesignScale(box, rect.w, alone ? rect.h : undefined);
  const place: CSSProperties = alone
    ? { left: 0, top: 0, width: "100%", height: "100%" }
    : {
        left: percent(rect.x, frame.w),
        top: percent(rect.y, frame.h),
        width: percent(rect.w, frame.w),
        height: percent(rect.h, frame.h),
      };
  return (
    <div className={LAYER_CLASS} data-layer={layer} data-alone={alone || undefined} style={place} ref={box}>
      <div className="ov-layer-canvas" style={{ width: rect.w, height: rect.h }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Scales the content in a cell down so that it fits inside the cell (`--ov-fit` on `box`, never above 1). It
 * compares the content with its stage; both scale together, so the ratio does not depend on the scale already set.
 * It measures again when the content or the cell changes size and when the content changes.
 */
function useFitScale(box: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const element: HTMLDivElement | null = box.current;
    if (!element) return;
    const measure = (): void => {
      const stage: Element | null = element.firstElementChild;
      const content: Element | null | undefined = stage?.firstElementChild;
      if (!stage || !content) return;
      const outer: DOMRect = stage.getBoundingClientRect();
      const inner: DOMRect = content.getBoundingClientRect();
      const byWidth: number = inner.width > 0 ? outer.width / inner.width : 1;
      const byHeight: number = inner.height > 0 ? outer.height / inner.height : 1;
      element.style.setProperty("--ov-fit", String(Math.min(1, byWidth, byHeight)));
    };
    const sizes = new ResizeObserver(measure);
    const watch = (): void => {
      sizes.disconnect();
      sizes.observe(element);
      const content: Element | null | undefined = element.firstElementChild?.firstElementChild;
      if (content) sizes.observe(content);
      measure();
    };
    const changes = new MutationObserver(watch);
    changes.observe(element, { childList: true, subtree: true, characterData: true });
    watch();
    return (): void => {
      sizes.disconnect();
      changes.disconnect();
    };
  }, [box]);
}

/** The on-air content inside its cell: centred, and scaled down to fit when it is larger than the cell. */
function ContentCell({ scene, source }: Readonly<{ scene: OverlayScene; source: OverlaySourceRef }>): ReactNode {
  const box = useRef<HTMLDivElement | null>(null);
  useFitScale(box);
  return (
    <div className="ov-fit" ref={box}>
      <OverlayStage scene={scene} source={source} fit />
    </div>
  );
}

/**
 * Whether a chat test that ends at `until` (server time) runs now. `serverOffset` is server time minus local time.
 * A local timer ends it at the end time, also without a new server message. Off on the server and during hydration,
 * so the page hydrates without a mismatch.
 */
function useChatTestOn(until: number, serverOffset: number): boolean {
  const left = useCallback((): number => chatTestLeft(until, Date.now() + serverOffset), [until, serverOffset]);
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // A timer can fire a little early: wait again until no time is left.
      const wait = (): void => {
        const ms: number = left();
        if (ms > 0)
          timer = setTimeout((): void => {
            onChange();
            wait();
          }, ms);
      };
      wait();
      return (): void => clearTimeout(timer);
    },
    [left],
  );
  return useSyncExternalStore(
    subscribe,
    (): boolean => left() > 0,
    (): boolean => false,
  );
}

/** Memoised, so a page re-render (like the 1 s server clock tick) does not re-render the chat. */
const ChatSlot = memo(function ChatSlot({
  feed,
  hideCommands,
  samples,
  serverOffset,
  testUntil,
}: Readonly<{
  feed: ActivityFeed | null;
  /** A boolean, not the layer object: a new layers snapshot (a poll update) keeps the memo when the flag is the same. */
  hideCommands: boolean;
  samples?: readonly ActivityChat[];
  serverOffset: number;
  testUntil: number;
}>): ReactNode {
  const test: boolean = useChatTestOn(testUntil, serverOffset);
  const chat: ChatView = useChat({ feed, samples, hideCommands, serverOffset, test });
  // A new list when a test starts or ends: the cards of the other chat go at once and nothing on screen slides in.
  return (
    <>
      <ChatLayer key={test ? "test" : "chat"} chat={chat} />
      {test && (
        <span className="wl-test" data-chat-test>
          {t("overlay.chat.test")}
        </span>
      )}
    </>
  );
});

/**
 * The overlay: characters at the bottom, then the on-air content, then chat on top. OBS and the editor preview
 * render this same component. `only` renders one layer alone for a per-layer source; null renders them all.
 * `testUntil` is the server time when the chat test ends. `charactersFeed` replaces `feed` for the characters: the
 * editor preview plays sample chat but shows the live playground.
 */
export function OverlayComposition({
  scene,
  source,
  layers,
  only,
  feed,
  charactersFeed = feed,
  samples,
  serverOffset = 0,
  testUntil = 0,
}: Readonly<{
  scene: OverlayScene;
  source: OverlaySourceRef;
  layers: OverlayLayers;
  only: OverlayLayer | null;
  feed: ActivityFeed | null;
  charactersFeed?: ActivityFeed | null;
  samples?: readonly ActivityChat[];
  serverOffset?: number;
  testUntil?: number;
}>): ReactNode {
  const shows = (layer: OverlayLayer): boolean => only === null || only === layer;
  const alone: boolean = only !== null;
  const frame = frameSize(layers.orientation);
  const chat: LayerRect | null = layerPixels(layers, "chat");
  const characters: LayerRect | null = layerPixels(layers, "characters");
  const content: LayerRect | null = layerPixels(layers, "content");
  return (
    <div className="ov-composition" data-overlay-only={only ?? undefined}>
      {shows("characters") && layers.characters.enabled && characters && (
        <LayerBox layer="characters" rect={characters} frame={frame} alone={alone}>
          <CharactersSlot feed={charactersFeed} rect={characters} />
        </LayerBox>
      )}
      {shows("content") &&
        (content ? (
          <LayerBox layer="content" rect={content} frame={frame} alone={alone}>
            <ContentCell scene={scene} source={source} />
          </LayerBox>
        ) : (
          <OverlayStage scene={scene} source={source} />
        ))}
      {shows("chat") && layers.chat.enabled && chat && (
        <LayerBox layer="chat" rect={chat} frame={frame} alone={alone}>
          <ChatSlot
            feed={feed}
            hideCommands={layers.chat.hideCommands}
            samples={samples}
            serverOffset={serverOffset}
            testUntil={testUntil}
          />
        </LayerBox>
      )}
    </div>
  );
}
