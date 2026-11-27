import { describe, expect, it } from "vitest";
import { DEMOS, demoFrame, runDemo, VIEW_COLS } from "../app/components/commands/demos";
import { TILE } from "../app/lib/playground/constants";
import { COMMANDS, type Command } from "../app/lib/playground/crowd";
import type { CharState } from "../app/lib/playground/protocol";
import { parseCommand } from "../app/lib/playground/sim";

/** The demos of the commands page (app/routes/commands.tsx): each one runs the rules and shows its command. */

/** A state that the character must show in the demo of each command. */
const SHOWS: Readonly<Record<Command, CharState>> = {
  left: "step",
  right: "step",
  look: "turn",
  stop: "step",
  jump: "jump",
  block: "build",
  up: "climb",
  stairs: "build",
  bridge: "build",
  grapple: "zip",
  jetpack: "jet",
  dig: "dig",
  boom: "boom",
  dance: "dance",
  wave: "wave",
  cheer: "cheer",
  push: "push",
  flag: "build",
};

describe("command demos", () => {
  it.each(COMMANDS)("%s runs without a command that cannot run, in the shown part", (command: Command) => {
    const demo = DEMOS[command];
    const frame = demoFrame(demo);
    const run = runDemo(demo, ["you", "friend"]);
    const states = new Set<string>();
    for (let tick = 0; tick < demo.ticks; tick++) {
      run.tick();
      const p = run.you();
      states.add(p.state);
      expect(p.mark, `${command} at tick ${tick}`).toBe(0);
      if (p.state === "gone" || p.state === "away") continue;
      expect(p.x, `${command} at tick ${tick}`).toBeGreaterThan(frame.left);
      expect(p.x, `${command} at tick ${tick}`).toBeLessThan(frame.left + VIEW_COLS * TILE);
    }
    expect(states).toContain(SHOWS[command]);
    expect(demo.lines.some(([, text]) => parseCommand(text)?.name === command)).toBe(true);
    expect(run.view().characters.length).toBeGreaterThan(0);
  });

  it("starts again after its last tick", () => {
    const demo = DEMOS.up;
    const run = runDemo(demo, ["you", "friend"]);
    for (let tick = 0; tick < demo.ticks; tick++) run.tick();
    expect(run.view().blocks).toHaveLength(2);
    run.tick();
    expect(run.view().blocks).toHaveLength(0);
    expect(run.view().characters[0]?.name).toBe("you");
  });

  it("sends the lines of a demo outside the command cooldown", () => {
    for (const command of COMMANDS) {
      const ticks: number[] = DEMOS[command].lines.map(([tick]) => tick);
      for (const [i, tick] of ticks.entries()) if (i > 0) expect(tick - ticks[i - 1]).toBeGreaterThanOrEqual(90);
    }
  });
});
