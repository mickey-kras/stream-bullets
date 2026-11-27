import { type ReactNode, useCallback, useRef } from "react";
import { TICK_HZ } from "../../lib/playground/constants";
import { CharactersLayer } from "../overlay/characters/characters-layer";
import { pushFrame, sampleView, type TimedView } from "../overlay/characters/interpolate";
import type { PlaygroundView } from "../overlay/characters/view";
import { motionReduced } from "../station/motion";
import { type Demo, type DemoFrame, type DemoRun, demoFrame, runDemo } from "./demos";

const TICK_MS: number = 1000 / TICK_HZ;
/** After a longer stop (a hidden tab), the demo continues from now. It does not run the ticks that it missed. */
const CATCH_UP_MS = 500;
const NO_BADGES = { test: "", paused: "" } as const;

interface Playback {
  run: DemoRun;
  buffer: TimedView[];
  /** The time of the next tick (performance.now()). */
  next: number;
}

/** The picture of `demo` at a time. With reduced motion the demo does not run: it shows its start. */
function useDemoSource(demo: Demo, names: readonly [string, string]): (now: number) => PlaygroundView | null {
  const playback = useRef<Playback | null>(null);
  const [you, other] = names;
  return useCallback(
    (now: number): PlaygroundView | null => {
      if (!playback.current) {
        const run: DemoRun = runDemo(demo, [you, other]);
        playback.current = { run, buffer: [{ at: now, view: run.view() }], next: now };
      }
      const state: Playback = playback.current;
      const reduced: boolean = motionReduced();
      if (reduced || now - state.next > CATCH_UP_MS) state.next = now;
      while (!reduced && state.next <= now) {
        state.run.tick();
        state.buffer = pushFrame(state.buffer, state.run.view(), state.next);
        state.next += TICK_MS;
      }
      return sampleView(state.buffer, now, reduced);
    },
    [demo, you, other],
  );
}

function logFailure(error: Error): void {
  console.error("commands_demo_failed", { cause: error.name });
}

/** A playground that shows one command. It is a picture of the text beside it, so assistive technology skips it. */
export function CommandDemo({ demo, names }: Readonly<{ demo: Demo; names: readonly [string, string] }>): ReactNode {
  const frame: DemoFrame = demoFrame(demo);
  const source = useDemoSource(demo, names);
  return (
    <div className="command-demo" style={{ aspectRatio: `${frame.shown} / ${frame.height}` }}>
      <div
        style={{
          width: `${(frame.width / frame.shown) * 100}%`,
          marginLeft: `${(-frame.left / frame.shown) * 100}%`,
          aspectRatio: `${frame.width} / ${frame.height}`,
        }}
      >
        <CharactersLayer
          columns={frame.cellsW}
          rows={frame.cellsH}
          source={source}
          badges={NO_BADGES}
          onError={logFailure}
        />
      </div>
    </div>
  );
}
