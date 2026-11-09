import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useMatches, useRevalidator } from "react-router";
import { t, tn } from "../../i18n";
import { MASH_BATCH_MS, MASH_DRAW, MASH_NAME, mashWinner } from "../../lib/mash";
import { useShell } from "../../lib/shell";
import { usePrefs } from "../../lib/use-prefs";
import type { Entry } from "../../types";
import { announce } from "../a11y/announcer";
import { errorMessage, postJson } from "../api";
import { DialogLink } from "../shell/dialog-link";
import { SignInButton } from "../shell/sign-in-dialog";
import { useToast } from "../ui/toast";
import { Dialog, DialogActions } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { formatCount, MashBars, MashRing, MashWinner, sideStyle } from "./mash-parts";
import { useMashTapper, useMashView, type MashAssist, type MashView } from "./use-mash";

type Action = (body: unknown) => void;

/** The score read out to screen readers: your side first, then the others, then the time left. */
export function scoreText(sides: readonly string[], totals: readonly number[], mine: number | null, left: number) {
  const order: number[] = sides.map((_side: string, index: number) => index);
  if (mine !== null) order.sort((a: number, b: number) => Number(b === mine) - Number(a === mine));
  const parts: string[] = order.map((index: number): string => {
    const side: string = index === mine ? `${sides[index]} ${t("mash.yourSide")}` : sides[index];
    return `${side} ${formatCount(totals[index] ?? 0)}`;
  });
  return `${parts.join(", ")}. ${t("mash.secondsLeft", { n: left })}.`;
}

/** One empty list, so the announcement effect does not run again on each render before a battle loads. */
const NO_TOTALS: readonly number[] = [];

/**
 * Timed screen-reader updates while a battle runs (item 39): "Go" at the start, the score every 2, 5 or 10 seconds
 * (the viewer's choice, or never), 10 and 5 seconds left, and the result. Messages go through the shared live
 * regions, so they survive the card re-rendering 5 times a second.
 */
function useMashAnnouncements(entry: Entry, view: MashView | null, side: number | null): void {
  const { srInterval } = usePrefs();
  const phase = useRef<string | null>(null);
  const lastScore = useRef<number>(0);
  const spokenLeft = useRef<number>(0);
  const current: string | null = view?.current ?? null;
  const left: number = view?.left ?? 0;
  const totals: readonly number[] = view?.totals ?? NO_TOTALS;
  const winner: number | null = view ? (view.winner ?? mashWinner(view.totals)) : null;
  useEffect(() => {
    const before: string | null = phase.current;
    phase.current = current;
    if (before === null || current === null) return;
    if (current === "live" && before !== "live") {
      lastScore.current = Date.now();
      announce(side === null ? t("mash.sayStarted") : t("mash.sayGo", { side: entry.options[side] }), {
        assertive: true,
      });
      return;
    }
    if (current === "finished" && before !== "finished") {
      announce(
        winner === MASH_DRAW || winner === null
          ? t("mash.sayDraw")
          : t("mash.sayWinner", { side: entry.options[winner], n: formatCount(totals[winner] ?? 0) }),
        { assertive: true },
      );
      return;
    }
    if (current !== "live") return;
    if ((left === 10 || left === 5) && spokenLeft.current !== left) {
      spokenLeft.current = left;
      announce(t("mash.sayLeft", { n: left }), { key: "mash-time" });
      return;
    }
    if (srInterval === "off" || Date.now() - lastScore.current < Number(srInterval) * 1_000) return;
    lastScore.current = Date.now();
    announce(scoreText(entry.options, totals, side, left), { key: "mash-score" });
  }, [current, left, srInterval, entry.options, side, totals, winner]);
}

/** The host's first name from the streamer page loader, or "the host" elsewhere. */
function useLoaderHost(): string {
  for (const match of useMatches()) {
    const data = match.loaderData as { board?: { streamer?: { name?: string } } } | undefined;
    const name = data?.board?.streamer?.name;
    if (name) return name.split(" ")[0];
  }
  return t("mash.theHost");
}

function phaseClass(view: MashView): string {
  return view.current === "setup" ? "waiting" : view.current;
}

function Headline({ view, title, titleId }: Readonly<{ view: MashView; title: string; titleId: string }>): ReactNode {
  let status: ReactNode = t("mash.battleLength", { n: view.durationS });
  if (view.current === "live")
    status = (
      <>
        <Icon name="timer" size={16} />
        {t("mash.secondsLeft", { n: view.left })}
      </>
    );
  if (view.current === "countdown") status = t("mash.getReady");
  if (view.current === "finished") status = t("mash.final");
  return (
    <>
      <div className="poll-topline">
        <span className="poll-badge">
          <Icon name="zap" size={16} />
          <span>{MASH_NAME}</span>
        </span>
        <span className="poll-countdown">{status}</span>
      </div>
      <h2 id={titleId}>{title}</h2>
    </>
  );
}

/** The host bar: live stats and Start, End early or Restart. The host does not play. */
function HostBar({ entry, view, onAction }: Readonly<{ entry: Entry; view: MashView; onAction: Action }>): ReactNode {
  const revalidator = useRevalidator();
  const toast = useToast();
  const [busy, setBusy] = useState<boolean>(false);
  const [confirm, setConfirm] = useState<"end" | "delete" | null>(null);
  async function run(action: "start" | "end" | "restart", body: object = {}): Promise<void> {
    setBusy(true);
    try {
      await postJson(`/api/mash/${entry.id}/${action}`, body);
      await revalidator.revalidate();
    } catch (error: unknown) {
      toast(errorMessage(error), { tone: "error" });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }
  let buttons: ReactNode = (
    <button type="button" className="danger" disabled={busy} onClick={() => setConfirm("end")}>
      <Icon name="stop" size={18} />
      {t("mash.endEarly")}
    </button>
  );
  if (view.current === "setup")
    buttons = (
      <>
        <button type="button" className="gold" disabled={busy} onClick={() => void run("start", { countdown: true })}>
          <Icon name="timer" size={18} />
          {t("mash.startCountdown")}
        </button>
        <button type="button" disabled={busy} onClick={() => void run("start", { countdown: false })}>
          {t("mash.startNow")}
        </button>
      </>
    );
  if (view.current === "finished")
    buttons = (
      <>
        <button type="button" className="gold" disabled={busy} onClick={() => void run("restart")}>
          <Icon name="reset" size={18} />
          {t("mash.restart")}
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => setConfirm("delete")}>
          <Icon name="trash" size={18} />
          {t("mash.delete")}
        </button>
      </>
    );
  return (
    <div className="mash-owner host-bar">
      <span className="eyebrow">{t("mash.hostControls")}</span>
      <p className="mash-stats">
        <span>
          <Icon name="community" size={16} />
          <strong data-mash-participants>{formatCount(view.players)}</strong> {tn("mash.participants", view.players)}
        </span>
        <span>
          <Icon name="zap" size={16} />
          <strong data-mash-tps>{formatCount(view.tps)}</strong> {t("mash.tapsPerSecond")}
        </span>
        <span>
          <Icon name="eye" size={16} />
          <strong>{formatCount(view.assisted)}</strong> {t("mash.assistedPlayers")}
        </span>
      </p>
      <div className="sched-actions">{buttons}</div>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setConfirm(null);
        }}
        title={t(confirm === "delete" ? "mash.deleteTitle" : "mash.endTitle", { title: entry.title })}
        description={t(confirm === "delete" ? "mash.deleteBody" : "mash.endBody")}
        actions={
          <DialogActions cancelLabel={confirm === "delete" ? undefined : t("mash.keepGoing")}>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                if (confirm === "delete") {
                  setConfirm(null);
                  onAction({ action: "delete", id: entry.id });
                } else void run("end");
              }}
            >
              {confirm === "delete" ? t("mash.delete") : t("mash.endEarly")}
            </button>
          </DialogActions>
        }
      />
    </div>
  );
}

/** Before the start: viewers pick a side (their vote) and can change it until the host starts. */
function SetupBody({
  entry,
  host,
  owner,
  signedIn,
  pending,
  onAction,
}: Readonly<{ entry: Entry; host: string; owner: boolean; signedIn: boolean; pending: boolean; onAction: Action }>) {
  const [changing, setChanging] = useState<boolean>(false);
  const { shortcuts } = usePrefs();
  const chosen: boolean = signedIn && entry.myVote !== null && !changing;
  function pick(side: number): void {
    setChanging(false);
    onAction({ action: "vote", id: entry.id, choice: side });
  }
  useEffect(() => {
    if (!signedIn || owner || !shortcuts) return;
    const keys = (event: globalThis.KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (target?.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      const side: number = Number(event.key) - 1;
      if (Number.isInteger(side) && side >= 0 && side < entry.options.length) pick(side);
    };
    document.addEventListener("keydown", keys);
    return (): void => document.removeEventListener("keydown", keys);
  });
  if (owner)
    return (
      <>
        <p className="mash-status">
          <Icon name="timer" size={18} />
          {t("mash.startsWhenYou")}
        </p>
        <ul className="mash-sides-readonly" aria-label={t("mash.sides")}>
          {entry.options.map((side: string, index: number) => (
            <li key={`${index}:${side}`} style={sideStyle(index)}>
              <span className={`mash-swatch pat-${index}`} aria-hidden="true" />
              <span>{side}</span>
            </li>
          ))}
        </ul>
      </>
    );
  return (
    <>
      <p className="mash-status">
        <Icon name="timer" size={18} />
        {t("mash.startsWhen", { host })}
      </p>
      <p className="muted mash-pick-help" hidden={chosen}>
        {signedIn && t("mash.pickHelp")}
        {signedIn && shortcuts && <span className="kbd-hint"> {t("mash.pickKeys", { n: entry.options.length })}</span>}
      </p>
      <p className="mash-chosen" aria-live="polite" hidden={!chosen}>
        <Icon name="check" size={18} />
        <span>{chosen && t("mash.chosen", { side: entry.options[entry.myVote ?? 0], host })}</span>{" "}
        <button type="button" className="text-button" onClick={() => setChanging(true)}>
          {t("mash.changeSide")}
        </button>
      </p>
      <fieldset className={chosen ? "mash-picks has-choice" : "mash-picks"}>
        <legend className="sr-only">{t("mash.pickSide")}</legend>
        {entry.options.map((side: string, index: number) => (
          <button
            key={`${index}:${side}`}
            type="button"
            className="mash-pick"
            style={sideStyle(index)}
            aria-pressed={entry.myVote === index}
            disabled={!signedIn || pending}
            onClick={() => pick(index)}
          >
            <kbd aria-hidden="true">{index + 1}</kbd>
            <span className={`mash-swatch pat-${index}`} aria-hidden="true" />
            <span>{side}</span>
            <span className="mash-pick-mine" aria-hidden={entry.myVote !== index}>
              {entry.myVote === index && (
                <>
                  <Icon name="check" size={18} />
                  <span>{t("mash.yourSide")}</span>
                </>
              )}
            </span>
          </button>
        ))}
      </fieldset>
    </>
  );
}

/** The big tap target. Space and Enter tap once per press (key repeat is ignored); S reads the score. */
function TapButton({
  entry,
  view,
  side,
  assist,
  helpId,
}: Readonly<{ entry: Entry; view: MashView; side: number; assist: MashAssist; helpId: string }>): ReactNode {
  const assisted: boolean = assist !== "off";
  const tapper = useMashTapper(
    entry.id,
    view.current === "live",
    assisted,
    view.current === "live" && view.msLeft <= MASH_BATCH_MS,
  );
  const button = useRef<HTMLButtonElement | null>(null);
  // A Space or Enter press already tapped; the click the browser may send for it must not tap again.
  const keyTapped = useRef<boolean>(false);
  const { shortcuts } = usePrefs();
  const mine: number = Math.max(tapper.taps, view.mine ?? 0);
  function hit(): void {
    if (assisted || !tapper.tap() || !button.current) return;
    // Restart the press animation and float a decorative "+1" (both hidden with reduced motion).
    const target: HTMLButtonElement = button.current;
    target.classList.remove("punch");
    target.getBoundingClientRect();
    target.classList.add("punch");
    const plus: HTMLSpanElement = document.createElement("span");
    plus.className = "mash-plus";
    plus.textContent = "+1";
    plus.setAttribute("aria-hidden", "true");
    const random: number = crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000;
    plus.style.left = `${20 + random * 60}%`;
    target.appendChild(plus);
    setTimeout(() => plus.remove(), 600);
  }
  function readScore(): void {
    announce(scoreText(entry.options, view.totals, side, view.left), { key: "mash-score" });
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (shortcuts && (event.key === "s" || event.key === "S")) {
      readScore();
      return;
    }
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat) return;
    if (assist === "hold") tapper.setHolding(true);
    else if (assist === "toggle") tapper.setHolding(!tapper.holding);
    else {
      keyTapped.current = true;
      hit();
    }
  }
  /**
   * Screen readers and switch access often send only a click. A pointer click (`detail` 1 or more) was counted on
   * pointer down and a key press on key down, so only a click with neither before it taps.
   */
  function click(event: MouseEvent<HTMLButtonElement>): void {
    if (assist === "toggle") {
      tapper.setHolding(!tapper.holding);
      return;
    }
    if (event.detail > 0) return;
    if (keyTapped.current) keyTapped.current = false;
    else hit();
  }
  let label: string = t("mash.tap");
  if (assist === "hold") label = t("mash.holdToTap");
  if (assist === "toggle") label = tapper.holding ? t("mash.tapToStop") : t("mash.tapToStart");
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`mash-button pat-${side}`}
        style={sideStyle(side)}
        aria-describedby={helpId}
        aria-pressed={assist === "toggle" ? tapper.holding : undefined}
        onClick={click}
        onPointerDown={() => {
          if (assist === "hold") tapper.setHolding(true);
          else hit();
        }}
        onPointerUp={() => {
          if (assist === "hold") tapper.setHolding(false);
        }}
        onPointerLeave={() => {
          if (assist === "hold") tapper.setHolding(false);
        }}
        onBlur={() => {
          // Tab while holding moves focus on before the key-up, which then never reaches this button.
          if (assist === "hold") tapper.setHolding(false);
        }}
        onKeyDown={keyDown}
        onKeyUp={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key !== " " && event.key !== "Enter") return;
          if (assist === "hold") tapper.setHolding(false);
          // A browser that sends no click for the press leaves the mark; drop it after the click would have come.
          setTimeout(() => {
            keyTapped.current = false;
          }, 0);
        }}
      >
        <span className="mash-button-label">{label}</span>{" "}
        <span className="mash-button-side">{t("mash.forSide", { side: entry.options[side] })}</span>
      </button>
      {assisted && (
        <p className="mash-assist-note">
          <Icon name="about" size={16} />
          {t(assist === "hold" ? "mash.assistHold" : "mash.assistToggle")}
        </p>
      )}
      <p className="kbd-hint mash-kbd">{t("mash.keyboard")}</p>
      <p className="mash-mine">
        {t("mash.yourTaps")} <strong data-mash-mine>{formatCount(mine)}</strong>
      </p>
      <div className="mash-tools">
        <button type="button" className="small-button" onClick={readScore}>
          <Icon name="eye" size={16} />
          {t("mash.readScore")}
          {shortcuts && <kbd aria-hidden="true">S</kbd>}
        </button>
        <DialogLink name="a11y" className="text-link">
          {t("mash.assistLink")}
        </DialogLink>
      </div>
      {view.denied === "pick" && <p className="form-error">{t("mash.noSide")}</p>}
    </>
  );
}

/**
 * One Mash Battle (item 31): pick a side, 3-2-1, tap for the time limit, winner. Totals arrive 5 times
 * a second over the live connection. The host sees stats and controls instead of a side.
 */
export function MashCard({
  entry,
  now,
  signedIn,
  owner,
  pending,
  onAction,
}: Readonly<{
  entry: Entry;
  now: number;
  signedIn: boolean;
  owner: boolean;
  pending: boolean;
  onAction: Action;
}>): ReactNode {
  const view = useMashView(entry, now);
  const shell = useShell();
  const prefs = usePrefs();
  const host: string = useLoaderHost();
  const titleId: string = useId();
  const helpId: string = useId();
  const assist: MashAssist = prefs.mashAssist;
  const side: number | null = signedIn && !owner ? entry.myVote : null;
  useMashAnnouncements(entry, view, side);
  if (!view) return null;
  const countdown: number = Math.max(1, Math.ceil(((view.startsAt ?? now) - now) / 1_000));
  let body: ReactNode = null;
  if (view.current === "setup")
    body = (
      <SetupBody entry={entry} host={host} owner={owner} signedIn={signedIn} pending={pending} onAction={onAction} />
    );
  if (view.current === "countdown")
    body = (
      <>
        <div className="mash-countdown" aria-hidden="true">
          <span key={countdown} data-mash-count>
            {countdown}
          </span>
        </div>
        <p className="mash-status center" aria-live="assertive">
          {side === null ? (
            t("mash.startingSoon")
          ) : (
            <>
              {t("mash.getReadyFor")}{" "}
              <strong style={{ ...sideStyle(side), color: "var(--c)" }}>{entry.options[side]}</strong>
            </>
          )}
        </p>
      </>
    );
  if (view.current === "live")
    body = (
      <>
        <div className="mash-live">
          <MashRing left={view.left} duration={view.durationS} />
          <MashBars sides={entry.options} totals={view.totals} mySide={side} />
        </div>
        {side !== null && <TapButton entry={entry} view={view} side={side} assist={assist} helpId={helpId} />}
        {signedIn && !owner && side === null && <p className="muted mash-status center">{t("mash.noSide")}</p>}
      </>
    );
  if (view.current === "finished")
    body = (
      <>
        <MashWinner sides={entry.options} winner={view.winner ?? mashWinner(view.totals)} />
        <MashBars sides={entry.options} totals={view.totals} mySide={side} />
        {side !== null && view.mine !== null && (
          <p className="mash-mine">{t("mash.youTapped", { n: formatCount(view.mine), side: entry.options[side] })}</p>
        )}
      </>
    );
  return (
    <article
      className={`poll-card mash-card phase-${phaseClass(view)}${owner ? " is-host" : ""}`}
      aria-labelledby={titleId}
    >
      {owner && <HostBar entry={entry} view={view} onAction={onAction} />}
      <Headline view={view} title={entry.title} titleId={titleId} />
      {body}
      {!signedIn && (
        <div className="mash-signin">
          <p>
            <Icon name="lock" size={18} />
            {t("mash.signInToJoin")}
          </p>
          <SignInButton providers={shell.providers} className="gold" />
        </div>
      )}
      <p className="muted mash-fair" id={helpId}>
        {t("mash.fair")}
      </p>
    </article>
  );
}
