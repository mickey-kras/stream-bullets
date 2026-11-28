import { useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { t, type MessageId } from "../../i18n";
import { CHAT_TEST_MS, chatTestLeft } from "../../lib/chat-test";
import { CHARACTERS_TEST_MS } from "../../lib/playground/constants";
import type { OverlayState } from "../../types";
import { errorMessage, postJson } from "../api";
import { IconButton } from "../ui/icon-button";
import { useToast } from "../ui/toast";
import { alertsFailure } from "./alerts-settings";
import type { CharactersControl } from "./characters-controls";
import { ControlApiContext, type ControlApi } from "./control-api";

/** The status of a test that runs: the time left, when this tab knows it. */
function runningStatus(left: number): string {
  return left > 0 ? t("overlay.test.left", { seconds: Math.ceil(left / 1000) }) : t("overlay.test.on");
}

/** What a start does, from the saved layers on stream, or why it cannot start. */
function readyStatus(on: Readonly<{ chat: boolean; characters: boolean; paused: boolean; alerts: boolean }>): string {
  if (!on.chat && !on.characters) return t(on.alerts ? "overlay.test.alertOnly" : "overlay.test.needsLayer");
  let status: string = t("overlay.test.hint", {
    seconds: CHAT_TEST_MS / 1000,
    minutes: CHARACTERS_TEST_MS / 60_000,
    badge: t("overlay.characters.badgeTest"),
  });
  if (on.characters && on.paused) status += ` ${t("overlay.characters.testResumes")}`;
  if (on.alerts) status += ` ${t("overlay.test.alertHint")}`;
  return status;
}

/**
 * Start and Stop for the test: one icon button in the toolbar of the studio. It starts the chat test and the
 * characters test together, each when its layer is on stream, and stops the tests that run. A start also sends one
 * test alert while the alerts layer is on stream; an alert has no time to stop, so it does not make the test run. A
 * refused alert shows in a toast and does not stop the other tests. While a test runs, the
 * button shows the stop icon in the pressed colors and has the name of the stop action, and the time left shows
 * beside it. The button has no `aria-pressed`: its name changes with its action, and a pressed "Stop test" would
 * tell a screen reader the opposite.
 *
 * The button never takes the `disabled` attribute: it keeps focus during its own requests and when the test ends.
 * It ignores presses during a request. A press without a layer on stream tells the reason in a toast, because the
 * text that gives the reason is the tooltip and the description of the button, and a touch screen shows neither.
 * A polite region says when the test starts, stops or ends; the time left is not read each second.
 */
export function StudioTest({
  chatUntil,
  now,
  chatOn,
  alertsOn,
  characters,
  onSaved,
}: Readonly<{
  /** Server time when the chat test ends. */
  chatUntil: number;
  /** Server time. */
  now: number;
  /** The saved chat layer is on stream. The server checks the saved layers, not an unsaved draft. */
  chatOn: boolean;
  /** The saved alerts layer is on stream in an output. */
  alertsOn: boolean;
  /** The character playground. Its `enabled` says that the saved characters layer is on stream. */
  characters: CharactersControl;
  onSaved: (overlay: OverlayState) => void;
}>): ReactNode {
  const toast = useToast();
  const api: ControlApi = useContext(ControlApiContext);
  const hintId: string = useId();
  const [sending, setSending] = useState<boolean>(false);
  const chatLeft: number = chatTestLeft(chatUntil, now);
  const chatRunning: boolean = chatLeft > 0;
  const running: boolean = chatRunning || characters.testRunning;
  const left: number = Math.max(chatLeft, characters.testLeft);
  const available: boolean = chatOn || characters.enabled || alertsOn;
  const unavailable: boolean = sending || characters.busy || (!running && !available);
  // Empty on page load; set when `running` changes, so the region speaks only for a start or a stop.
  const [news, setNews] = useState<string>("");
  const wasRunning = useRef<boolean>(running);
  // True from this editor's Stop press until a request fails: the end is then "stopped", not "ended" by the timer,
  // a layer change or another tab. The live room can bring the stop before the response.
  const stoppedHere = useRef<boolean>(false);
  // True when this editor's Start also ends a pause of the playground.
  const resumedHere = useRef<boolean>(false);
  useEffect(() => {
    if (wasRunning.current === running) return;
    wasRunning.current = running;
    let text: MessageId = "overlay.test.ended";
    if (running) text = resumedHere.current ? "overlay.test.startedResumed" : "overlay.test.started";
    else if (stoppedHere.current) text = "overlay.test.stopped";
    stoppedHere.current = false;
    resumedHere.current = false;
    setNews(t(text));
  }, [running]);

  const failed = (): void => {
    stoppedHere.current = false;
    resumedHere.current = false;
  };
  async function sendChat(on: boolean): Promise<void> {
    try {
      const result = await postJson<{ overlay: OverlayState }>("/api/overlay", { action: "chatTest", on });
      onSaved(result.overlay);
    } catch (error_: unknown) {
      failed();
      toast(t("overlay.test.failed", { error: errorMessage(error_) }), { tone: "error" });
    }
  }
  /** One test alert. Only the alert starts: the news tells it, because the test does not run. */
  async function sendAlert(alone: boolean): Promise<void> {
    try {
      await api.alerts({ op: "test" });
      if (alone) setNews(t("overlay.alerts.testSent"));
    } catch (error_: unknown) {
      toast(t("overlay.alerts.testFailed", { error: alertsFailure(error_) }), { tone: "error" });
    }
  }
  /** The requests that stop the tests that run. */
  function stopRequests(): Promise<void>[] {
    stoppedHere.current = true;
    const requests: Promise<void>[] = [];
    if (chatRunning) requests.push(sendChat(false));
    if (characters.testRunning) requests.push(characters.send({ op: "stopTest" }, { failed }));
    return requests;
  }
  /** The requests that start the test of each layer on stream. */
  function startRequests(): Promise<void>[] {
    resumedHere.current = characters.enabled && characters.paused;
    const requests: Promise<void>[] = [];
    if (chatOn) requests.push(sendChat(true));
    if (characters.enabled) requests.push(characters.send({ op: "test" }, { failed }));
    if (alertsOn) requests.push(sendAlert(!chatOn && !characters.enabled));
    return requests;
  }
  /** Stops the tests that run, or starts the test of each layer on stream. */
  async function press(): Promise<void> {
    if (sending || characters.busy) return;
    if (!running && !available) {
      toast(t("overlay.test.needsLayer"));
      return;
    }
    setSending(true);
    await Promise.all(running ? stopRequests() : startRequests());
    setSending(false);
  }

  const status: string = running
    ? runningStatus(left)
    : readyStatus({ chat: chatOn, characters: characters.enabled, paused: characters.paused, alerts: alertsOn });
  const label: string = t(running ? "overlay.test.stop" : "overlay.test.start");
  return (
    <div className="ov-comp-test" data-test-control>
      <IconButton
        label={label}
        // The tooltip of a test that does not run also tells what the test does, or why it cannot start.
        title={running ? label : `${label}\n${status}`}
        icon={running ? "stop" : "play"}
        aria-disabled={unavailable}
        aria-describedby={hintId}
        onClick={() => void press()}
        data-test-toggle
        data-running={running || undefined}
      />
      {/* The time left shows while a test runs. Otherwise the text is the description of the button only. */}
      <p className={running ? "muted ov-comp-note" : "sr-only"} id={hintId} data-test-status>
        {status}
      </p>
      <p className="sr-only" aria-live="polite" data-test-news>
        {news}
      </p>
    </div>
  );
}
