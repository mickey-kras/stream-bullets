import { useRef, type ReactNode } from "react";
import { t, type MessageId } from "../../i18n";
import { channelHealth, deliversChat, type ChannelHealth, type ChannelView } from "../../lib/channel-health";
import {
  CELL_PX,
  forOutput,
  GRID,
  GRID_LAYERS,
  onStream,
  ORIENTATIONS,
  placedContent,
  type GridLayer,
  type Orientation,
  type OverlayLayers,
  type PlacedContent,
} from "../../lib/overlay-layers";
import { toolsPath } from "../../lib/shell";
import type { OverlayPublic, OverlayState } from "../../types";
import { PLATFORM_NAMES, channelProblem } from "../channels/channel-panel";
import type { OverlaySources } from "../live";
import { useActivityFeed, type ActivityFeed } from "../overlay/activity-feed";
import { ConnectionNote } from "../overlay/connection-note";
import { CHARACTERS_READY, OverlayComposition, frameStyle } from "../overlay/overlay-composition";
import { sourcesText } from "../overlay/overlay-link";
import { overlayPoll, type OverlayScene } from "../overlay/overlay-stage";
import { useDesignScale } from "../overlay/use-design-scale";
import { useOverlayState } from "../overlay/use-overlay-state";
import { PlatformIcon } from "../overlay/wasteland/glyphs";
import { Icon } from "../ui/icon";
import { IconLink } from "../ui/icon-button";
import { LiveActivity } from "./live-activity";
import { LiveChat } from "./live-chat";
import { LiveMessage } from "./live-message";
import { LivePart } from "./live-part";
import { LivePoll } from "./live-poll";
import { LiveTopics } from "./live-topics";

/** The health of a channel in words. A platform that this site does not offer has no line. */
const HEALTH_TEXT: Readonly<Record<Exclude<ChannelHealth, "unavailable">, MessageId>> = {
  healthy: "tools.live.channel.connected",
  attention: "tools.live.channel.attention",
  none: "tools.live.channel.none",
};

/** The channels and OBS in words: what the owner checks before and during a stream. */
function LiveStatus({
  channels,
  sources,
  now,
}: Readonly<{ channels: readonly ChannelView[]; sources: OverlaySources | null; now: number }>): ReactNode {
  return (
    <LivePart name="status" title={t("tools.live.status")}>
      <ul className="tl-status" data-live-channels>
        {channels.map((channel: ChannelView) => {
          const health: ChannelHealth = channelHealth(channel);
          if (health === "unavailable") return null;
          const problem: string | null = channelProblem(channel);
          return (
            <li key={channel.platform} data-live-channel={channel.platform} data-health={health}>
              <PlatformIcon className="tl-chat-icon" platform={channel.platform} label="" />
              <span>
                {t(HEALTH_TEXT[health], { platform: PLATFORM_NAMES[channel.platform] })}
                {problem && <span className="muted"> {problem}</span>}
              </span>
            </li>
          );
        })}
        <li data-live-obs={sources?.count ?? ""}>
          <Icon name="overlay" size={16} />
          <span>{sources ? sourcesText(sources, now) : t("tools.live.obsUnknown")}</span>
        </li>
      </ul>
      <p className="tl-note">
        <a className="text-link" href={toolsPath("channels")}>
          {t("tools.live.openChannels")}
        </a>
      </p>
    </LivePart>
  );
}

/** What OBS shows now: the composition of the selected orientation with the real chat and the real content. */
function LivePreview({
  scene,
  layers,
  feed,
  testUntil,
  serverOffset,
}: Readonly<{
  scene: OverlayScene;
  layers: OverlayLayers;
  feed: ActivityFeed;
  testUntil: number;
  serverOffset: number;
}>): ReactNode {
  const frame = useRef<HTMLElement | null>(null);
  useDesignScale(frame, GRID[layers.orientation].cols * CELL_PX);
  const empty: boolean = !GRID_LAYERS.some((layer: GridLayer): boolean => onStream(layers, layer));
  return (
    <LivePart
      name="preview"
      title={t("tools.live.preview")}
      action={<IconLink label={t("tools.live.editOverlay")} icon="pencil" href={toolsPath("overlay")} />}
    >
      <section
        className="ov-frame ov-comp-frame tl-preview"
        data-orientation={layers.orientation}
        data-background="transparent"
        ref={frame}
        aria-label={t("overlay.comp.preview")}
      >
        <div className="ov-scaler" style={frameStyle(layers.orientation)}>
          <OverlayComposition
            scene={scene}
            layers={layers}
            only={null}
            feed={feed}
            testUntil={testUntil}
            serverOffset={serverOffset}
            cameraHint
          />
        </div>
      </section>
      <p className="muted tl-note" data-live-preview-note>
        {empty ? (
          <>
            {t("tools.live.previewEmpty")}{" "}
            <a className="text-link" href={toolsPath("overlay")}>
              {t("tools.live.openOverlay")}
            </a>
          </>
        ) : (
          t("tools.live.previewNote")
        )}
      </p>
    </LivePart>
  );
}

/**
 * What is on stream, in one line for the full-screen chat: the poll, else the topic, else the message banner. Null
 * when none of them shows.
 */
export function onAirTitle(scene: OverlayScene, layers: OverlayLayers): string | null {
  // The content of the two outputs: each one is on stream.
  const shown: PlacedContent[] = ORIENTATIONS.flatMap((output: Orientation): PlacedContent[] =>
    placedContent(forOutput(layers, output)),
  );
  const poll: PlacedContent | undefined = shown.find((item: PlacedContent): boolean => item.layer === "poll");
  const pollTitle: string | undefined = poll && overlayPoll(poll.source, scene.polls, scene.now)?.title;
  if (pollTitle) return pollTitle;
  const topic: PlacedContent | undefined = shown.find((item: PlacedContent): boolean => item.layer === "topic");
  const topicTitle: string | undefined =
    topic && scene.data.topics.find((item): boolean => item.id === topic.source.ref)?.title;
  if (topicTitle) return topicTitle;
  const message: boolean = shown.some((item: PlacedContent): boolean => item.layer === "message");
  return message && scene.overlay.message !== "" ? scene.overlay.message : null;
}

/**
 * The Live section of Streamer tools: what the owner runs a stream from. The on-air controls save through
 * POST /api/overlay, and the live room sends each change to OBS at once. After a reconnect the page shows the state
 * of the server again. The pause and the filters of the chat stay in this browser.
 */
export function LiveSection({
  initial,
  live,
  scene,
  channels,
  sources = null,
  connected = true,
  reconnect,
  chatFull = false,
  onChatFull,
  serverOffset = 0,
}: Readonly<{
  initial: OverlayState;
  // Latest live overlay state includes changes from other tabs.
  live?: OverlayPublic | null;
  scene: Omit<OverlayScene, "overlay">;
  channels: readonly ChannelView[];
  // Server time minus the time of this device: the chat of the preview counts its times from server times.
  serverOffset?: number;
  // The connected OBS sources, from the live room. Null while the room did not tell.
  sources?: OverlaySources | null;
  // Offline changes save but reach OBS after reconnect.
  connected?: boolean;
  reconnect?: () => void;
  // The full-screen chat. The page keeps it in its address, so a phone can open it from the home screen.
  chatFull?: boolean;
  onChatFull?: (open: boolean) => void;
}>): ReactNode {
  const { state, busy, send, run } = useOverlayState(initial, live);
  const view: OverlayScene = { ...scene, overlay: state };
  // One socket for the chat, the activity and, while the characters layer is on stream, for the playground of the
  // preview.
  const characters: boolean = CHARACTERS_READY && onStream(state.layers, "characters");
  const feed: ActivityFeed = useActivityFeed(scene.handle, null, true, { characters, owner: true });
  return (
    <>
      <ConnectionNote connected={connected} reconnect={reconnect} />
      <div className="tl-live" data-live-section>
        <div className="tl-col">
          <LiveStatus channels={channels} sources={sources} now={scene.now} />
          <LivePreview
            scene={view}
            layers={state.layers}
            feed={feed}
            testUntil={state.chatTestUntil}
            serverOffset={serverOffset}
          />
          <LivePoll scene={view} state={state} busy={busy} run={run} />
          <LiveTopics scene={view} state={state} busy={busy} run={run} />
          <LiveMessage key={`${state.message}:${state.messageStyle}`} state={state} busy={busy} send={send} />
        </div>
        <div className="tl-col tl-col-chat">
          <LiveChat
            feed={feed}
            delivers={deliversChat(channels)}
            hideCommands={state.layers.chat.hideCommands}
            full={chatFull}
            onFull={onChatFull}
            onAir={onAirTitle(view, state.layers)}
          />
          <LiveActivity feed={feed} layers={state.layers} now={scene.now} serverOffset={serverOffset} />
        </div>
      </div>
    </>
  );
}
