import { useId, useState, type ReactNode } from "react";
import { intlLocale, t, tn, type MessageId } from "../../i18n";
import { relativeAge } from "../../lib/channel-health";
import { frameSize, ORIENTATIONS, type Orientation, type OverlayLayers } from "../../lib/overlay-layers";
import { errorMessage, postJson } from "../api";
import { outputSources, type OverlaySources, type SourceState } from "../live";
import { Dialog, DialogActions } from "../ui/dialog";
import { Icon, type IconName } from "../ui/icon";
import { useToast } from "../ui/toast";
import { CopyField } from "./copy-field";
import { DockLink } from "./dock-link";
import { StepHeading } from "./step-heading";

const OUTPUT_NAMES: Readonly<Record<Orientation, MessageId>> = {
  horizontal: "overlay.output.horizontal",
  vertical: "overlay.output.vertical",
};

/** The sentence about the OBS sources of the page or of one output at the time `now`. */
export function sourcesText(sources: SourceState, now: number): string {
  if (sources.count > 0) return tn("overlay.sources.connected", sources.count);
  if (sources.seenAt === null) return t("overlay.sources.never");
  const age: string | null = relativeAge(sources.seenAt, now, intlLocale());
  return age === null ? t("overlay.sources.goneNow") : t("overlay.sources.gone", { age });
}

/** The private link of one output, as this page knows it. */
export interface OutputKey {
  /** The output has a link. */
  made: boolean;
  /** The link, after the server gave it to this page. Null: the page did not ask for it yet, or cannot get it. */
  url: string | null;
  /** False after the server said that it has no copy of the key: it cannot give the link again. */
  kept: boolean;
}

/** True when "Show links" can show the link of this output: it makes a missing link, or reads or has the link. */
function showable(key: OutputKey): boolean {
  return !key.made || key.kept || key.url !== null;
}

type OutputKeys = Readonly<Record<Orientation, OutputKey>>;

/** What a request for the link of one output changed. Null: the request failed, and the link stays as it was. */
type KeyChange = Partial<OutputKey> | null;

/** Asks the server about the link of one output. `key` is the link as the page knows it. */
type KeyRequest = (output: Orientation, key: OutputKey) => Promise<KeyChange>;

/** The links at the start: the page knows only which outputs have one. */
function startKeys(hasKey: Readonly<Record<Orientation, boolean>>): OutputKeys {
  return {
    horizontal: { made: hasKey.horizontal, url: null, kept: true },
    vertical: { made: hasKey.vertical, url: null, kept: true },
  };
}

/**
 * Step 2 of the Overlay section: the private links for OBS, one for the horizontal output and one for the vertical
 * output. The two outputs are on stream at the same time, and a streamer can use one link or the two.
 *
 * The two buttons in the title row act on the two outputs together. The first shows the links, and makes the link of
 * an output that has none: a new link replaces nothing. The same button hides the links again. It never takes the
 * `disabled` attribute, so it keeps the focus during its requests, and it ignores a press until they end. The second
 * button makes new links, after a confirmation, because that stops the old links. The server has one request for
 * each output, so a request that fails leaves the link of that output as it was and tells the reason.
 *
 * A hidden link stays in the memory of the page, not in the document. Thus "Show links" asks the server one time
 * for each link: the server counts these requests against a quota of 6 each minute. A deployment that does not keep
 * the keys can also show a link again until the page loads again.
 */
export function OverlayLink({
  hasKey,
  layers,
  sources,
  now,
  busy,
  onTwitchOnly,
  hasDock,
}: Readonly<{
  /** Which outputs have a link. */
  hasKey: Readonly<Record<Orientation, boolean>>;
  /** True when the page has a link for the OBS dock. */
  hasDock: boolean;
  /** The newest saved or live layers, for the Twitch switches. */
  layers: OverlayLayers;
  /** The connected OBS sources. Null while the live room did not tell. */
  sources: OverlaySources | null;
  /** The server time, for the age of the last connection. */
  now: number;
  /** True while a change saves. */
  busy: boolean;
  /** Saves whether one output shows chat and characters from Twitch only. */
  onTwitchOnly: (output: Orientation, on: boolean) => void;
}>): ReactNode {
  const toast = useToast();
  const titleId: string = useId();
  const [keys, setKeys] = useState<OutputKeys>(() => startKeys(hasKey));
  // True while the owner wants to see the links.
  const [visible, setVisible] = useState<boolean>(false);
  const [confirming, setConfirming] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const anyMade: boolean = ORIENTATIONS.some((output: Orientation): boolean => keys[output].made);
  const shown: boolean = visible && ORIENTATIONS.some((output: Orientation): boolean => keys[output].url !== null);
  // False when each output has a link that the server cannot give again: only new links can show then.
  const canShow: boolean = ORIENTATIONS.some((output: Orientation): boolean => showable(keys[output]));

  /** Makes a new link for one output. The old link of that output stops. */
  async function make(output: Orientation): Promise<KeyChange> {
    try {
      const result = await postJson<{ url: string }>("/api/overlay/key", { output });
      return { made: true, url: result.url, kept: true };
    } catch (error: unknown) {
      toast(errorMessage(error), { tone: "error" });
      return null;
    }
  }

  /** Reads the link of one output again. The server answers null when it has no copy of the key. */
  async function read(output: Orientation): Promise<KeyChange> {
    try {
      const result = await postJson<{ url: string | null }>("/api/overlay/key/show", { output });
      return result.url === null ? { kept: false } : { url: result.url };
    } catch (error: unknown) {
      toast(errorMessage(error), { tone: "error" });
      return null;
    }
  }

  /** Runs one request for each output, keeps what changed, and gives the number of requests that worked. */
  async function forEachOutput(request: KeyRequest): Promise<number> {
    setLoading(true);
    const [horizontal, vertical]: [KeyChange, KeyChange] = await Promise.all([
      request("horizontal", keys.horizontal),
      request("vertical", keys.vertical),
    ]);
    setKeys(
      (current: OutputKeys): OutputKeys => ({
        horizontal: { ...current.horizontal, ...horizontal },
        vertical: { ...current.vertical, ...vertical },
      }),
    );
    setLoading(false);
    return [horizontal, vertical].filter((change: KeyChange): boolean => change !== null).length;
  }

  /** Shows the link of each output. An output without a link gets one. */
  async function show(): Promise<void> {
    const done: number = await forEachOutput((output: Orientation, key: OutputKey): Promise<KeyChange> => {
      if (!key.made) return make(output);
      // A link that the page has, or that the server cannot give again, needs no request.
      return key.url === null && key.kept ? read(output) : Promise.resolve({});
    });
    setVisible(true);
    if (!anyMade && done > 0) toast(t("overlay.keyMade"));
  }

  /** The first button: hides the links that show, or shows them. It ignores a press during its requests. */
  function toggleLinks(): void {
    if (loading) return;
    if (shown) setVisible(false);
    else void show();
  }

  /** Makes a new link for each output. The dialog stays open when no request worked, so the owner can try again. */
  async function regenerate(): Promise<void> {
    const done: number = await forEachOutput((output: Orientation): Promise<KeyChange> => make(output));
    if (done === 0) return;
    setVisible(true);
    setConfirming(false);
    toast(t("overlay.keyMade"));
  }

  // The first button: it hides the links that show, shows the links of the page, or makes the first links.
  let toggle: { text: MessageId; icon: IconName } = { text: "overlay.keyCreate", icon: "key" };
  if (shown) toggle = { text: "overlay.keyHide", icon: "eye-off" };
  else if (anyMade) toggle = { text: "overlay.keyShow", icon: "eye" };
  return (
    <section className="ov-step" aria-labelledby={titleId} data-step="obs">
      <div className="ov-step-head">
        <StepHeading step={2} id={titleId} title={t("overlay.step.obs")} />
        <div className="ov-step-tools" data-ov-link-tools>
          {/* One button for show and hide: it keeps the focus when its action changes. */}
          {(shown || canShow) && (
            <button
              type="button"
              className={shown ? undefined : "gold"}
              aria-disabled={loading}
              onClick={toggleLinks}
              data-ov-links={shown ? "shown" : "hidden"}
            >
              <Icon name={toggle.icon} size={18} />
              {t(toggle.text)}
            </button>
          )}
          {anyMade && (
            <button type="button" disabled={loading} onClick={() => setConfirming(true)} data-ov-regenerate>
              <Icon name="refresh" size={18} />
              {t("overlay.keyRegenerate")}
            </button>
          )}
        </div>
      </div>
      <div className="ov-url">
        <p className="muted">{t("overlay.keyNone")}</p>
        <div className="ov-url-outputs">
          {ORIENTATIONS.map((output: Orientation) => (
            <OutputCard
              key={output}
              output={output}
              link={keys[output]}
              visible={visible}
              sources={sources && outputSources(sources, output)}
              now={now}
            />
          ))}
        </div>
        {shown && (
          <p className="muted" data-ov-private>
            {t("overlay.keyPrivate")}
          </p>
        )}
        <ObsGuide />
        <DockLink hasKey={hasDock} />
        <TwitchOnly layers={layers} busy={busy} onChange={onTwitchOnly} />
      </div>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("overlay.keyConfirmTitle")}
        description={t("overlay.keyConfirmBody")}
        actions={
          <DialogActions>
            <button type="button" className="danger" disabled={loading} onClick={() => void regenerate()}>
              {t("overlay.keyRegenerate")}
            </button>
          </DialogActions>
        }
      />
    </section>
  );
}

/**
 * The card of one output: its name, the state of its link in OBS, the link with a copy button while the links show
 * (`visible`), and the size of its browser source. The card is a region with the name of the output.
 */
export function OutputCard({
  output,
  link,
  visible,
  sources,
  now,
}: Readonly<{
  output: Orientation;
  link: OutputKey;
  /** True while the owner wants to see the links. */
  visible: boolean;
  sources: SourceState | null;
  now: number;
}>): ReactNode {
  const nameId: string = useId();
  const name: string = t(OUTPUT_NAMES[output]);
  const url: string | null = visible ? link.url : null;
  return (
    <section className="ov-url-output" aria-labelledby={nameId} data-ov-output={output}>
      <h3 className="ov-url-name" id={nameId}>
        {name}
      </h3>
      {link.made && sources && (
        <p className="ov-obs-status" data-ov-sources={sources.count}>
          <Icon name={sources.count > 0 ? "wifi" : "wifi-off"} size={18} />
          <span>{sourcesText(sources, now)}</span>
        </p>
      )}
      {url !== null && (
        <CopyField value={url} label={`${t("overlay.url")}: ${name}`} copyLabel={`${t("overlay.copyUrl")}: ${name}`} />
      )}
      {!showable(link) && (
        <p className="muted" data-ov-not-kept>
          {t("overlay.keyNotKept")}
        </p>
      )}
      <p className="muted">{t("overlay.obsHelp", frameSize(output))}</p>
    </section>
  );
}

/** One group of the OBS guide: its title and its steps in sequence. */
interface GuideGroup {
  name: "overlay" | "vertical" | "platforms";
  title: MessageId;
  steps: readonly string[];
}

/** The groups of the OBS guide with their texts. docs/obs-setup.md has the same steps. */
function guideGroups(): GuideGroup[] {
  const wide = frameSize("horizontal");
  const tall = frameSize("vertical");
  return [
    {
      name: "overlay",
      title: "overlay.guide.overlay",
      steps: [
        t("overlay.guide.overlay.1"),
        t("overlay.guide.overlay.2"),
        t("overlay.guide.overlay.3", wide),
        t("overlay.guide.overlay.4"),
        t("overlay.guide.overlay.5"),
        t("overlay.guide.overlay.6", { test: t("overlay.test.start") }),
      ],
    },
    {
      name: "vertical",
      title: "overlay.guide.vertical",
      steps: [
        t("overlay.guide.vertical.1"),
        t("overlay.guide.vertical.2"),
        t("overlay.guide.vertical.3", tall),
        t("overlay.guide.vertical.4"),
      ],
    },
    {
      name: "platforms",
      title: "overlay.guide.platforms",
      steps: [
        t("overlay.guide.platforms.1"),
        t("overlay.guide.platforms.2"),
        t("overlay.guide.platforms.3"),
        t("overlay.guide.platforms.4", { channels: t("tools.tab.channels") }),
      ],
    },
  ];
}

/**
 * The closed guide for a streamer who never used OBS: add the overlay, add the vertical output, and choose the
 * platforms of each output. The plugin names are examples. A streamer who knows OBS does not open it.
 */
function ObsGuide(): ReactNode {
  return (
    <details className="ch-details ov-url-guide" data-ov-guide>
      <summary>{t("overlay.guide.title")}</summary>
      {guideGroups().map((group: GuideGroup) => (
        <section key={group.name} data-ov-guide-group={group.name}>
          <p>
            <strong>{t(group.title)}</strong>
          </p>
          <ol>
            {group.steps.map((step: string) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      ))}
    </details>
  );
}

const TWITCH_ONLY: Readonly<Record<Orientation, MessageId>> = {
  horizontal: "overlay.twitch.horizontal",
  vertical: "overlay.twitch.vertical",
};

/**
 * The closed section for a streamer who sends the stream to Twitch and to other platforms: one switch for each
 * output. With the switch on, the output shows chat and characters from Twitch only. The default is the merged chat.
 */
function TwitchOnly({
  layers,
  busy,
  onChange,
}: Readonly<{
  layers: OverlayLayers;
  busy: boolean;
  onChange: (output: Orientation, on: boolean) => void;
}>): ReactNode {
  return (
    <details className="ch-details ov-url-twitch" data-ov-twitch>
      <summary>{t("overlay.twitch.title")}</summary>
      <p className="muted">{t("overlay.twitch.body")}</p>
      {ORIENTATIONS.map((output: Orientation) => (
        <label className="choice" key={output}>
          <input
            type="checkbox"
            checked={layers.twitchOnly[output]}
            disabled={busy}
            onChange={(event) => onChange(output, event.currentTarget.checked)}
            data-ov-twitch-only={output}
          />
          <span>{t(TWITCH_ONLY[output])}</span>
        </label>
      ))}
    </details>
  );
}
