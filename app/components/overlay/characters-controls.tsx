import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { t, tAround, type MessageId, type MessageVars } from "../../i18n";
import { CHARACTERS_TIMEOUT } from "../../lib/overlay-layers";
import {
  type ModeView,
  type PlaygroundControl,
  type PlaygroundStatus,
  playgroundStatusSchema,
  type RosterEntry,
} from "../../lib/playground/protocol";
import { ApiError, errorMessage, postJson } from "../api";
import { Dialog, DialogActions } from "../ui/dialog";
import { useToast } from "../ui/toast";
import type { ActivityFeed } from "./activity-feed";
import { type PlaygroundSummary, usePlaygroundSummary } from "./characters/use-playground";
import { PLATFORM_NAMES } from "./wasteland/theme";

async function control(body: PlaygroundControl): Promise<PlaygroundStatus> {
  return playgroundStatusSchema.parse(await postJson<unknown>("/api/overlay/characters", body));
}

/** The server has no character playground: channels are off, or the deployment has no activity feed (503). */
function serverOff(failure: unknown): boolean {
  return failure instanceof ApiError && failure.status === 503;
}

const NO_ROSTER: readonly RosterEntry[] = [];

/** Reads the status into the setters. The returned function drops an answer that comes after it. */
function readStatus(
  setStatus: (status: PlaygroundStatus) => void,
  setStatusError: (error: string | null) => void,
  setOff: (off: boolean) => void,
): () => void {
  let current = true;
  control({ op: "status" }).then(
    (result: PlaygroundStatus): void => {
      if (!current) return;
      setStatus(result);
      setStatusError(null);
    },
    (error_: unknown): void => {
      if (!current) return;
      if (serverOff(error_)) setOff(true);
      else setStatusError(errorMessage(error_));
    },
  );
  return (): void => {
    current = false;
  };
}

/** The timeout as typed: a whole number of seconds in range, or null. */
function parseTimeout(text: string): number | null {
  if (!/^\d{1,4}$/.test(text.trim())) return null;
  const seconds: number = Number(text.trim());
  return seconds >= CHARACTERS_TIMEOUT.min && seconds <= CHARACTERS_TIMEOUT.max ? seconds : null;
}

/** The inactivity timeout. It saves when the field loses focus or on Enter, and only a valid value. */
function TimeoutField({
  timeout,
  onTimeout,
}: Readonly<{ timeout: number; onTimeout: (seconds: number) => void }>): ReactNode {
  const inputId: string = useId();
  const hintId: string = useId();
  const errorId: string = useId();
  // Null shows the saved value; a string is the owner's unsaved text.
  const [text, setText] = useState<string | null>(null);
  // The error shows after a save attempt (leaving the field or Enter), not while the owner types.
  const [tried, setTried] = useState<boolean>(false);
  const invalid: boolean = tried && text !== null && parseTimeout(text) === null;
  const limits = { min: CHARACTERS_TIMEOUT.min, max: CHARACTERS_TIMEOUT.max };
  const commit = (): void => {
    if (text === null) return;
    const seconds: number | null = parseTimeout(text);
    setTried(seconds === null);
    if (seconds === null) return;
    if (seconds !== timeout) onTimeout(seconds);
    setText(null);
  };
  return (
    <form
      className="ov-chars-timeout"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        commit();
      }}
    >
      <label htmlFor={inputId}>{t("overlay.characters.timeout")}</label>
      <input
        id={inputId}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        size={4}
        value={text ?? String(timeout)}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${errorId} ${hintId}` : hintId}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={commit}
        data-characters-timeout
      />
      <p className="muted ov-comp-note" id={hintId}>
        {t("overlay.characters.timeoutHint", limits)}
      </p>
      {invalid && (
        <p className="ov-chars-invalid" id={errorId} role="alert" data-characters-timeout-error>
          {t("overlay.characters.timeoutInvalid", limits)}
        </p>
      )}
    </form>
  );
}

/**
 * Frames tell a change from another tab, or the end of a test by time or by a layer change. The status follows a
 * change of the frame mode during render, not in an effect. Returns the frame mode.
 */
function useFrameMode(
  summary: PlaygroundSummary | null,
  status: PlaygroundStatus | null,
  setStatus: (status: PlaygroundStatus) => void,
): ModeView | null {
  const frameMode: ModeView | null = summary?.mode ?? null;
  const [seenMode, setSeenMode] = useState<ModeView | null>(frameMode);
  if (frameMode !== seenMode) {
    setSeenMode(frameMode);
    if (frameMode && status)
      setStatus({ paused: frameMode.paused, testEndsAt: frameMode.test ? status.testEndsAt : null });
  }
  return frameMode;
}

/**
 * The time left of a test, from the status. When the frames say a test runs but its end is unknown or past, another
 * tab started or restarted it: it shows as running, without a countdown, and the status is read again.
 */
function testTime(
  status: PlaygroundStatus | null,
  frameMode: ModeView | null,
  now: number,
): { left: number; endUnknown: boolean; running: boolean } {
  const left: number = status?.testEndsAt ? Math.max(0, status.testEndsAt - now) : 0;
  const endUnknown: boolean = (frameMode?.test ?? false) && left === 0;
  return { left, endUnknown, running: left > 0 || endUnknown };
}

/**
 * A removed character leaves the list with its button: focus goes to the next Remove button, the last one when it
 * was the last, or the list title when the list is empty.
 */
function useRemovedFocus(
  roster: readonly RosterEntry[],
  removedRef: RefObject<{ id: number; index: number } | null>,
  list: RefObject<HTMLUListElement | null>,
  listTitle: RefObject<HTMLHeadingElement | null>,
): void {
  useEffect(() => {
    const gone: { id: number; index: number } | null = removedRef.current;
    if (gone === null || roster.some((entry: RosterEntry): boolean => entry.id === gone.id)) return;
    removedRef.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const buttons: HTMLButtonElement[] = Array.from(list.current?.querySelectorAll("button") ?? []);
    (buttons[Math.min(gone.index, buttons.length - 1)] ?? listTitle.current)?.focus();
  }, [roster, removedRef, list, listTitle]);
}

/** What `CharactersControl.send` does after the answer. */
interface SendOptions {
  /** The news after success. */
  done?: MessageId;
  vars?: MessageVars;
  ok?: (result: PlaygroundStatus) => void;
  /** Undoes local marks after a failure. */
  failed?: () => void;
}

/** The state of the character playground and its controls, for the test button and the characters settings. */
export interface CharactersControl {
  /** The owner's characters feed, or null while the characters layer is off stream in the editor. */
  feed: ActivityFeed | null;
  /** The saved characters layer is on stream. */
  enabled: boolean;
  roster: readonly RosterEntry[];
  /** The server has no playground (channels off, or no activity feed in this deployment): a note, not an error. */
  off: boolean;
  statusError: string | null;
  /** A request runs. The controls ignore presses meanwhile. */
  busy: boolean;
  paused: boolean;
  /** The time left of the characters test in milliseconds. 0 with `testRunning`: another tab started the test. */
  testLeft: number;
  testRunning: boolean;
  /** What changed last, for a polite live region. */
  news: string;
  setNews: (news: string) => void;
  /** Sends a control. It shows a failure as a toast. */
  send: (body: PlaygroundControl, options?: SendOptions) => Promise<void>;
}

/**
 * Reads and controls the character playground of the page. `enabled`: the saved characters layer is on stream. With
 * it off the playground keeps nothing, so there is nothing to read. `now` is server time.
 */
export function useCharactersControl(feed: ActivityFeed | null, enabled: boolean, now: number): CharactersControl {
  const toast = useToast();
  const summary: PlaygroundSummary | null = usePlaygroundSummary(feed);
  const [status, setStatus] = useState<PlaygroundStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [off, setOff] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [news, setNews] = useState<string>("");

  // The state after a page load: paused and the test end are not in the saved layers.
  useEffect(() => {
    if (enabled) return readStatus(setStatus, setStatusError, setOff);
  }, [enabled]);

  const frameMode: ModeView | null = useFrameMode(summary, status, setStatus);
  const { left, endUnknown, running } = testTime(status, frameMode, now);
  useEffect(() => {
    if (enabled && endUnknown) return readStatus(setStatus, setStatusError, setOff);
  }, [enabled, endUnknown]);

  async function send(body: PlaygroundControl, options: SendOptions = {}): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const result: PlaygroundStatus = await control(body);
      setStatus(result);
      setStatusError(null);
      if (options.done) setNews(t(options.done, options.vars));
      options.ok?.(result);
    } catch (error_: unknown) {
      if (serverOff(error_)) setOff(true);
      else toast(t("overlay.characters.failed", { error: errorMessage(error_) }), { tone: "error" });
      options.failed?.();
    } finally {
      setBusy(false);
    }
  }

  return {
    feed,
    enabled,
    roster: summary?.roster ?? NO_ROSTER,
    off,
    statusError,
    busy,
    paused: status?.paused ?? false,
    testLeft: left,
    testRunning: running,
    news,
    setNews,
    send,
  };
}

/**
 * The characters settings in the editor: timeout, pause, reset and the participants with a Remove button. Buttons
 * never take the `disabled` attribute: they keep focus while their request runs and ignore presses while busy or
 * unavailable. A polite region says what changed.
 */
export function CharactersControls({
  control: playground,
  timeout,
  onTimeout,
}: Readonly<{
  control: CharactersControl;
  timeout: number;
  onTimeout: (seconds: number) => void;
}>): ReactNode {
  const { feed, enabled, roster, off, statusError, busy, paused, news, setNews, send } = playground;
  const needsId: string = useId();
  const listTitleId: string = useId();
  const removeHintId: string = useId();
  const [confirming, setConfirming] = useState<boolean>(false);
  const listTitle = useRef<HTMLHeadingElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const removedRef = useRef<{ id: number; index: number } | null>(null);
  const [linkBefore, linkAfter] = tAround("overlay.characters.participantsNone", "link");
  // With the saved layer off stream the playground keeps nothing: pause and reset would do nothing.
  const controlUnavailable: boolean = busy || !enabled;
  useRemovedFocus(roster, removedRef, list, listTitle);

  /** Pause or resume. The news says only a change that the answer confirms. */
  function togglePause(): void {
    if (controlUnavailable) return;
    const pausing: boolean = !paused;
    void send(
      { op: pausing ? "pause" : "resume" },
      {
        ok: (result: PlaygroundStatus): void => {
          if (result.paused === pausing)
            setNews(t(pausing ? "overlay.characters.pausedNews" : "overlay.characters.resumedNews"));
        },
      },
    );
  }

  function remove(entry: RosterEntry, index: number): void {
    removedRef.current = { id: entry.id, index };
    void send(
      { op: "remove", id: entry.id },
      {
        done: "overlay.characters.removed",
        vars: { name: entry.name },
        failed: (): void => {
          removedRef.current = null;
        },
      },
    );
  }

  return (
    <div className="ov-chars" data-characters-controls>
      <TimeoutField timeout={timeout} onTimeout={onTimeout} />
      {off && (
        <p className="muted ov-comp-note" data-characters-off>
          {t("overlay.characters.off")}
        </p>
      )}
      {statusError && (
        <p className="ov-chars-invalid" data-characters-status-error>
          {t("overlay.characters.statusFailed", { error: statusError })}
        </p>
      )}
      <div className="ov-chars-row">
        <button
          type="button"
          aria-disabled={controlUnavailable}
          aria-describedby={enabled ? undefined : needsId}
          onClick={togglePause}
          data-characters-pause
        >
          {t(paused ? "overlay.characters.resume" : "overlay.characters.pause")}
        </button>
        <button
          type="button"
          aria-disabled={controlUnavailable}
          aria-describedby={enabled ? undefined : needsId}
          onClick={() => {
            if (!controlUnavailable) setConfirming(true);
          }}
          data-characters-reset
        >
          {t("overlay.characters.reset")}
        </button>
      </div>
      {!enabled && (
        <p className="muted ov-comp-note" id={needsId} data-characters-needs-layer>
          {t("overlay.characters.needsLayer")}
        </p>
      )}
      {paused && (
        <p className="muted ov-comp-note" data-characters-paused>
          {t("overlay.characters.paused", { badge: t("overlay.characters.badgePaused") })}
        </p>
      )}
      <h4 className="ov-chars-title" id={listTitleId} tabIndex={-1} ref={listTitle}>
        {t("overlay.characters.participants")}
      </h4>
      <p className="muted ov-comp-note" id={removeHintId}>
        {t("overlay.characters.removeHint")}
      </p>
      {feed && roster.length > 0 ? (
        <ul
          className="ov-chars-list"
          aria-labelledby={listTitleId}
          aria-describedby={removeHintId}
          ref={list}
          data-characters-list
        >
          {roster.map((entry: RosterEntry, index: number) => (
            <li key={entry.id} data-characters-entry={entry.id}>
              <span className="ov-chars-name">
                <bdi>{entry.name}</bdi> <span className="muted">· {PLATFORM_NAMES[entry.platform]}</span>
              </span>
              <button
                type="button"
                className="small-button"
                aria-disabled={busy}
                aria-label={t("overlay.characters.removeLabel", { name: entry.name })}
                onClick={() => remove(entry, index)}
              >
                {t("overlay.characters.remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted ov-comp-note" data-characters-empty>
          {feed ? (
            <>
              {linkBefore}
              <a className="text-link" href="#channels-title">
                {t("overlay.comp.chatSourceLink")}
              </a>
              {linkAfter}
            </>
          ) : (
            t("overlay.characters.participantsOff")
          )}
        </p>
      )}
      <p className="sr-only" aria-live="polite" data-characters-news>
        {news}
      </p>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("overlay.characters.resetTitle")}
        description={t("overlay.characters.resetBody")}
        actions={
          <DialogActions>
            <button
              type="button"
              className="danger"
              aria-disabled={controlUnavailable}
              onClick={() => {
                if (controlUnavailable) return;
                void send({ op: "reset" }, { done: "overlay.characters.resetDone", ok: () => setConfirming(false) });
              }}
              data-characters-reset-confirm
            >
              {t("overlay.characters.resetConfirm")}
            </button>
          </DialogActions>
        }
      />
    </div>
  );
}
